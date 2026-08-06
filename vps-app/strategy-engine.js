/**
 * Strategy Engine v6 — Strategy files on disk, params on dashboard
 *
 * - Strategy code lives in /strategies/*.js (NOT on dashboard)
 * - Dashboard shows: strategy picker (dropdown) + param fields
 * - Only ONE strategy runs at a time
 * - Each strategy exports: { name, params, run, needsHtf }
 */

const WebSocket = require("ws");
const protobuf = require("protobufjs");
const path = require("path");
const { randomUUID } = require("crypto");
const fs = require("fs");

// ==================== HELPERS ====================
function sma(v, p) { if (v.length < p) return null; return v.slice(-p).reduce((a, b) => a + b, 0) / p; }
function emaArray(v, p) { if (v.length < p) return []; const k = 2 / (p + 1); const r = []; let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p; r.push(prev); for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); r.push(prev); } return r; }
function emaVal(v, p) { const a = emaArray(v, p); return a.length > 0 ? a[a.length - 1] : null; }
function rsi(v, p = 14) { if (v.length < p + 1) return null; let g = 0, l = 0; for (let i = v.length - p; i < v.length; i++) { const c = v[i] - v[i - 1]; if (c >= 0) g += c; else l -= c; } if (l === 0) return 100; return 100 - 100 / (1 + (g / p) / (l / p)); }
function highest(v, p) { return !v || !v.length ? null : Math.max(...v.slice(-p)); }
function lowest(v, p) { return !v || !v.length ? null : Math.min(...v.slice(-p)); }
function crossover(a, b) { return a && a.length >= 2 && b && b.length >= 2 && a[a.length - 2] <= b[b.length - 2] && a[a.length - 1] > b[b.length - 1]; }
function crossunder(a, b) { return a && a.length >= 2 && b && b.length >= 2 && a[a.length - 2] >= b[b.length - 2] && a[a.length - 1] < b[b.length - 1]; }

const HELPERS = { sma, emaArray, ema: emaVal, rsi, highest, lowest, crossover, crossunder };

// ==================== CANDLE FETCH ====================
function parseInterval(s) { const m = s.match(/^(\d+)([mhDwM])$/); if (!m) return { unit: "minutes", interval: "1" }; const u = { m: "minutes", h: "hours", D: "days", w: "weeks", M: "months" }; return { unit: u[m[2]] || "minutes", interval: m[1] }; }
function getTodayDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function intervalToMinutes(s) { const m = s.match(/^(\d+)([mhDwM])$/); if (!m) return 1; const v = parseInt(m[1], 10); if (m[2] === "m") return v; if (m[2] === "h") return v * 60; if (m[2] === "D") return 375; return v; }

async function fetchCandles(fetchFn, token, key, intervalStr) {
  const { unit, interval } = parseInterval(intervalStr);
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${getTodayDate()}`;
  const resp = await fetchFn(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!resp.ok) { console.log(`[STRATEGY] Candle fetch fail: HTTP ${resp.status}`); return null; }
  const data = await resp.json();
  const candles = (data.data && data.data.candles) || [];
  return candles.map(c => ({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0 })).reverse();
}

// ==================== LOAD STRATEGIES FROM DISK ====================
function loadStrategies() {
  const dir = path.join(__dirname, "strategies");
  const strategies = {};
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    for (const f of files) {
      const key = f.replace(".js", "");
      const mod = require(path.join(dir, f));
      if (mod && mod.name && mod.params && mod.run) {
        strategies[key] = mod;
        console.log(`[STRATEGY] Loaded strategy: ${mod.name} (${key})`);
      }
    }
  } catch (e) { console.log("[STRATEGY] Strategy load error:", e.message); }
  return strategies;
}

// ==================== ENGINE ====================
class StrategyEngine {
  constructor() {
    this.running = false;
    this.ws = null;
    this.protobufRoot = null;
    this.wsConnected = false;
    this.wsReconnectTimer = null;
    this.lastTickTime = 0;
    this.htfTimer = null;
    this.strategies = loadStrategies();

    // Single active strategy state
    this.activeKey = null;      // e.g. "trone" or "tradetron-tsl"
    this.state = {};
    this.entryCandles = [];
    this.currentCandle = null;
    this.htfCandles = [];
    this.lastHtfFetch = 0;
    this.lastLTP = 0;
    this.lastSignal = null;
    this.lastSignalTime = 0;
    this.signalHistory = [];
    this.lastEvalTime = 0;
    this.lastStateJson = "{}";
    this.positionOpen = false;
    this.positionType = null;
    this.positionToken = null;
    this.positionQty = null;
    this.positionProduct = null;
    this.signalLock = false;
    this.configCache = null;
    this.configCacheTime = 0;
  }

  init(app, deps) {
    this.db = deps.db;
    this.getSetting = deps.getSetting;
    this.setSetting = deps.setSetting;
    this.getToken = deps.getToken;
    this.placeUpstoxOrder = deps.placeUpstoxOrder;
    this.getLTP = deps.getLTP;
    this.calculateATM = deps.calculateATM;
    this.isMarketOpen = deps.isMarketOpen;
    this.logOrder = deps.logOrder;
    this.logSignal = deps.logSignal;
    this.addLog = deps.addLog;
    this.fetchIPv4 = deps.fetchIPv4;
    this.getTradingConfig = deps.getTradingConfig;

    this.loadState();
    this.restorePositionFromDB();
    this.registerRoutes(app);
    this.initProtobuf();

    const config = this.getConfig();
    if (config.enabled && config.strategy) {
      this.activeKey = config.strategy;
      this.start();
    }
    console.log("[STRATEGY] Strategy engine v6 loaded (file-based, params on dashboard)");
  }

  initProtobuf() {
    protobuf.load(path.join(__dirname, "MarketDataFeedV3.proto"), (err, root) => {
      if (err) { console.log("[STRATEGY] Proto load error:", err.message); return; }
      this.protobufRoot = root;
      console.log("[STRATEGY] Protobuf initialized");
    });
  }

  decodeFeed(buffer) {
    if (!this.protobufRoot) return null;
    try {
      const FR = this.protobufRoot.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
      return FR.toObject(FR.decode(buffer), { longs: Number, enums: String, defaults: true });
    } catch { return null; }
  }

  // ==================== STATE ====================
  loadState() { try { const r = this.getSetting("strategy_state", ""); this.state = r ? JSON.parse(r) : {}; } catch { this.state = {}; } }
  saveState() { try { this.setSetting("strategy_state", JSON.stringify(this.state)); } catch (e) { console.log(`[STRATEGY] State save error: ${e.message}`); } }

  restorePositionFromDB() {
    try {
      const pos = this.db.prepare("SELECT * FROM positions WHERE active = 1 ORDER BY id DESC LIMIT 1").get();
      if (pos) {
        const ec = pos.exit_config ? JSON.parse(pos.exit_config) : {};
        if (ec.strategy_managed) {
          this.positionOpen = true;
          this.positionType = ec.position_type || (pos.instrument_token.includes("CE") ? "CE" : "PE");
          this.positionToken = pos.instrument_token;
          this.positionQty = pos.quantity;
          this.positionProduct = pos.product || "I";
          console.log(`[STRATEGY] Restored position: ${this.positionType} qty=${this.positionQty}`);
        }
      }
    } catch (e) { console.log(`[STRATEGY] Restore error: ${e.message}`); }
  }

  // ==================== CONFIG ====================
  getConfig() {
    if (this.configCache && Date.now() - this.configCacheTime < 10000) return this.configCache;
    const raw = this.getSetting("strategy_config", "");
    const cfg = {
      enabled: false,
      strategy: "trone",
      candle_interval: "3m",
      htf_candle_interval: "45m",
      underlying: "NSE_INDEX|Nifty 50",
      underlying_name: "NIFTY 50",
      lot_size: 65,
      lots: 1,
      product: "I",
      cooldown_seconds: 60,
      params: {},   // strategy-specific params
      ...(raw ? JSON.parse(raw) : {}),
    };
    // Merge default params from the ACTIVE strategy file only
    const strat = this.strategies[cfg.strategy];
    if (strat) {
      const validKeys = new Set(Object.keys(strat.params));
      // Remove params that don't belong to the current strategy
      for (const k of Object.keys(cfg.params)) {
        if (!validKeys.has(k)) delete cfg.params[k];
      }
      // Fill missing params with defaults
      for (const k in strat.params) {
        if (cfg.params[k] === undefined) cfg.params[k] = strat.params[k].value;
      }
    }
    this.configCache = cfg;
    this.configCacheTime = Date.now();
    return cfg;
  }

  saveConfig(config) {
    const current = this.getConfig();
    const merged = { ...current, ...config };
    // If strategy changed, replace params entirely (don't merge old strategy params)
    if (config.strategy && config.strategy !== current.strategy) {
      merged.params = config.params || {};
    } else if (config.params) {
      // Same strategy: merge params (saved values override defaults)
      merged.params = { ...current.params, ...config.params };
    }
    this.setSetting("strategy_config", JSON.stringify(merged));
    this.configCache = null;
    console.log(`[STRATEGY] Config saved: strategy=${merged.strategy}, params=${JSON.stringify(merged.params)}`);
    return merged;
  }

  // ==================== ROUTES ====================
  registerRoutes(app) {
    // List available strategies + their params
    app.get("/api/strategies", (req, res) => {
      const list = {};
      for (const [key, strat] of Object.entries(this.strategies)) {
        list[key] = { name: strat.name, params: strat.params, needsHtf: strat.needsHtf || false };
      }
      res.json({ strategies: list });
    });

    app.get("/api/strategy-config", (req, res) => res.json(this.getConfig()));

    app.post("/api/strategy-config", (req, res) => {
      const saved = this.saveConfig(req.body);
      if (this.running) { this.stop(); this.start(); }
      res.json({ status: "saved", config: saved });
    });

    app.post("/api/strategy-toggle", (req, res) => {
      if (req.body.action === "start") { this.start(); res.json({ status: "running" }); }
      else if (req.body.action === "stop") { this.stop(); res.json({ status: "stopped" }); }
      else res.json({ status: this.running ? "running" : "stopped" });
    });

    app.get("/api/strategy-status", (req, res) => {
      const cfg = this.getConfig();
      res.json({
        running: this.running,
        ws_connected: this.wsConnected,
        last_ltp: this.lastLTP,
        last_tick_time: this.lastTickTime,
        entry_candles: this.entryCandles.length,
        htf_candles: this.htfCandles.length,
        active_strategy: cfg.strategy,
        strategy_name: this.strategies[cfg.strategy] ? this.strategies[cfg.strategy].name : "—",
        last_signal: this.lastSignal,
        last_signal_time: this.lastSignalTime,
        position_open: this.positionOpen,
        position_type: this.positionType,
        market_open: this.isMarketOpen(),
        state_keys: Object.keys(this.state),
        signal_history: this.signalHistory,
      });
    });

    app.get("/api/strategy-preview", async (req, res) => {
      try {
        const cfg = this.getConfig();
        console.log(`[STRATEGY] Preview: strategy=${cfg.strategy}, underlying=${cfg.underlying}, interval=${cfg.candle_interval}`);
        const { token, expiry } = await this.getToken();
        if (!token || Date.now() >= expiry) return res.json({ error: "no_token" });
        const candles = await fetchCandles(this.fetchIPv4, token, cfg.underlying, cfg.candle_interval);
        if (!candles || candles.length === 0) return res.json({ error: "no_candle_data" });
        let htfCandles = null;
        const strat = this.strategies[cfg.strategy];
        if (strat && strat.needsHtf && cfg.htf_candle_interval && cfg.htf_candle_interval !== cfg.candle_interval) {
          htfCandles = await fetchCandles(this.fetchIPv4, token, cfg.underlying, cfg.htf_candle_interval);
        }
        if (!strat) return res.json({ error: "Strategy not found: " + cfg.strategy });
        const paramsObj = {};
        for (const k in strat.params) paramsObj[k] = { ...strat.params[k], value: cfg.params[k] !== undefined ? cfg.params[k] : strat.params[k].value };
        console.log(`[STRATEGY] Preview params: ${JSON.stringify(paramsObj)}`);
        const result = strat.run(candles, htfCandles, { ...this.state }, paramsObj, HELPERS);
        console.log(`[STRATEGY] Preview result: ${result}, candles=${candles.length}, htf=${htfCandles?htfCandles.length:0}`);
        res.json({
          signal: result,
          error: null,
          strategy: cfg.strategy,
          strategy_name: strat.name,
          candle_count: candles.length,
          htf_candle_count: htfCandles ? htfCandles.length : 0,
          last_close: candles[candles.length - 1].close,
          last_high: candles[candles.length - 1].high,
          last_low: candles[candles.length - 1].low,
          ws_connected: this.wsConnected,
          live_ltp: this.lastLTP,
          running: this.running,
          position_open: this.positionOpen,
          position_type: this.positionType,
          state: this.state,
          state_keys: Object.keys(this.state),
          params: cfg.params,
        });
      } catch (e) {
        console.log(`[STRATEGY] Preview error: ${e.message}`);
        res.json({ error: e.message });
      }
    });

    app.post("/api/strategy-reset-state", (req, res) => {
      this.state = {}; this.saveState();
      this.positionOpen = false; this.positionType = null;
      this.positionToken = null; this.positionQty = null; this.positionProduct = null;
      res.json({ status: "reset" });
    });

    // ==================== BACKTEST ====================
    app.get("/api/strategy-backtest", async (req, res) => {
      try {
        const cfg = this.getConfig();
        const { token, expiry } = await this.getToken();
        if (!token || Date.now() >= expiry) return res.json({ error: "no_token" });

        const interval = req.query.interval || cfg.candle_interval || "3m";
        const underlying = req.query.underlying || cfg.underlying;

        const candles = await fetchCandles(this.fetchIPv4, token, underlying, interval);
        if (!candles || candles.length < 5) return res.json({ error: "no_candle_data" });

        let htfCandles = null;
        const strat = this.strategies[cfg.strategy];
        if (strat && strat.needsHtf && cfg.htf_candle_interval && cfg.htf_candle_interval !== interval) {
          htfCandles = await fetchCandles(this.fetchIPv4, token, underlying, cfg.htf_candle_interval);
        }
        if (!strat) return res.json({ error: "Strategy not found: " + cfg.strategy });

        const paramsObj = {};
        for (const k in strat.params) paramsObj[k] = { ...strat.params[k], value: cfg.params[k] !== undefined ? cfg.params[k] : strat.params[k].value };

        const btState = {};
        const trades = [];
        let currentTrade = null;

        for (let i = 1; i < candles.length; i++) {
          const slice = candles.slice(0, i + 1);
          const htfSlice = htfCandles ? htfCandles.filter(c => c.timestamp <= slice[slice.length - 1].timestamp) : null;
          let signal;
          try { signal = strat.run(slice, htfSlice, btState, paramsObj, HELPERS); } catch (e) { signal = null; }

          const c = candles[i];
          if (signal === "BUY_CE" && !currentTrade) {
            currentTrade = { type: "CE", entryIdx: i, entryPrice: c.close, entryTime: c.timestamp };
          } else if (signal === "BUY_PE" && !currentTrade) {
            currentTrade = { type: "PE", entryIdx: i, entryPrice: c.close, entryTime: c.timestamp };
          } else if (signal === "EXIT_CE" && currentTrade && currentTrade.type === "CE") {
            const exitPrice = c.close;
            const pnl = exitPrice - currentTrade.entryPrice;
            trades.push({ ...currentTrade, exitIdx: i, exitPrice, exitTime: c.timestamp, pnl });
            currentTrade = null;
          } else if (signal === "EXIT_PE" && currentTrade && currentTrade.type === "PE") {
            const exitPrice = c.close;
            const pnl = currentTrade.entryPrice - exitPrice;
            trades.push({ ...currentTrade, exitIdx: i, exitPrice, exitTime: c.timestamp, pnl });
            currentTrade = null;
          }
        }
        // Close any open trade at last candle
        if (currentTrade) {
          const lastC = candles[candles.length - 1];
          const pnl = currentTrade.type === "CE" ? lastC.close - currentTrade.entryPrice : currentTrade.entryPrice - lastC.close;
          trades.push({ ...currentTrade, exitIdx: candles.length - 1, exitPrice: lastC.close, exitTime: lastC.timestamp, pnl, note: "open_at_end" });
        }

        const wins = trades.filter(t => t.pnl > 0);
        const losses = trades.filter(t => t.pnl <= 0);
        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
        const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
        const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
        const maxWin = wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
        const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;

        res.json({
          strategy: cfg.strategy,
          strategy_name: strat.name,
          interval,
          underlying,
          candle_count: candles.length,
          total_trades: trades.length,
          wins: wins.length,
          losses: losses.length,
          win_rate: winRate.toFixed(1),
          total_pnl: totalPnl.toFixed(2),
          avg_pnl: avgPnl.toFixed(2),
          max_win: maxWin.toFixed(2),
          max_loss: maxLoss.toFixed(2),
          trades: trades.map(t => ({
            type: t.type,
            entry_price: t.entryPrice.toFixed(2),
            exit_price: t.exitPrice.toFixed(2),
            entry_time: new Date(t.entryTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
            exit_time: new Date(t.exitTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
            pnl: parseFloat(t.pnl.toFixed(2)),
            note: t.note || "",
          })),
        });
      } catch (e) {
        console.log("[STRATEGY] Backtest error: " + e.message);
        res.json({ error: e.message });
      }
    });
  }

  // ==================== STRATEGY EXECUTION ====================
  runStrategy(candles, htfCandles) {
    const cfg = this.getConfig();
    const strat = this.strategies[cfg.strategy];
    if (!strat) return { signal: null, error: "Strategy not found" };
    const paramsObj = {};
    for (const k in strat.params) paramsObj[k] = { ...strat.params[k], value: cfg.params[k] !== undefined ? cfg.params[k] : strat.params[k].value };
    try {
      const result = strat.run(candles, htfCandles, this.state, paramsObj, HELPERS);
      if (["BUY_CE", "BUY_PE", "EXIT_CE", "EXIT_PE", null].includes(result)) return { signal: result, error: null };
      return { signal: null, error: `Invalid return: ${result}` };
    } catch (e) { return { signal: null, error: e.message }; }
  }

  checkTick() {
    if (Date.now() - this.lastEvalTime < 500) return;
    this.lastEvalTime = Date.now();
    const liveCandles = [...this.entryCandles];
    if (this.currentCandle) liveCandles.push(this.currentCandle);
    if (liveCandles.length < 5) return;
    const { signal, error } = this.runStrategy(liveCandles, this.htfCandles.length > 0 ? this.htfCandles : null);
    if (JSON.stringify(this.state) !== this.lastStateJson) { this.saveState(); this.lastStateJson = JSON.stringify(this.state); }
    if (error) return;
    if (signal) this.handleSignal(signal, "tick");
  }

  onCandleClose() {
    if (!this.isMarketOpen()) return;
    if (this.entryCandles.length < 5) return;
    if (Date.now() - this.lastHtfFetch > 5 * 60 * 1000) this.refreshHtfCandles();
    const { signal, error } = this.runStrategy(this.entryCandles, this.htfCandles.length > 0 ? this.htfCandles : null);
    if (JSON.stringify(this.state) !== this.lastStateJson) { this.saveState(); this.lastStateJson = JSON.stringify(this.state); }
    if (error) { console.log(`[STRATEGY] Code error: ${error}`); return; }
    if (signal) this.handleSignal(signal, "candle_close");
  }

  async refreshHtfCandles() {
    try {
      const cfg = this.getConfig();
      if (!cfg.htf_candle_interval || cfg.htf_candle_interval === cfg.candle_interval) return;
      const strat = this.strategies[cfg.strategy];
      if (strat && !strat.needsHtf) return; // skip HTF if strategy doesn't need it
      const { token, expiry } = await this.getToken();
      if (!token || Date.now() >= expiry) return;
      const htf = await fetchCandles(this.fetchIPv4, token, cfg.underlying, cfg.htf_candle_interval);
      if (htf && htf.length > 0) { this.htfCandles = htf.slice(-200); this.lastHtfFetch = Date.now(); }
    } catch (e) { console.log(`[STRATEGY] HTF refresh error: ${e.message}`); }
  }

  async loadInitialCandles() {
    try {
      const cfg = this.getConfig();
      const { token, expiry } = await this.getToken();
      if (!token || Date.now() >= expiry) return;
      const entry = await fetchCandles(this.fetchIPv4, token, cfg.underlying, cfg.candle_interval);
      if (entry && entry.length > 0) { this.entryCandles = entry.slice(-500); this.lastLTP = this.entryCandles[this.entryCandles.length - 1].close; console.log(`[STRATEGY] Loaded ${this.entryCandles.length} candles`); }
      const strat = this.strategies[cfg.strategy];
      if (strat && strat.needsHtf) {
        const htf = await fetchCandles(this.fetchIPv4, token, cfg.underlying, cfg.htf_candle_interval);
        if (htf && htf.length > 0) { this.htfCandles = htf.slice(-200); this.lastHtfFetch = Date.now(); console.log(`[STRATEGY] Loaded ${this.htfCandles.length} HTF candles`); }
      }
    } catch (e) { console.log(`[STRATEGY] Init candles error: ${e.message}`); }
  }

  updateCandle(ltp, timestamp) {
    // ltt from Upstox V3 WebSocket is in SECONDS — convert to milliseconds
    const ts = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    const cfg = this.getConfig();
    const entryMinutes = intervalToMinutes(cfg.candle_interval);
    const now = new Date(ts);
    const minutes = now.getHours() * 60 + now.getMinutes();
    const candleStart = Math.floor(minutes / entryMinutes) * entryMinutes;
    if (minutes < 555 || minutes >= 930) return;
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(Math.floor(candleStart / 60)).padStart(2, "0")}:${String(candleStart % 60).padStart(2, "0")}`;
    if (!this.currentCandle || this.currentCandle.key !== key) {
      if (this.currentCandle && this.currentCandle.close !== null) {
        this.entryCandles.push(this.currentCandle.toCandle());
        if (this.entryCandles.length > 500) this.entryCandles.shift();
        console.log(`[STRATEGY] Candle closed: ${this.currentCandle.key} C=${this.currentCandle.close}`);
        this.onCandleClose();
      }
      this.currentCandle = { key, open: ltp, high: ltp, low: ltp, close: ltp, toCandle() { return { timestamp: this.key, open: this.open, high: this.high, low: this.low, close: this.close, volume: 0 }; } };
    } else {
      this.currentCandle.close = ltp;
      if (ltp > this.currentCandle.high) this.currentCandle.high = ltp;
      if (ltp < this.currentCandle.low) this.currentCandle.low = ltp;
    }
    this.checkTick();
  }

  // ==================== WEBSOCKET ====================
  async start() {
    if (this.running) return;
    const cfg = this.getConfig();
    this.activeKey = cfg.strategy;
    this.running = true;
    const stratName = this.strategies[cfg.strategy] ? this.strategies[cfg.strategy].name : cfg.strategy;
    console.log(`[STRATEGY] Engine started — ${stratName}, ${cfg.candle_interval}/${cfg.htf_candle_interval}`);
    this.addLog("INFO", `Strategy engine started — ${stratName}`);
    await this.loadInitialCandles();
    await this.connectWS();
    this.htfTimer = setInterval(() => this.refreshHtfCandles(), 5 * 60 * 1000);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.ws) { try { this.ws.close(1000); } catch {} this.ws = null; }
    if (this.htfTimer) { clearInterval(this.htfTimer); this.htfTimer = null; }
    if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    this.wsConnected = false;
    console.log("[STRATEGY] Engine stopped");
    this.addLog("INFO", "Strategy engine stopped");
  }

  async connectWS() {
    try {
      const { token, expiry } = await this.getToken();
      if (!token || Date.now() >= expiry) { console.log("[STRATEGY] No valid token for WS"); return; }
      const cfg = this.getConfig();
      console.log(`[STRATEGY] Connecting WS → ${cfg.underlying}`);
      this.ws = new WebSocket("wss://api.upstox.com/v3/feed/market-data-feed", { headers: { Authorization: `Bearer ${token}` }, followRedirects: true });
      this.ws.on("open", () => {
        this.wsConnected = true;
        console.log("[STRATEGY] WebSocket CONNECTED");
        this.addLog("INFO", "WebSocket connected — real-time feed active");
        const subMsg = JSON.stringify({ guid: randomUUID(), method: "sub", data: { mode: "ltpc", instrumentKeys: [cfg.underlying] } });
        this.ws.send(Buffer.from(subMsg));
        console.log(`[STRATEGY] Subscribed to ${cfg.underlying}`);
      });
      this.ws.on("message", (data) => { const d = this.decodeFeed(data); if (d) this.handleFeed(d); });
      this.ws.on("close", (code) => {
        this.wsConnected = false;
        console.log(`[STRATEGY] WS closed: ${code}, reconnecting...`);
        this.addLog("WARN", `WebSocket closed (code ${code}), reconnecting...`);
        if (this.running) {
          this.wsReconnectTimer = setTimeout(async () => {
            if (this.running) { await this.loadInitialCandles(); await this.connectWS(); }
          }, 3000);
        }
      });
      this.ws.on("error", (e) => { console.log(`[STRATEGY] WS error: ${e.message}`); });
    } catch (e) {
      console.log(`[STRATEGY] WS connect error: ${e.message}`);
      if (this.running) { this.wsReconnectTimer = setTimeout(() => { if (this.running) this.connectWS(); }, 5000); }
    }
  }

  handleFeed(feed) {
    try {
      if (!feed.feeds) return;
      this.lastTickTime = Date.now();
      const cfg = this.getConfig();
      const entry = feed.feeds[cfg.underlying];
      if (!entry || !entry.ltpc) return;
      const ltp = entry.ltpc.ltp;
      const ltt = entry.ltpc.ltt ? parseInt(entry.ltpc.ltt) : 0;
      if (ltt === 0) return;
      this.lastLTP = ltp;
      this.updateCandle(ltp, ltt);
    } catch (e) { /* silent */ }
  }

  // ==================== SIGNAL HANDLER ====================
  async handleSignal(signal, source) {
    if (this.signalLock) { console.log(`[STRATEGY] Lock active — skipping ${signal}`); return; }
    this.signalLock = true;
    try { await this._handleSignalImpl(signal, source); }
    finally { this.signalLock = false; }
  }

  async _handleSignalImpl(signal, source) {
    const cfg = this.getConfig();
    const isExit = signal === "EXIT_CE" || signal === "EXIT_PE";
    // Block all orders when market is closed (Upstox rejects with UDAPI1162)
    if (!this.isMarketOpen()) { console.log(`[STRATEGY] Market closed — skipping ${signal}`); return; }
    if (!isExit && this.lastSignalTime > 0 && Date.now() - this.lastSignalTime < (cfg.cooldown_seconds || 60) * 1000) { console.log(`[STRATEGY] Cooldown — skipping ${signal}`); return; }
    const signalTime = Date.now();
    console.log(`[STRATEGY] Signal: ${signal} (${source})`);
    this.lastSignal = { signal, time: signalTime, state_snapshot: { ...this.state }, source };
    this.signalHistory.unshift({ signal, time: signalTime, state: { ...this.state }, source });
    if (this.signalHistory.length > 20) this.signalHistory.pop();

    if (signal === "BUY_CE" || signal === "BUY_PE") {
      if (this.positionOpen) { console.log(`[STRATEGY] Position open — skipping`); return; }
      try {
        const { token } = await this.getToken();
        if (!token) return;
        const optionType = signal === "BUY_CE" ? "CE" : "PE";
        const atm = await this.calculateATM(token, cfg.underlying, optionType, null, this.lastLTP);
        if (!atm) { this.addLog("ERROR", "Strategy: ATM failed"); return; }
        const quantity = parseInt(cfg.lots, 10) * parseInt(cfg.lot_size, 10);
        console.log(`[STRATEGY] ${signal}: ${optionType} ATM ${atm.atm_strike} spot=${atm.spot} qty=${quantity}`);
        const orderResult = await this.placeUpstoxOrder(token, { quantity, product: cfg.product || "I", order_type: "MARKET", transaction_type: "BUY", instrument_token: atm.instrument_key });
        const orderMs = Date.now() - signalTime;
        console.log(`[STRATEGY] Entry took ${orderMs}ms → ${orderResult.ok ? "PLACED" : "FAILED"}`);
        this.lastSignalTime = signalTime;
        this.logOrder("strategy", "BUY", atm.instrument_key, quantity, orderResult.data, orderResult.ok);
        this.addLog(orderResult.ok ? "INFO" : "ERROR", `Strategy ${signal}: ATM ${atm.atm_strike} ${optionType} → ${orderResult.ok ? "PLACED" : "FAILED"} (${orderMs}ms)`);
        if (orderResult.ok) {
          this.positionOpen = true; this.positionType = optionType;
          this.positionToken = atm.instrument_key; this.positionQty = quantity; this.positionProduct = cfg.product || "I";
          const optionLTP = await this.getLTP(token, atm.instrument_key);
          const entryPrice = optionLTP || atm.spot;
          this.db.prepare(`INSERT INTO positions (instrument_token, transaction_type, quantity, entry_price, highest_price, lowest_price, added_at, exit_config, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
            .run(atm.instrument_key, "BUY", quantity, entryPrice, entryPrice, entryPrice, Date.now(), JSON.stringify({ mode: "none", strategy_managed: true, position_type: optionType }));
        }
      } catch (e) { console.log(`[STRATEGY] Buy error: ${e.message}`); this.addLog("ERROR", `Strategy buy error: ${e.message}`); }
    } else if (signal === "EXIT_CE" || signal === "EXIT_PE") {
      if (!this.positionOpen) return;
      const exitType = signal === "EXIT_CE" ? "CE" : "PE";
      if (this.positionType !== exitType) return;
      try {
        const { token: tk } = await this.getToken();
        const result = await this.placeUpstoxOrder(tk, { quantity: this.positionQty, product: this.positionProduct || "I", order_type: "MARKET", transaction_type: "SELL", instrument_token: this.positionToken });
        const exitMs = Date.now() - signalTime;
        this.lastSignalTime = signalTime;
        console.log(`[STRATEGY] Exit took ${exitMs}ms → ${result.ok ? "EXITED" : "FAILED"}`);
        this.logOrder("strategy_exit", "SELL", this.positionToken, this.positionQty, result.data, result.ok);
        this.db.prepare("UPDATE positions SET active = 0 WHERE instrument_token = ? AND active = 1").run(this.positionToken);
        this.addLog(result.ok ? "INFO" : "ERROR", `Strategy ${signal}: exit → ${result.ok ? "EXITED" : "FAILED"} (${exitMs}ms)`);
        this.positionOpen = false; this.positionType = null; this.positionToken = null; this.positionQty = null; this.positionProduct = null;
      } catch (e) { console.log(`[STRATEGY] Exit error: ${e.message}`); }
    }
  }

  saveState() { try { this.setSetting("strategy_state", JSON.stringify(this.state)); } catch (e) { console.log(`[STRATEGY] State save error: ${e.message}`); } }
}

const engine = new StrategyEngine();
module.exports = engine;
