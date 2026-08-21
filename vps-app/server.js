const express = require("express");
const Database = require("better-sqlite3");
const fetch = require("node-fetch");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const app = express();
// --- Security headers ---
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
// --- Dashboard authentication ---
function dashAuth(req, res, next) {
  // Skip auth for webhook (has its own token auth) and notifier
  if (req.path === "/webhook" || req.path === "/notifier") return next();
  // Check if password is set
  const dashPass = getSetting("DASHBOARD_PASSWORD", "");
  if (!dashPass) return next(); // No password set = open (user can set one in Settings)
  // Check session cookie
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/dash_auth=([^;]+)/);
  if (match && match[1] === dashPass) return next();
  // Check bearer token
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ") && auth.substring(7) === dashPass) return next();
  // Not authenticated
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Authentication required. Set DASHBOARD_PASSWORD." });
  }
  // Show login page for HTML requests
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Horse Engine — Login</title><style>body{background:#0d1117;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}form{text-align:center}input{padding:12px;width:200px;background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:6px;font-size:16px}button{padding:12px 20px;margin-top:8px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer}h1{color:#58a6ff;margin-bottom:20px}a{color:#58a6ff;font-size:12px}</style></head><body><form onsubmit="let p=document.getElementById('pw').value;document.cookie='dash_auth='+p+';path=/;max-age=86400';location.reload()"><h1>🐎 Horse Engine</h1><input type="password" id="pw" placeholder="Enter password" autofocus><br><button type="submit">Login</button></form></body></html>`);
}


app.set("trust proxy", 1);
const PORT = 3000;
const DB_PATH = path.join(__dirname, "data.db");

// Force IPv4 on all outgoing requests — prevents UDAPI1154 IP mismatch error
// Upstox whitelists your IPv4 address, but the VPS defaults to IPv6 for outgoing calls.
const ipv4Agent = new https.Agent({
  family: 4,
  keepAlive: true,
});
const httpIpv4Agent = new http.Agent({
  family: 4,
  keepAlive: true,
});
function fetchIPv4(url, opts = {}) {
  const isHttps = url.startsWith("https");
  return fetch(url, { ...opts, agent: isHttps ? ipv4Agent : httpIpv4Agent });
}

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ limit: "1mb" }));

// No-cache for all API responses — prevents browser from serving stale data
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// --- Database ---

// === INSTRUMENT CACHE — avoids repeated API calls for same data ===
const _instCache = {};
const _CACHE_TTL = 60000; // 60 seconds
function getCached(key) { const e = _instCache[key]; if (e && Date.now() - e.ts < _CACHE_TTL) return e.data; return null; }
function setCached(key, data) { _instCache[key] = { ts: Date.now(), data }; }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, raw_message TEXT, payload TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, type TEXT, action TEXT, instrument_token TEXT, quantity INTEGER, result TEXT, ok INTEGER);
  CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, instrument_token TEXT, transaction_type TEXT, quantity INTEGER, entry_price REAL, highest_price REAL, lowest_price REAL, added_at INTEGER, exit_config TEXT, product TEXT DEFAULT 'D', active INTEGER DEFAULT 1, hedge_id TEXT, leg_type TEXT);
  CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, level TEXT, message TEXT);
`);
try { db.exec("ALTER TABLE positions ADD COLUMN hedge_id TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE positions ADD COLUMN leg_type TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE positions ADD COLUMN product TEXT DEFAULT 'D'"); } catch(e) {}

// --- Helpers ---
function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

// BUG 37: Daily trade counter + kill switch
let dailyTradeCount = 0;
let dailyTradeDate = new Date().toDateString();
function checkDailyLimit() {
  const today = new Date().toDateString();
  if (today !== dailyTradeDate) {
    dailyTradeCount = 0;
    dailyTradeDate = today;
  }
  const maxTrades = parseInt(getSetting("max_daily_trades", "10"), 10);
  if (maxTrades > 0 && dailyTradeCount >= maxTrades) {
    console.log(`[SAFETY] Daily trade limit reached: ${dailyTradeCount}/${maxTrades} — blocking new orders`);
    return false;
  }
  return true;
}
function incrementTradeCount() {
  dailyTradeCount++;
  console.log(`[SAFETY] Daily trades: ${dailyTradeCount}`);
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}
function getSecret(key) { return getSetting(key); }
function logSignal(raw, payload, status) {
  db.prepare("INSERT INTO signals (timestamp, raw_message, payload, status) VALUES (?, ?, ?, ?)")
    .run(Date.now(), raw, JSON.stringify(payload), status);
}
function logOrder(type, action, instrument, qty, result, ok) {
  db.prepare("INSERT INTO orders (timestamp, type, action, instrument_token, quantity, result, ok) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(Date.now(), type, action, instrument, qty, JSON.stringify(result), ok ? 1 : 0);
}
function addLog(level, msg) {
  db.prepare("INSERT INTO logs (timestamp, level, message) VALUES (?, ?, ?)").run(Date.now(), level, msg);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isMarketOpen() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  if (isTradingHoliday()) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930; // 9:15 AM to 3:30 PM IST
}


// BUG 34: NSE/BSE trading holidays 2026 (partial list — update as needed)
const NSE_HOLIDAYS_2026 = [
  "2026-01-26", // Republic Day
  "2026-03-06", // Holi (adjust per actual date)
  "2026-03-27", // Good Friday (adjust)
  "2026-04-14", // Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-08-15", // Independence Day
  "2026-10-02", // Gandhi Jayanti
  "2026-10-21", // Dussehra (adjust)
  "2026-10-31", // Diwali (adjust — Laxmi Pujan, trading hours may differ)
  "2026-11-05", // Diwali Balipratipada
  "2026-12-25", // Christmas
];
function isTradingHoliday() {
  // Use IST date (UTC+5:30) — toISOString() returns UTC which is wrong for IST
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const today = ist.toISOString().substring(0, 10);
  return NSE_HOLIDAYS_2026.includes(today);
}

const UNDERLYING = [
  { name: "NIFTY 50", key: "NSE_INDEX|Nifty 50", symbol: "NIFTY", lot_size: 65 },
  { name: "NIFTY BANK", key: "NSE_INDEX|Nifty Bank", symbol: "BANKNIFTY", lot_size: 30 },
  { name: "NIFTY FIN SERVICE", key: "NSE_INDEX|Nifty Fin Service", symbol: "FINNIFTY", lot_size: 60 },
  { name: "NIFTY MIDCAP SELECT", key: "NSE_INDEX|Nifty Midcap 50", symbol: "MIDCPNIFTY", lot_size: 120 },
  { name: "SENSEX", key: "BSE_INDEX|Sensex", symbol: "SENSEX", lot_size: 20 },
  { name: "BANKEX", key: "BSE_INDEX|Bankex", symbol: "BANKEX", lot_size: 30 },
];

const DEFAULT_EXIT_CONFIG = {
  enabled: false, mode: "none",
  trailing_sl_points: 20, trailing_activation_points: 10,
  fixed_sl_points: 30, fixed_target_points: 40,
};

function getExitConfig() {
  const raw = getSetting("exit_config", "");
  return { ...DEFAULT_EXIT_CONFIG, ...(raw ? JSON.parse(raw) : {}) };
}

// --- Trading Config (what the bot buys when it gets a webhook signal) ---
const DEFAULT_TRADING_CONFIG = {
  underlying: "NSE_INDEX|Nifty 50",
  underlying_name: "NIFTY 50",
  lot_size: 65,
  option_type: "CE",
  auto_enabled: true,
  futures_enabled: false,
  strike_offset: 2,
  hedge_lots: 1,                // CE or PE (default leg)
  lots: 1,
  product: "D",
  // --- CE leg (Buy CE alerts) ---
  ce_enabled: true,
  ce_lots: 1,
  ce_product: "D",
  // --- PE leg (Buy PE alerts) ---
  pe_enabled: true,
  pe_lots: 1,
  pe_product: "D",
};

function getTradingConfig() {
  const raw = getSetting("trading_config", "");
  return { ...DEFAULT_TRADING_CONFIG, ...(raw ? JSON.parse(raw) : {}) };
}

// Auto-calculate ATM strike for an underlying
async function calculateATM(accessToken, instrumentKey, optionType, expiryDate, wsSpot) {
  // Run LTP fetch and option contracts fetch in PARALLEL to save ~200ms
  const [spotResult, result] = await Promise.all([
    wsSpot ? Promise.resolve(wsSpot) : getLTP(accessToken, instrumentKey),
    getOptionContracts(accessToken, instrumentKey, null)
  ]);
  const spot = spotResult;
  if (!spot) return null;
  if (!result.ok) return null;
  const contracts = (result.data && result.data.data) || [];
  // Get nearest expiry if not specified
  const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
  if (expiries.length === 0) return null;
  const nearestExpiry = expiryDate || expiries[0];
  // Filter by expiry and option type
  const typed = contracts.filter(c => c.expiry === nearestExpiry && c.instrument_type === optionType);
  if (typed.length === 0) return null;
  // Find ATM (closest to spot)
  let atm = typed[0], minDiff = Math.abs(typed[0].strike_price - spot);
  for (const c of typed) {
    const d = Math.abs(c.strike_price - spot);
    if (d < minDiff) { minDiff = d; atm = c; }
  }
  return { spot, atm_strike: atm.strike_price, instrument_key: atm.instrument_key, trading_symbol: atm.trading_symbol, lot_size: atm.lot_size, expiry: nearestExpiry };
}

// --- Find nearest futures contract for an underlying ---
async function findFuturesContract(accessToken, instrumentKey) {

  const _ck = 'fut_' + underlying;
  const _cached = getCached(_ck);
  if (_cached) { console.log('[CACHE] Hit for futures contract'); return _cached; }
  const url = `https://api.upstox.com/v2/instruments/search?query=${encodeURIComponent(instrumentKey.split('|')[1] || 'NIFTY')}&segments=FO`;
  const resp = await fetchIPv4(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok || !data || !data.data) {
    console.log('[FUTURES] Search API failed, trying option/contract endpoint');
    const altUrl = `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`;
    const altResp = await fetchIPv4(altUrl, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
    const altText = await altResp.text();
    let altData; try { altData = JSON.parse(altText); } catch { altData = { raw: altText }; }
    if (!altResp.ok || !altData || !altData.data) return null;
    const futContracts = altData.data.filter(c => c.instrument_type === 'FUTIDX' || c.instrument_type === 'FUTSTK' || c.instrument_type === 'FUT');
    if (futContracts.length === 0) return null;
    const expiries = [...new Set(futContracts.map(c => c.expiry))].sort();
    const nearestExpiry = expiries[0];
    const fut = futContracts.find(c => c.expiry === nearestExpiry) || futContracts[0];
  setCached(_ck, { instrument_key: fut.instrument_key, trading_symbol: fut.trading_symbol, lot_size: fut.lot_size, expiry: nearestExpiry });
    return { instrument_key: fut.instrument_key, trading_symbol: fut.trading_symbol, lot_size: fut.lot_size, expiry: nearestExpiry };
  }
  const futContracts = data.data.filter(c => (c.instrument_type === 'FUTIDX' || c.instrument_type === 'FUTSTK' || c.instrument_type === 'FUT') && c.segment === 'NSE_FO');
  if (futContracts.length === 0) return null;
  const expiries = [...new Set(futContracts.map(c => c.expiry))].filter(e => e).sort();
  if (expiries.length === 0) return null;
  const nearestExpiry = expiries[0];
  const fut = futContracts.find(c => c.expiry === nearestExpiry) || futContracts[0];
  console.log(`[FUTURES] Found: ${fut.trading_symbol || fut.instrument_key}, expiry: ${nearestExpiry}, lot: ${fut.lot_size}`);
  return { instrument_key: fut.instrument_key, trading_symbol: fut.trading_symbol, lot_size: fut.lot_size, expiry: nearestExpiry };
}

// --- Check available funds/margin in Upstox account ---
// GET /user/get-funds-and-margin returns available_margin
async function getAvailableFunds(accessToken) {
  try {
    const resp = await fetchIPv4("https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC", {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok || !data || !data.data || !data.data.equity) {
      console.log(`[FUNDS] API failed: ${text.substring(0, 200)}`);
      return null;
    }
    const available = data.data.equity.available_margin || 0;
    const used = data.data.equity.used_margin || 0;
    console.log(`[FUNDS] Available: ${available}, Used: ${used}`);
    return { available_margin: available, used_margin: used };
  } catch (e) {
    console.log(`[FUNDS] Error: ${e.message}`);
    return null;
  }
}


// --- Check basket margin for hedge (futures + option) ---
async function getBasketMargin(accessToken, instruments) {
  try {
    const resp = await fetchIPv4("https://api.upstox.com/v2/charges/margin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ instruments }),
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok || !data || !data.data) {
      console.log(`[MARGIN] API failed: ${text.substring(0, 200)}`);
      return null;
    }
    const required = data.data.required_margin || 0;
    const final = data.data.final_margin || 0;
    const benefit = required - final;
    console.log(`[MARGIN] Required: ${required}, Final (after hedge): ${final}, Benefit: ${benefit}`);
    return { required_margin: required, final_margin: final, benefit, details: data.data.margins };
  } catch (e) {
    console.log(`[MARGIN] Error: ${e.message}`);
    return null;
  }
}



// --- Webhook URL endpoint — returns the REAL webhook URL with actual secret ---
app.get("/api/webhook-url", (req, res) => {
  const ws = getSetting("WEBHOOK_SECRET", "");
  const url = ws ? `${req.protocol}://${req.get("host")}/webhook?token=${ws}` : "";
  res.json({ url, has_secret: !!ws });
});

// --- Upstox API ---
async function getToken() {
  const token = getSetting("access_token", "");
  const expiry = parseInt(getSetting("access_token_expiry", "0"), 10);
  return { token, expiry };
}

async function placeUpstoxOrder(accessToken, order) {
  // BUG 37: Check daily trade limit before placing order
  if (!checkDailyLimit()) {
    console.log("[ORDER] Blocked: daily trade limit reached");
    return { ok: false, status: 429, data: { error: "Daily trade limit reached" } };
  }
  const orderType = (order.order_type || "MARKET").toUpperCase();
  // Auto-switch to LIMIT if market is closed and order type is MARKET
  const useLimit = orderType === "MARKET" && !isMarketOpen();
  const ltp = useLimit ? await getLTP(accessToken, order.instrument_token) : 0;
  const finalOrderType = useLimit ? "LIMIT" : orderType;
  const finalPrice = useLimit ? (ltp || 0) : parseFloat(order.price || 0);

  // BUG 6: slice:true — auto-split orders exceeding exchange freeze quantity
  // BUG 7: Use V3 API endpoint
  const body = {
    quantity: order.quantity,
    product: order.product || "D",
    validity: order.validity || "DAY",
    price: finalPrice,
    tag: order.tag || "tv-webhook",
    instrument_token: order.instrument_token,
    order_type: finalOrderType,
    transaction_type: order.transaction_type,
    disclosed_quantity: 0,
    trigger_price: 0,
    is_amo: false,
    market_protection: -1, // automatic (Upstox decides)
    slice: true,
  };
  console.log(`[ORDER] Placing (V3): ${JSON.stringify(body)}`);
  console.log(`[ORDER] Market open: ${isMarketOpen()}, using ${finalOrderType} at price ${finalPrice}`);
  console.log(`[ORDER] Token preview: ${accessToken ? accessToken.substring(0, 15) + "..." : "(empty)"}`);
  const resp = await fetchIPv4("https://api-hft.upstox.com/v3/order/place", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  console.log(`[ORDER] Response: HTTP ${resp.status} — ${text.substring(0, 300)}`);
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  // BUG 5: Verify order was actually accepted — check response body, not just HTTP 200
  const orderAccepted = resp.ok && data && (data.status === "success" || (data.data && data.data.order_id));
  if (resp.ok && !orderAccepted) {
    console.log(`[ORDER] WARNING: HTTP 200 but order may not be accepted: ${text.substring(0, 200)}`);
  }
  // Check for exchange rejection in response body (margin errors, etc.)
  const rejectKeywords = ["margin", "insufficient", "rejected", "failed", "error", "you need to add"];
  const responseStr = text.toLowerCase();
  const isRejected = !orderAccepted || rejectKeywords.some(k => responseStr.includes(k) && !responseStr.includes('"status":"success"'));
  if (isRejected) {
    console.log(`[ORDER] REJECTED by exchange: ${text.substring(0, 300)}`);
    return { ok: false, status: resp.status, data: { ...data, _rejection_detected: true } };
  }
  if (orderAccepted) incrementTradeCount();
  return { ok: orderAccepted, status: resp.status, data };
}

async function placeExitOrder(accessToken, instrumentToken, quantity, transactionType, product) {
  return await placeUpstoxOrder(accessToken, {
    quantity, product: product || "D", validity: "DAY", order_type: "MARKET",
    transaction_type: transactionType, instrument_token: instrumentToken,
    tag: "exit",
  });
}

// Fetch actual fill price from Upstox after order completes
async function getOrderFillPrice(accessToken, orderId) {
  try {
    // Wait 1.5s for exchange to process the order
    await new Promise(r => setTimeout(r, 1500));
    const url = `https://api-hft.upstox.com/v3/order/details?order_id=${encodeURIComponent(orderId)}`;
    const resp = await fetchIPv4(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // V3 order details returns data with average_price and status
    if (data && data.data) {
      const d = Array.isArray(data.data) ? data.data[data.data.length - 1] : data.data;
      if (d && d.average_price && d.average_price > 0 && d.status === "complete") {
        console.log(`[ORDER] Fill price fetched: ${d.average_price} (order ${orderId})`);
        return d.average_price;
      }
    }
    return null;
  } catch (e) {
    console.error("[ORDER] Error fetching fill price:", e.message);
    return null;
  }
}

async function getLTP(accessToken, instrumentToken) {
  const url = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentToken)}`;
  const resp = await fetchIPv4(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const key = Object.keys(data.data || {})[0];
  return key ? data.data[key].last_price : null;
}

// --- Option contracts cache (contracts don't change intraday) ---
let _optionContractsCache = {}; // key: instrumentKey -> { data, timestamp }
const OPTION_CACHE_TTL = 6 * 3600000; // 6 hours — contracts don't change intraday

async function getOptionContracts(accessToken, instrumentKey, expiryDate) {

  const _ock = 'opt_' + underlyingKey;
  const _ocached = getCached(_ock);
  if (_ocached) { console.log('[CACHE] Hit for option contracts'); return _ocached; }
  const cacheKey = instrumentKey;
  const cached = _optionContractsCache[cacheKey];
  if (cached && (Date.now() - cached.timestamp) < OPTION_CACHE_TTL) {
    // Filter cached data by expiry if requested
    let contracts = cached.data;
    if (expiryDate) {
      contracts = contracts.filter(c => c.expiry === expiryDate);
    }
  if (result) setCached(_ock, result);
    return { ok: true, status: 200, data: { data: cached.data } };
  }
  let url = `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`;
  if (expiryDate) url += `&expiry_date=${encodeURIComponent(expiryDate)}`;
  const resp = await fetchIPv4(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  // Cache the contracts array for 6 hours (contracts don't change intraday)
  if (resp.ok && data && data.data && Array.isArray(data.data)) {
    _optionContractsCache[cacheKey] = { data: data.data, timestamp: Date.now() };
    console.log(`[CACHE] Stored ${data.data.length} option contracts for ${instrumentKey}`);
  }
  return { ok: resp.ok, status: resp.status, data };
}

async function requestAccessToken() {
  // Read from DB, with hardcoded fallbacks so it works even if DB is empty
  const clientId = getSetting("UPSTOX_CLIENT_ID", "") || "a97d9aad-d04c-4dd7-9c2b-72bcd1f08bb4";
  const clientSecret = getSetting("UPSTOX_CLIENT_SECRET", "") || "51bz9r0ww1";

  const url = `https://api.upstox.com/v3/login/auth/token/request/${clientId}`;
  console.log(`[TOKEN] Requesting token for client_id: ${clientId.substring(0, 8)}... (secret length: ${clientSecret.length})`);
  const resp = await fetchIPv4(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_secret: clientSecret }),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  console.log(`[TOKEN] Response: HTTP ${resp.status} — ${text.substring(0, 200)}`);
  addLog(resp.ok ? "INFO" : "ERROR", `Token request ${resp.ok ? "sent" : "failed"} (HTTP ${resp.status}): ${text.substring(0, 300)}`);
  return { ok: resp.ok, status: resp.status, data };
}

async function getUpstoxPositions() {
  const { token, expiry } = await getToken();
  if (!token || Date.now() >= expiry) return { error: "no_token" };
  const resp = await fetchIPv4("https://api.upstox.com/v2/portfolio/short-term-positions", {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  // Cache the contracts array for 6 hours (contracts don't change intraday)
  if (resp.ok && data && data.data && Array.isArray(data.data)) {
    _optionContractsCache[cacheKey] = { data: data.data, timestamp: Date.now() };
    console.log(`[CACHE] Stored ${data.data.length} option contracts for ${instrumentKey}`);
  }
  return { ok: resp.ok, status: resp.status, data };
}

// --- Exit Engine (runs every 5 seconds) ---
async function checkExits() {
  const config = getExitConfig();
  const globalExitEnabled = config.enabled && config.mode !== "none";
  const { token, expiry } = await getToken();
  if (!token || Date.now() >= expiry) return;
  const positions = db.prepare("SELECT * FROM positions WHERE active = 1").all();
  if (positions.length === 0) return;

  for (const pos of positions) {
    let shouldExit = false;
    let exitReason = "";
    const exitCfg = pos.exit_config ? JSON.parse(pos.exit_config) : {};
    // Skip strategy-managed positions — strategy engine handles its own exits
    if (exitCfg.strategy_managed) continue;
    if (exitCfg.hedge_id || pos.hedge_id) continue;

    // Each position can have its OWN exit config (from webhook CE/PE legs)
    // If position has its own mode, use it. Otherwise fall back to global config.
    // If neither has exit config, skip this position.
    const hasOwnExit = exitCfg.mode && exitCfg.mode !== "none";
    if (!hasOwnExit && !globalExitEnabled) continue; // No exit config for this position

    const mode = exitCfg.mode || config.mode;
    const trailSLpts = exitCfg.trailing_sl_points ?? config.trailing_sl_points;
    const trailActPts = exitCfg.trailing_activation_points ?? config.trailing_activation_points;
    const fixedSLpts = exitCfg.fixed_sl_points ?? config.fixed_sl_points;
    const fixedTargetPts = exitCfg.fixed_target_points ?? config.fixed_target_points;

    const ltp = await getLTP(token, pos.instrument_token);
    if (ltp === null) continue;

    if (pos.transaction_type === "BUY") {
      if (ltp > (pos.highest_price || 0)) {
        pos.highest_price = ltp;
        db.prepare("UPDATE positions SET highest_price = ? WHERE id = ?").run(ltp, pos.id);
      }
    } else {
      if (ltp < (pos.lowest_price || 999999)) {
        pos.lowest_price = ltp;
        db.prepare("UPDATE positions SET lowest_price = ? WHERE id = ?").run(ltp, pos.id);
      }
    }

    const isBuy = pos.transaction_type === "BUY";

    if (mode === "trailing_sl" || mode === "both") {
      if (isBuy) {
        const movePts = (pos.highest_price || 0) - pos.entry_price;
        if (movePts >= trailActPts) {
          const sl = (pos.highest_price || 0) - trailSLpts;
          if (ltp <= sl) { shouldExit = true; exitReason = `Trailing SL hit (SL: ${sl.toFixed(2)}, LTP: ${ltp})`; }
        }
      } else {
        const movePts = pos.entry_price - (pos.lowest_price || 0);
        if (movePts >= trailActPts) {
          const sl = (pos.lowest_price || 0) + trailSLpts;
          if (ltp >= sl) { shouldExit = true; exitReason = `Trailing SL hit (SL: ${sl.toFixed(2)}, LTP: ${ltp})`; }
        }
      }
    }

    if (!shouldExit && (mode === "fixed_sl_target" || mode === "both")) {
      if (isBuy) {
        const slPrice = pos.entry_price - fixedSLpts;
        const targetPrice = pos.entry_price + fixedTargetPts;
        if (ltp <= slPrice) { shouldExit = true; exitReason = `Fixed SL hit (SL: ${slPrice.toFixed(2)}, LTP: ${ltp})`; }
        else if (ltp >= targetPrice) { shouldExit = true; exitReason = `Target hit (Target: ${targetPrice.toFixed(2)}, LTP: ${ltp})`; }
      } else {
        const slPrice = pos.entry_price + fixedSLpts;
        const targetPrice = pos.entry_price - fixedTargetPts;
        if (ltp >= slPrice) { shouldExit = true; exitReason = `Fixed SL hit (SL: ${slPrice.toFixed(2)}, LTP: ${ltp})`; }
        else if (ltp <= targetPrice) { shouldExit = true; exitReason = `Target hit (Target: ${targetPrice.toFixed(2)}, LTP: ${ltp})`; }
      }
    }

    if (shouldExit) {
      const exitSide = isBuy ? "SELL" : "BUY";
      const result = await placeExitOrder(token, pos.instrument_token, pos.quantity, exitSide, pos.product || 'D');
      logOrder("exit", exitSide, pos.instrument_token, pos.quantity, result.data, result.ok);
      addLog("INFO", `Exit: ${exitReason} — ${pos.instrument_token}`);
      db.prepare("UPDATE positions SET active = 0 WHERE id = ?").run(pos.id);
    }
  }
}


// BUG 23: Sync bot positions with actual Upstox positions every 60 seconds
async function syncPositionsWithUpstox() {
  try {
    const { token, expiry } = await getToken();
    if (!token || Date.now() >= expiry) return;
    if (!isMarketOpen()) return;
    
    const resp = await fetchIPv4("https://api.upstox.com/v2/portfolio/short-term-positions", {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const upstoxPositions = (data.data || []).filter(p => p.quantity > 0);
    const upstoxTokens = new Set(upstoxPositions.map(p => p.instrument_token));
    
    // Check bot's active positions that no longer exist in Upstox
    const dbPositions = db.prepare("SELECT * FROM positions WHERE active = 1").all();
    for (const pos of dbPositions) {
      if (!upstoxTokens.has(pos.instrument_token)) {
        // Position was closed externally (manual exit on app)
        console.log(`[SYNC] Position ${pos.instrument_token} no longer in Upstox — marking closed`);
        db.prepare("UPDATE positions SET active = 0 WHERE id = ?").run(pos.id);
        addLog("WARN", `Position closed externally: ${pos.instrument_token}`);
      }
    }
  } catch (e) {
    // Silent — don't spam logs on network errors
  }
}

// Run exit engine every 5 seconds
setInterval(async () => {
  if (isMarketOpen()) {
    try { await checkExits(); } catch (e) { addLog("ERROR", "Exit engine: " + e.message); }
    try { await syncPositionsWithUpstox(); } catch (e) {}
  }
}, 5000);

// Token request cron at 9:10 AM IST
setInterval(async () => {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const day = ist.getUTCDay();
  if (day >= 1 && day <= 5 && istMinutes === 550) { // 9:10 AM IST
    try { await requestAccessToken(); addLog("INFO", "Token request triggered"); } catch (e) {}
  }
}, 60000);

// --- Dedupe ---
const recentSignals = new Map();
function isDuplicate(payload) {
  const key = JSON.stringify(payload);
  if (recentSignals.has(key)) return true;
  recentSignals.set(key, true);
  setTimeout(() => recentSignals.delete(key), 10000);
  return false;
}

// ==================== ROUTES ====================

// Dashboard HTML — no-cache headers prevent browser from serving stale HTML
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.send(DASHBOARD_HTML);
});

// --- Rate limiting (in-memory, no dependency needed) ---
const _rateBuckets = {};
const RATE_WINDOW = 60000; // 1 minute
const RATE_MAX_API = 60; // 60 requests/min for API
const RATE_MAX_WEBHOOK = 30; // 30 requests/min for webhook
function rateLimit(key, max) {
  const now = Date.now();
  const bucket = _rateBuckets[key] || { count: 0, reset: now + RATE_WINDOW };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + RATE_WINDOW; }
  bucket.count++;
  _rateBuckets[key] = bucket;
  return bucket.count <= max;
}
// Rate limit API endpoints
app.use("/api/", (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!rateLimit("api:" + ip, RATE_MAX_API)) {
    return res.status(429).json({ error: "Too many requests. Slow down." });
  }
  next();
});

// Webhook receiver — accepts {"action":"BUY"}, plain "BUY", or TradingView {{strategy.order.action}}
// Bot uses saved Trading Config to determine instrument, strike, qty, exits
// This is the NEW webhook handler for v21.0
// Replaces the entire app.post("/webhook", ...) block
// 
// Signal mapping:
//   buy_ce  → BUY futures + BUY OTM PE (bullish, PE=hedge for margin benefit)
//   sell_ce → SELL futures ONLY (option stays for manual exit from Positions)
//   buy_pe  → SELL futures + BUY OTM CE (bearish, CE=hedge for margin benefit)
//   sell_pe → BUY BACK futures ONLY (option stays for manual exit from Positions)
//
// Exit signals close futures ONLY. Option stays for manual exit via Positions tab Exit button.

app.post("/webhook", async (req, res) => {
  const wip = req.ip || req.socket.remoteAddress || "unknown";
  if (!rateLimit("webhook:" + wip, RATE_MAX_WEBHOOK)) {
    return res.status(429).json({ status: "error", message: "Too many webhook requests. Slow down." });
  }
  let rawText = "";
  if (typeof req.body === "string") { rawText = req.body; }
  else if (typeof req.body === "object" && req.body !== null) { rawText = JSON.stringify(req.body); }

  console.log(`[WEBHOOK] Raw body: ${rawText.substring(0, 500)}`);
  console.log(`[WEBHOOK] Content-Type: ${req.headers["content-type"] || "unknown"}`);

  const webhookSecret = getSetting("WEBHOOK_SECRET", "");
  if (!webhookSecret) {
    logSignal(rawText.substring(0, 1000), {}, "error_no_webhook_secret");
    return res.json({ status: "error", message: "WEBHOOK_SECRET not set. Go to Settings tab." });
  }

  const queryToken = req.query.token || "";
  let payload = {};

  if (typeof req.body === "object" && req.body !== null) {
    payload = req.body;
  } else if (typeof req.body === "string") {
    const text = req.body.trim();
    try {
      payload = JSON.parse(text);
    } catch {
      const upper = text.toUpperCase().trim();
      if (["BUY", "SELL"].includes(upper)) {
        payload = { action: upper };
      } else {
        const actionMatch = text.match(/"action"\s*:\s*"(buy_ce|buy_pe|sell_ce|sell_pe|BUY|SELL|buy|sell)"/i);
        if (actionMatch) {
          payload = { action: actionMatch[1].toUpperCase() };
        } else {
          const lower = text.toLowerCase();
          if (lower.includes("buy")) { payload = { action: "BUY" }; }
          else if (lower.includes("sell")) { payload = { action: "SELL" }; }
          else {
            logSignal(rawText.substring(0, 1000), { raw: text }, "invalid_json");
            return res.json({ status: "error", message: "Could not parse message. Send {\"action\":\"BUY\"} or plain text BUY/SELL" });
          }
        }
      }
    }
  }

  console.log(`[WEBHOOK] Parsed payload: ${JSON.stringify(payload)}`);

  const bodyToken = payload.token || payload.secret || "";
  if (!safeEqual(queryToken, webhookSecret) && !(bodyToken && safeEqual(bodyToken, webhookSecret))) {
    logSignal(rawText.substring(0, 1000), payload, "unauthorized");
    return res.json({ status: "error", message: "unauthorized" });
  }

  let action = String(payload.action || payload.side || payload.transaction_type || payload.data || payload.signal || "").toUpperCase().trim();

  let forcedOptionType = null;
  const actionLower = action.toLowerCase();
  if (actionLower === "buy_ce" || actionLower === "buyce" || actionLower === "ce") {
    action = "BUY"; forcedOptionType = "CE";
    console.log("[WEBHOOK] Detected BUY_CE alert — futures hedge: BUY futures + BUY OTM PE");
  } else if (actionLower === "buy_pe" || actionLower === "buype" || actionLower === "pe") {
    action = "BUY"; forcedOptionType = "PE";
    console.log("[WEBHOOK] Detected BUY_PE alert — futures hedge: SELL futures + BUY OTM CE");
  } else if (actionLower === "sell_ce" || actionLower === "sellce") {
    action = "SELL"; forcedOptionType = "CE";
    console.log("[WEBHOOK] Detected SELL_CE alert — exit futures ONLY (option stays)");
  } else if (actionLower === "sell_pe" || actionLower === "sellpe") {
    action = "SELL"; forcedOptionType = "PE";
    console.log("[WEBHOOK] Detected SELL_PE alert — exit futures ONLY (option stays)");
  }

  if (!["BUY", "SELL"].includes(action)) {
    logSignal(rawText.substring(0, 1000), payload, "invalid_action");
    return res.json({ status: "error", message: `invalid action: "${action}"` });
  }

  const killSwitch = getSetting("kill_switch", "off") === "on";
  if (killSwitch) {
    logSignal(rawText.substring(0, 1000), payload, "rejected_kill_switch");
    return res.json({ status: "rejected", reason: "kill_switch_active" });
  }
  if (isDuplicate(payload)) {
    logSignal(rawText.substring(0, 1000), payload, "duplicate");
    return res.json({ status: "duplicate" });
  }

  // ============================================================
  // LIGHTNING-FAST RESPONSE: Acknowledge TradingView IMMEDIATELY
  // TradingView cancels any webhook that doesn't respond within 3 seconds.
  // We respond in <1ms, then process the trade in the background.
  // ============================================================
  const signalId = `SIG_${Date.now()}`;
  const tcfg = getTradingConfig();
  res.status(200).json({ status: "accepted", signal_id: signalId, action: action, option_type: forcedOptionType, message: "Signal received — processing" });
  console.log(`[WEBHOOK] ⚡ Responded instantly — signal ${signalId} accepted, processing in background`);

  // Process the trade in the background (fire-and-forget)
  setImmediate(() => {
    processSignalInBackground(signalId, rawText, payload, action, forcedOptionType, tcfg).catch(e => {
      console.error(`[BG] Signal ${signalId} error:`, e.message);
      addLog("ERROR", `Signal ${signalId} failed: ${e.message}`);
    });
  });
  return;

}); // end of app.post("/webhook")

// ============================================================
// Background signal processor — runs AFTER TradingView gets 200 OK
// ============================================================
async function processSignalInBackground(signalId, rawText, payload, action, forcedOptionType, tcfg) {
  const hedgeId = `HEDGE_${Date.now()}`;
  const strikeOffset = parseInt(payload.strike_offset ?? tcfg.strike_offset ?? 2, 10);
  const { token, expiry } = await getToken();
  if (!token || Date.now() >= expiry) {
    console.log(`[BG] ${signalId}: No valid token`);
    logSignal(rawText.substring(0, 1000), payload, "no_token");
    addLog("ERROR", `Signal ${signalId}: No Upstox access token — click Request New Token`);
    return;
  }
  if (!isMarketOpen()) {
    console.log(`[BG] ${signalId}: Market closed`);
    logSignal(rawText.substring(0, 1000), payload, "market_closed");
    addLog("WARN", `Signal ${signalId}: Market is closed`);
    return;
  }

  // ============================================================
  // BUY + CE = buy_ce → BUY futures + BUY OTM PE
  // ============================================================
  if (action === "BUY" && forcedOptionType === "CE" && tcfg.futures_enabled) {
    try {
      console.log(`[HEDGE] buy_ce: BUY futures + BUY OTM PE (offset=${strikeOffset}), hedge_id=${hedgeId}`);
      const [futResult, spotResult] = await Promise.all([
        findFuturesContract(token, tcfg.underlying),
        getLTP(token, tcfg.underlying)
      ]);
      if (!futResult || !spotResult) {
        logSignal(rawText.substring(0, 1000), payload, "hedge_setup_failed");
        addLog("ERROR", `${signalId}: Could not find futures contract or fetch spot`); return;
      }
      const symbol = tcfg.underlying_name || "NIFTY";
      const strikeInterval = symbol.includes("BANK") ? 100 : 50;
      const atmStrike = Math.round(spotResult / strikeInterval) * strikeInterval;
      const peStrike = atmStrike - (strikeOffset * strikeInterval);
      console.log(`[HEDGE] Spot: ${spotResult}, ATM: ${atmStrike}, OTM PE strike: ${peStrike}`);
      const optResult = await getOptionContracts(token, tcfg.underlying, null);
      if (!optResult.ok) { addLog("ERROR", `${signalId}: Could not fetch option contracts`); return; }
      const allContracts = (optResult.data && optResult.data.data) || [];
      const expiries = [...new Set(allContracts.map(x => x.expiry))].sort();
      if (expiries.length === 0) { addLog("ERROR", `${signalId}: No option expiries`); return; }
      const nearestExpiry = expiries[0];
      let peContract = allContracts.find(x => x.expiry === nearestExpiry && x.instrument_type === "PE" && x.strike_price === peStrike);
      if (!peContract) {
        const typed = allContracts.filter(x => x.expiry === nearestExpiry && x.instrument_type === "PE");
        let closest = typed[0], minDiff = Math.abs(typed[0].strike_price - peStrike);
        for (const t of typed) { const d = Math.abs(t.strike_price - peStrike); if (d < minDiff) { minDiff = d; closest = t; } }
        peContract = closest;
      }
      const futQty = parseInt(tcfg.lots || 1, 10) * parseInt(futResult.lot_size || tcfg.lot_size || 65, 10);
      const optQty = parseInt(tcfg.lots || 1, 10) * parseInt(tcfg.lot_size || 65, 10);
      const legProduct = tcfg.product || "D";
      const [peLTP, futLTP] = await Promise.all([getLTP(token, peContract.instrument_key), getLTP(token, futResult.instrument_key)]);
      if (!peLTP || !futLTP) { addLog("ERROR", `${signalId}: Could not fetch LTP for hedge legs`); return; }

      // Check margin + funds IN PARALLEL (saves ~200-400ms)
      const [marginInfo, funds] = await Promise.all([
        getBasketMargin(token, [
          { instrument_key: futResult.instrument_key, quantity: futQty, transaction_type: "BUY", product: legProduct },
          { instrument_key: peContract.instrument_key, quantity: optQty, transaction_type: "BUY", product: legProduct }
        ]),
        getAvailableFunds(token)
      ]);
      if (marginInfo) {
        console.log(`[HEDGE] Margin: required=${marginInfo.required_margin}, final=${marginInfo.final_margin} (benefit: ${marginInfo.benefit})`);
        addLog("INFO", `Hedge margin: required ${marginInfo.required_margin}, after benefit ${marginInfo.final_margin} (save ${Math.round(marginInfo.benefit)})`);
      }
      console.log(`[HEDGE] Available funds: ${funds ? funds.available_margin : 'unknown'}`);
      console.log(`[HEDGE] Available funds: ${funds ? funds.available_margin : 'unknown'}`);
      if (funds && marginInfo && marginInfo.final_margin > funds.available_margin) {
        const shortfall = Math.ceil(marginInfo.final_margin - funds.available_margin);
        console.log(`[HEDGE] INSUFFICIENT FUNDS: need ${marginInfo.final_margin}, have ${funds.available_margin}, shortfall ${shortfall}`);
        logSignal(rawText.substring(0, 1000), payload, "hedge_insufficient_funds");
        addLog("ERROR", `Hedge rejected: need ${marginInfo.final_margin} margin, have ${funds.available_margin}. Add ${shortfall} to account.`);
        addLog("ERROR", `${signalId}: Insufficient funds — need ${marginInfo.final_margin}, have ${funds.available_margin}, add ${shortfall}`); return;
      }

      // Step 2: Place OPTION (hedge) FIRST — exchange registers hedge position
      console.log("[HEDGE] Step 1: Placing PE (hedge) order first...");
      const peOrder = await placeUpstoxOrder(token, { quantity: optQty, product: legProduct, validity: "DAY", order_type: "MARKET", transaction_type: "BUY", instrument_token: peContract.instrument_key, tag: "hedge_pe" });
      console.log(`[HEDGE] PE order: ${peOrder.ok ? "OK" : "FAILED"}`);
      if (!peOrder.ok) {
        logSignal(rawText.substring(0, 1000), payload, "hedge_pe_failed");
        addLog("ERROR", `${signalId}: PE hedge order failed. No futures placed`); return;
      }
      // Wait 1.5 seconds for exchange to register the hedge position
      await new Promise(r => setTimeout(r, 1500));
      console.log("[HEDGE] Step 2: Placing futures order (with hedge margin benefit)...");
      const futOrder = await placeUpstoxOrder(token, { quantity: futQty, product: legProduct, validity: "DAY", order_type: "MARKET", transaction_type: "BUY", instrument_token: futResult.instrument_key, tag: "hedge_fut" });
      console.log(`[HEDGE] Fut order: ${futOrder.ok ? "OK" : "FAILED"}`);
      if (!futOrder.ok) {
        console.log("[HEDGE] Futures FAILED — reversing PE leg immediately");
        const reversePe = await placeExitOrder(token, peContract.instrument_key, optQty, "SELL", legProduct);
        console.log(`[HEDGE] PE reversal: ${reversePe.ok ? "OK" : "FAILED"}`);
        if (!reversePe.ok) addLog("ERROR", `CRITICAL: PE reversal failed — manual exit needed for ${peContract.instrument_key}`);
        logSignal(rawText.substring(0, 1000), payload, "hedge_fut_failed");
        addLog("ERROR", `${signalId}: Futures order failed. PE reversed. Check funds.`); return;
      }

      // Track futures position
      db.prepare("INSERT INTO positions (instrument_token, transaction_type, quantity, entry_price, highest_price, lowest_price, added_at, exit_config, product, active, hedge_id, leg_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(futResult.instrument_key, "BUY", futQty, futLTP, futLTP, futLTP, Date.now(), JSON.stringify({ hedge_id: hedgeId, hedge_role: "futures", direction: "long" }), legProduct, hedgeId, "futures");
      // Track option position (stays for manual exit)
      db.prepare("INSERT INTO positions (instrument_token, transaction_type, quantity, entry_price, highest_price, lowest_price, added_at, exit_config, product, active, hedge_id, leg_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(peContract.instrument_key, "BUY", optQty, peLTP, peLTP, peLTP, Date.now(), JSON.stringify({ hedge_id: hedgeId, hedge_role: "option", option_type: "PE", strike: peContract.strike_price }), legProduct, hedgeId, "option");

      logSignal(rawText.substring(0, 1000), payload, "hedge_placed");
      logOrder("hedge", "BUY", futResult.instrument_key, futQty, futOrder.data, true);
      logOrder("hedge", "BUY", peContract.instrument_key, optQty, peOrder.data, true);
      addLog("INFO", `buy_ce hedge: BUY ${futQty} futures @ ${futLTP} + BUY ${optQty} PE @ ${peLTP} (strike ${peContract.strike_price}), hedge_id=${hedgeId}`);
      addLog("INFO", `${signalId}: ✅ buy_ce hedge placed — BUY ${futQty} futures @ ${futLTP} + BUY ${optQty} PE @ ${peLTP} (strike ${peContract.strike_price})`); return;
    } catch (e) {
      console.error("[HEDGE] buy_ce error:", e.message);
      logSignal(rawText.substring(0, 1000), payload, "hedge_error");
      addLog("ERROR", `${signalId}: Hedge error: ${e.message}`); return;
    }
  }

  // ============================================================
  // SELL + CE = sell_ce → SELL futures ONLY (option stays)
  // ============================================================
  if (action === "SELL" && forcedOptionType === "CE" && tcfg.futures_enabled) {
    try {
      const futPos = db.prepare("SELECT * FROM positions WHERE active = 1 AND leg_type = 'futures' AND json_extract(exit_config, '$.direction') = 'long'").all();
      if (futPos.length === 0) {
        logSignal(rawText.substring(0, 1000), payload, "sell_rejected_no_futures");
        addLog("WARN", `${signalId}: No active long futures to exit`); return;
      }
      const pos = futPos[0];
      const exitResult = await placeExitOrder(token, pos.instrument_token, pos.quantity, "SELL", pos.product || "D");
      if (exitResult.ok) {
        db.prepare("UPDATE positions SET active = 0 WHERE id = ?").run(pos.id);
        logSignal(rawText.substring(0, 1000), payload, "futures_exited");
        logOrder("hedge_exit", "SELL", pos.instrument_token, pos.quantity, exitResult.data, true);
        addLog("INFO", `sell_ce: Closed futures ${pos.instrument_token} qty ${pos.quantity}. Option stays for manual exit.`);
        addLog("INFO", `${signalId}: ✅ sell_ce — futures closed. Option stays for manual exit.`); return;
      }
      logSignal(rawText.substring(0, 1000), payload, "futures_exit_failed");
      addLog("ERROR", `${signalId}: Failed to exit futures`); return;
    } catch (e) {
      console.error("[HEDGE] sell_ce error:", e.message);
      addLog("ERROR", `${signalId}: Exit error: ${e.message}`); return;
    }
  }

  // ============================================================
  // BUY + PE = buy_pe → SELL futures + BUY OTM CE
  // ============================================================
  if (action === "BUY" && forcedOptionType === "PE" && tcfg.futures_enabled) {
    try {
      console.log(`[HEDGE] buy_pe: SELL futures + BUY OTM CE (offset=${strikeOffset}), hedge_id=${hedgeId}`);
      const [futResult, spotResult] = await Promise.all([
        findFuturesContract(token, tcfg.underlying),
        getLTP(token, tcfg.underlying)
      ]);
      if (!futResult || !spotResult) {
        logSignal(rawText.substring(0, 1000), payload, "hedge_setup_failed");
        addLog("ERROR", `${signalId}: Could not find futures contract or fetch spot`); return;
      }
      const symbol = tcfg.underlying_name || "NIFTY";
      const strikeInterval = symbol.includes("BANK") ? 100 : 50;
      const atmStrike = Math.round(spotResult / strikeInterval) * strikeInterval;
      const ceStrike = atmStrike + (strikeOffset * strikeInterval);
      console.log(`[HEDGE] Spot: ${spotResult}, ATM: ${atmStrike}, OTM CE strike: ${ceStrike}`);
      const optResult = await getOptionContracts(token, tcfg.underlying, null);
      if (!optResult.ok) { addLog("ERROR", `${signalId}: Could not fetch option contracts`); return; }
      const allContracts = (optResult.data && optResult.data.data) || [];
      const expiries = [...new Set(allContracts.map(x => x.expiry))].sort();
      if (expiries.length === 0) { addLog("ERROR", `${signalId}: No option expiries`); return; }
      const nearestExpiry = expiries[0];
      let ceContract = allContracts.find(x => x.expiry === nearestExpiry && x.instrument_type === "CE" && x.strike_price === ceStrike);
      if (!ceContract) {
        const typed = allContracts.filter(x => x.expiry === nearestExpiry && x.instrument_type === "CE");
        let closest = typed[0], minDiff = Math.abs(typed[0].strike_price - ceStrike);
        for (const t of typed) { const d = Math.abs(t.strike_price - ceStrike); if (d < minDiff) { minDiff = d; closest = t; } }
        ceContract = closest;
      }
      const futQty = parseInt(tcfg.lots || 1, 10) * parseInt(futResult.lot_size || tcfg.lot_size || 65, 10);
      const optQty = parseInt(tcfg.lots || 1, 10) * parseInt(tcfg.lot_size || 65, 10);
      const legProduct = tcfg.product || "D";
      const [ceLTP, futLTP] = await Promise.all([getLTP(token, ceContract.instrument_key), getLTP(token, futResult.instrument_key)]);
      if (!ceLTP || !futLTP) { addLog("ERROR", `${signalId}: Could not fetch LTP for hedge legs`); return; }

      const [marginInfo, funds] = await Promise.all([
        getBasketMargin(token, [
          { instrument_key: futResult.instrument_key, quantity: futQty, transaction_type: "SELL", product: legProduct },
          { instrument_key: ceContract.instrument_key, quantity: optQty, transaction_type: "BUY", product: legProduct }
        ]),
        getAvailableFunds(token)
      ]);
      if (funds && marginInfo && marginInfo.final_margin > funds.available_margin) {
        const shortfall = Math.ceil(marginInfo.final_margin - funds.available_margin);
        console.log(`[HEDGE] INSUFFICIENT FUNDS: need ${marginInfo.final_margin}, have ${funds.available_margin}`);
        logSignal(rawText.substring(0, 1000), payload, "hedge_insufficient_funds");
        addLog("ERROR", `Hedge rejected: need ${marginInfo.final_margin}, have ${funds.available_margin}. Add ${shortfall}.`);
        addLog("ERROR", `${signalId}: Insufficient funds — need ${marginInfo.final_margin}, have ${funds.available_margin}, add ${shortfall}`); return;
      }
      if (marginInfo) {
        console.log(`[HEDGE] Margin: required=${marginInfo.required_margin}, final=${marginInfo.final_margin} (benefit: ${marginInfo.benefit})`);
        addLog("INFO", `Hedge margin: required ${marginInfo.required_margin}, after benefit ${marginInfo.final_margin} (save ${Math.round(marginInfo.benefit)})`);
      }

      // Place CE (hedge) FIRST, then futures
      console.log("[HEDGE] Step 1: Placing CE (hedge) order first...");
      const ceOrder = await placeUpstoxOrder(token, { quantity: optQty, product: legProduct, validity: "DAY", order_type: "MARKET", transaction_type: "BUY", instrument_token: ceContract.instrument_key, tag: "hedge_ce" });
      console.log(`[HEDGE] CE order: ${ceOrder.ok ? "OK" : "FAILED"}`);
      if (!ceOrder.ok) {
        logSignal(rawText.substring(0, 1000), payload, "hedge_ce_failed");
        addLog("ERROR", `${signalId}: CE hedge order failed. No futures placed`); return;
      }
      await new Promise(r => setTimeout(r, 1500));
      console.log("[HEDGE] Step 2: Placing futures order (with hedge margin benefit)...");
      const futOrder = await placeUpstoxOrder(token, { quantity: futQty, product: legProduct, validity: "DAY", order_type: "MARKET", transaction_type: "SELL", instrument_token: futResult.instrument_key, tag: "hedge_fut" });
      console.log(`[HEDGE] Fut order: ${futOrder.ok ? "OK" : "FAILED"}`);
      if (!futOrder.ok) {
        console.log("[HEDGE] Futures FAILED — reversing CE leg immediately");
        const reverseCe = await placeExitOrder(token, ceContract.instrument_key, optQty, "SELL", legProduct);
        if (!reverseCe.ok) addLog("ERROR", `CRITICAL: CE reversal failed — manual exit needed for ${ceContract.instrument_key}`);
        logSignal(rawText.substring(0, 1000), payload, "hedge_fut_failed");
        addLog("ERROR", `${signalId}: Futures order failed. CE reversed. Check funds.`); return;
      }

      db.prepare("INSERT INTO positions (instrument_token, transaction_type, quantity, entry_price, highest_price, lowest_price, added_at, exit_config, product, active, hedge_id, leg_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(futResult.instrument_key, "SELL", futQty, futLTP, futLTP, futLTP, Date.now(), JSON.stringify({ hedge_id: hedgeId, hedge_role: "futures", direction: "short" }), legProduct, hedgeId, "futures");
      db.prepare("INSERT INTO positions (instrument_token, transaction_type, quantity, entry_price, highest_price, lowest_price, added_at, exit_config, product, active, hedge_id, leg_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(ceContract.instrument_key, "BUY", optQty, ceLTP, ceLTP, ceLTP, Date.now(), JSON.stringify({ hedge_id: hedgeId, hedge_role: "option", option_type: "CE", strike: ceContract.strike_price }), legProduct, hedgeId, "option");

      logSignal(rawText.substring(0, 1000), payload, "hedge_placed");
      logOrder("hedge", "SELL", futResult.instrument_key, futQty, futOrder.data, true);
      logOrder("hedge", "BUY", ceContract.instrument_key, optQty, ceOrder.data, true);
      addLog("INFO", `buy_pe hedge: SELL ${futQty} futures @ ${futLTP} + BUY ${optQty} CE @ ${ceLTP} (strike ${ceContract.strike_price}), hedge_id=${hedgeId}`);
      addLog("INFO", `${signalId}: ✅ buy_pe hedge placed — SELL ${futQty} futures @ ${futLTP} + BUY ${optQty} CE @ ${ceLTP} (strike ${ceContract.strike_price})`); return;
    } catch (e) {
      console.error("[HEDGE] buy_pe error:", e.message);
      logSignal(rawText.substring(0, 1000), payload, "hedge_error");
      addLog("ERROR", `${signalId}: Hedge error: ${e.message}`); return;
    }
  }

  // ============================================================
  // SELL + PE = sell_pe → BUY BACK futures ONLY (option stays)
  // ============================================================
  if (action === "SELL" && forcedOptionType === "PE" && tcfg.futures_enabled) {
    try {
      const futPos = db.prepare("SELECT * FROM positions WHERE active = 1 AND leg_type = 'futures' AND json_extract(exit_config, '$.direction') = 'short'").all();
      if (futPos.length === 0) {
        logSignal(rawText.substring(0, 1000), payload, "sell_rejected_no_futures");
        addLog("WARN", `${signalId}: No active short futures to exit`); return;
      }
      const pos = futPos[0];
      const exitResult = await placeExitOrder(token, pos.instrument_token, pos.quantity, "BUY", pos.product || "D");
      if (exitResult.ok) {
        db.prepare("UPDATE positions SET active = 0 WHERE id = ?").run(pos.id);
        logSignal(rawText.substring(0, 1000), payload, "futures_exited");
        logOrder("hedge_exit", "BUY", pos.instrument_token, pos.quantity, exitResult.data, true);
        addLog("INFO", `sell_pe: Closed short futures ${pos.instrument_token} qty ${pos.quantity}. Option stays for manual exit.`);
        addLog("INFO", `${signalId}: ✅ sell_pe — short futures closed. Option stays for manual exit.`); return;
      }
      logSignal(rawText.substring(0, 1000), payload, "futures_exit_failed");
      addLog("ERROR", `${signalId}: Failed to exit futures`); return;
    } catch (e) {
      console.error("[HEDGE] sell_pe error:", e.message);
      addLog("ERROR", `${signalId}: Exit error: ${e.message}`); return;
    }
  }

  // ============================================================
  // Plain BUY/SELL (no CE/PE suffix) — original option-only behavior
  // ============================================================
  // Auto Trade (option-only) check — if futures hedge is OFF, auto must be ON
  if (forcedOptionType && !tcfg.futures_enabled && !tcfg.auto_enabled) {
    logSignal(rawText.substring(0, 1000), payload, "rejected_both_off");
    addLog("WARN", `${signalId}: Both Auto Trade and Futures Hedge are OFF`); return;
  }
  const payloadInstrument = payload.instrument_token || payload.ticker || payload.symbol || payload.instrument_key || "";
  let instrumentToken, quantity, entryPrice;
  let legProduct = "D";
  let legOptionType = forcedOptionType;

  if (payloadInstrument) {
    instrumentToken = payloadInstrument;
    quantity = parseInt(payload.quantity ?? payload.qty ?? payload.contracts ?? 1, 10);
    entryPrice = await getLTP(token, instrumentToken);
    console.log(`[WEBHOOK] Mode 1: Direct instrument ${instrumentToken}, qty ${quantity}`);
  } else {
    const tcfg2 = getTradingConfig();
    if (!legOptionType) legOptionType = tcfg2.option_type || "CE";
    let legLots = 1;
    if (legOptionType === "CE") {
      legLots = tcfg2.ce_lots ?? tcfg2.lots ?? 1;
      legProduct = tcfg2.ce_product ?? tcfg2.product ?? "D";
    } else {
      legLots = tcfg2.pe_lots ?? tcfg2.lots ?? 1;
      legProduct = tcfg2.pe_product ?? tcfg2.product ?? "D";
    }
    console.log(`[WEBHOOK] Mode 2: Auto-ATM for ${tcfg2.underlying_name} ${legOptionType} (leg: ${legLots} lots, ${legProduct})`);
    const atm = await calculateATM(token, tcfg2.underlying, legOptionType, null);
    if (!atm) {
      logSignal(rawText.substring(0, 1000), payload, "atm_calc_failed");
      addLog("ERROR", `${signalId}: Failed to calculate ATM strike`); return;
    }
    instrumentToken = atm.instrument_key;
    quantity = parseInt(legLots, 10) * parseInt(tcfg2.lot_size, 10);
    entryPrice = await getLTP(token, atm.instrument_key);
    if (!entryPrice) { entryPrice = atm.spot; }
    payload.product = legProduct;
    console.log(`[WEBHOOK] ATM: ${atm.atm_strike} ${legOptionType} (spot ${atm.spot}), token ${instrumentToken}, qty ${quantity}`);
  }

  // SELL safety guard for plain SELL (not sell_ce/sell_pe)
  let matchingPosition = null;
  if (action === "SELL") {
    const activePositions = db.prepare("SELECT * FROM positions WHERE active = 1").all();
    if (legOptionType) {
      matchingPosition = activePositions.find(p => {
        if (p.transaction_type !== "BUY") return false;
        try {
          const ec = p.exit_config ? JSON.parse(p.exit_config) : {};
          if (ec.option_type) return ec.option_type === legOptionType;
        } catch(e) {}
        return p.instrument_token && p.instrument_token.includes(legOptionType);
      });
    } else {
      matchingPosition = activePositions.find(p => p.transaction_type === "BUY");
    }
    if (!matchingPosition) {
      console.log("[WEBHOOK] SELL rejected — no open BUY position to exit");
      logSignal(rawText.substring(0, 1000), payload, "sell_rejected_no_position");
      addLog("WARN", `${signalId}: No open position to exit`); return;
    }
    if (!payloadInstrument) {
      instrumentToken = matchingPosition.instrument_token;
      quantity = matchingPosition.quantity;
    }
  }

  let result;
  try {
    result = await placeUpstoxOrder(token, {
      quantity, product: (matchingPosition ? (matchingPosition.product || "D") : (payload.product || "D")), validity: payload.validity, price: payload.price,
      order_type: payload.order_type || "MARKET", transaction_type: action, instrument_token: instrumentToken,
    });
  } catch (err) {
    logSignal(rawText.substring(0, 1000), payload, "order_api_error");
    addLog("ERROR", `${signalId}: Upstox API failed: ${err.message}`); return;
  }

  logSignal(rawText.substring(0, 1000), payload, result.ok ? "order_placed" : "order_failed");
  logOrder(action === "SELL" ? "exit" : "entry", action, instrumentToken, quantity, result.data, result.ok);
  if (result.ok) { addLog("INFO", `${signalId}: ✅ Order placed — ${action} ${quantity} ${instrumentToken}`); } else { addLog("ERROR", `${signalId}: ❌ Order failed — ${JSON.stringify(result.data).substring(0, 200)}`); }

  // Position tracking for plain BUY
  if (result.ok && action !== "SELL") {
    try {
      const orderId = result.data?.data?.order_ids?.[0];
      let actualFillPrice = null;
      if (orderId) { actualFillPrice = await getOrderFillPrice(token, orderId); }
      const ltp = actualFillPrice || entryPrice || 0;
      const posExit = {};
      if (legOptionType) posExit.option_type = legOptionType;
      db.prepare("INSERT INTO positions (instrument_token, transaction_type, quantity, entry_price, highest_price, lowest_price, added_at, exit_config, product, active, hedge_id, leg_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)")
        .run(instrumentToken, action, quantity, ltp, ltp, ltp, Date.now(), JSON.stringify(posExit), legProduct || "D");
      console.log(`[WEBHOOK] Position tracked: ${instrumentToken} qty=${quantity} product=${legProduct || "D"}`);
    } catch (trackErr) {
      console.error("[WEBHOOK] Position tracking error:", trackErr.message);
    }
  }

  if (result.ok && action === "SELL" && matchingPosition) {
    db.prepare("UPDATE positions SET active = 0 WHERE id = ?").run(matchingPosition.id);
    addLog("INFO", `SELL webhook: Position ${matchingPosition.instrument_token} qty ${matchingPosition.quantity} closed`);
  }
} // end of processSignalInBackground



// Notifier — receives access token from Upstox after user approves
app.post("/notifier", (req, res) => {
  // Log ALL incoming notifier requests for debugging
  const rawBody = JSON.stringify(req.body);
  console.log(`[NOTIFIER] Received POST: ${rawBody.substring(0, 500)}`);
  addLog("INFO", `Notifier received: ${rawBody.substring(0, 300)}`);

  const body = req.body;
  if (!body) {
    console.log("[NOTIFIER] Empty body — rejecting");
    return res.status(400).json({ error: "empty body" });
  }

  // Check if this is an access token delivery
  if (body.message_type !== "access_token" || !body.access_token) {
    console.log(`[NOTIFIER] Unexpected payload type: ${body.message_type || "unknown"}`);
    // Still return 200 so Upstox doesn't retry
    return res.status(200).json({ status: "ignored", reason: "not an access_token message" });
  }

  // Store the token — don't reject on client_id mismatch, just log it
  const storedClientId = getSetting("UPSTOX_CLIENT_ID", "");
  if (storedClientId && body.client_id && body.client_id !== storedClientId) {
    console.log(`[NOTIFIER] Client ID mismatch: got ${body.client_id}, expected ${storedClientId}`);
    addLog("WARN", `Notifier client_id mismatch: got ${body.client_id}, expected ${storedClientId}`);
    // Store it anyway — the token is still valid
  }

  const expiresAt = body.expires_at ? parseInt(body.expires_at, 10) : 0;
  setSetting("access_token", body.access_token);
  setSetting("access_token_expiry", String(expiresAt));
  // Clear all caches on new token
  _optionContractsCache = {};
  console.log(`[NOTIFIER] Access token stored! Expires at: ${new Date(expiresAt).toISOString()}`);
  console.log(`[NOTIFIER] All caches cleared — fresh start`);
  addLog("INFO", `Access token stored, expires at ${new Date(expiresAt).toISOString()}`);
  addLog("INFO", `Caches cleared on new token`);
  // Clear old error signals from previous token session
  try { db.prepare("DELETE FROM signals WHERE status = 'order_api_error'").run(); console.log("[NOTIFIER] Old error signals cleared"); } catch(e) {}
  res.status(200).json({ status: "token_stored", expires_at: expiresAt });
});

// --- API Routes ---
app.get("/api/token-status", (req, res) => {
  const token = getSetting("access_token", "");
  const expiry = parseInt(getSetting("access_token_expiry", "0"), 10);
  res.json({
    has_token: !!token, expires_at: expiry || null,
    is_expired: token ? Date.now() >= expiry : null,
    kill_switch: getSetting("kill_switch", "off") === "on",
  });
});

// --- Debug endpoint to check token status (masked) ---
app.get("/api/debug-token", (req, res) => {
  const token = getSetting("access_token", "");
  const expiry = parseInt(getSetting("access_token_expiry", "0"), 10);
  res.json({
    token_present: !!token,
    token_length: token.length,
    token_preview: token ? token.substring(0, 15) + "..." + token.substring(token.length - 5) : "(empty)",
    token_expiry: expiry,
    token_expiry_iso: expiry ? new Date(expiry).toISOString() : null,
    is_expired: token ? Date.now() >= expiry : null,
    current_time: new Date().toISOString(),
    current_time_ms: Date.now(),
  });
});

app.post("/api/request-token", async (req, res) => {
  try {
    const result = await requestAccessToken();
    res.json(result);
  } catch (err) {
    addLog("ERROR", "Token request exception: " + err.message);
    res.json({ ok: false, status: 0, data: { error: "exception", message: err.message } });
  }
});

app.get("/api/signals", (req, res) => {
  const rows = db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT 50").all();
  res.json(rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : {} })));
});

app.get("/api/orders", (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 50").all();
  res.json(rows.map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : {} })));
});

app.get("/api/positions", (req, res) => {
  const rows = db.prepare("SELECT * FROM positions WHERE active = 1 ORDER BY id DESC").all();
  res.json(rows.map(r => ({ ...r, exit_config: r.exit_config ? JSON.parse(r.exit_config) : null })));
});

app.get("/api/upstox-positions", async (req, res) => {
  res.json(await getUpstoxPositions());
});

// --- Manual exit position — places a SELL order and marks position closed ---
app.post("/api/exit-position", async (req, res) => {
  try {
    const posId = req.body.id;
    if (!posId) return res.json({ ok: false, error: "missing position id" });
    const pos = db.prepare("SELECT * FROM positions WHERE id = ? AND active = 1").get(posId);
    if (!pos) return res.json({ ok: false, error: "position not found or already closed" });
    const { token, expiry } = await getToken();
    if (!token || Date.now() >= expiry) return res.json({ ok: false, error: "no Upstox access token" });
    const exitAction = pos.transaction_type === "BUY" ? "SELL" : "BUY";
    const result = await placeUpstoxOrder(token, {
      quantity: pos.quantity, product: pos.product || "D", validity: "DAY",
      order_type: "MARKET", transaction_type: exitAction, instrument_token: pos.instrument_token,
    });
    if (result.ok) {
      db.prepare("UPDATE positions SET active = 0 WHERE id = ?").run(posId);
      logOrder("exit", exitAction, pos.instrument_token, pos.quantity, result.data, true);
      addLog("INFO", `Manual exit: ${pos.instrument_token} qty ${pos.quantity} (${exitAction})`);
      res.json({ ok: true, message: "Exit order placed" });
    } else {
      logOrder("exit", exitAction, pos.instrument_token, pos.quantity, result.data, false);
      res.json({ ok: false, error: JSON.stringify(result.data || result) });
    }
  } catch (err) {
    console.error("[EXIT] Error:", err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.post("/api/manual-order", async (req, res) => {
  const body = req.body;
  if (!body.instrument_token || !["BUY", "SELL"].includes(body.action)) return res.json({ error: "missing fields" });
  const { token, expiry } = await getToken();
  if (!token || Date.now() >= expiry) return res.json({ error: "no_access_token" });
  if (getSetting("kill_switch", "off") === "on") return res.json({ error: "kill_switch_active" });
  if (!isMarketOpen()) return res.json({ error: "market_closed", message: "Market is closed. Orders can only be placed during market hours (9:15 AM – 3:30 PM IST)." });

  const result = await placeUpstoxOrder(token, {
    quantity: parseInt(body.quantity || 1), product: body.product || "D",
    order_type: body.order_type || "MARKET", transaction_type: body.action,
    instrument_token: body.instrument_token, price: body.price,
  });
  logOrder("manual", body.action, body.instrument_token, body.quantity, result.data, result.ok);

  if (result.ok) {
    const config = getExitConfig();
    const hasExit = (config.enabled && config.mode !== "none") || body.exit_target_points || body.exit_sl_points;
    if (hasExit) {
      const entryPrice = await getLTP(token, body.instrument_token);
      const posExit = {};
      if (body.exit_target_points) { posExit.mode = "fixed_sl_target"; posExit.fixed_target_points = body.exit_target_points; }
      if (body.exit_sl_points) { posExit.fixed_sl_points = body.exit_sl_points; }
      db.prepare(`INSERT INTO positions (instrument_token, transaction_type, quantity, entry_price, highest_price, lowest_price, added_at, exit_config, product, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(body.instrument_token, body.action, body.quantity, entryPrice || 0, entryPrice || 0, entryPrice || 0, Date.now(), JSON.stringify(posExit));
    }
  }
  res.json({ ok: result.ok, result: result.data });
});

app.post("/api/kill-switch", (req, res) => {
  const action = req.body.action || "toggle";
  let isOn;
  if (action === "on") isOn = true;
  else if (action === "off") isOn = false;
  else isOn = getSetting("kill_switch", "off") !== "on";
  setSetting("kill_switch", isOn ? "on" : "off");
  res.json({ kill_switch: isOn ? "on" : "off" });
});

app.get("/api/exit-config", (req, res) => res.json(getExitConfig()));

app.post("/api/exit-config", (req, res) => {
  const merged = { ...DEFAULT_EXIT_CONFIG, ...req.body };
  setSetting("exit_config", JSON.stringify(merged));
  console.log(`[EXIT] Exit config saved`);
  res.json({ status: "saved", config: merged });
});

app.get("/api/settings", (req, res) => {
  res.json({
    webhook_secret: getSetting("WEBHOOK_SECRET") ? "***set***" : "",
    upstox_client_id: getSetting("UPSTOX_CLIENT_ID", ""),
    upstox_client_secret: getSetting("UPSTOX_CLIENT_SECRET") ? "***set***" : "",
    has_webhook_secret: !!getSetting("WEBHOOK_SECRET"),
    has_client_id: !!getSetting("UPSTOX_CLIENT_ID"),
    has_client_secret: !!getSetting("UPSTOX_CLIENT_SECRET"),
  });
});

app.post("/api/settings", (req, res) => {
  if (req.body.upstox_client_id) setSetting("UPSTOX_CLIENT_ID", req.body.upstox_client_id);
  if (req.body.upstox_client_secret) setSetting("UPSTOX_CLIENT_SECRET", req.body.upstox_client_secret);
  if (req.body.webhook_secret) setSetting("WEBHOOK_SECRET", req.body.webhook_secret);
    if (req.body.dash_pass) setSetting("DASHBOARD_PASSWORD", req.body.dash_pass);
  _optionContractsCache = {};
  console.log(`[SETTINGS] Settings saved, caches cleared`);
  res.json({ status: "saved" });
});

app.get("/api/instruments", (req, res) => res.json({ instruments: UNDERLYING }));

// --- Trading Config API ---
app.get("/api/trading-config", (req, res) => res.json(getTradingConfig()));

app.post("/api/trading-config", (req, res) => {
  const current = getTradingConfig();
  const updated = { ...current, ...req.body };
  setSetting("trading_config", JSON.stringify(updated));
  _optionContractsCache = {};
  console.log(`[CONFIG] Trading config saved: ${JSON.stringify(updated)}`);
  console.log(`[CONFIG] Option contracts cache cleared`);
  res.json({ status: "saved", config: updated });
});

app.get("/api/option-expiries", async (req, res) => {
  const { token, expiry } = await getToken();
  if (!token || Date.now() >= expiry) return res.json({ error: "no_token" });
  const result = await getOptionContracts(token, req.query.instrument_key, null);
  if (!result.ok) return res.json({ error: "failed", detail: result.data });
  const contracts = (result.data && result.data.data) || [];
  const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
  res.json({ expiries });
});

app.get("/api/atm-strike", async (req, res) => {
  const { token, expiry } = await getToken();
  if (!token || Date.now() >= expiry) return res.json({ error: "no_token" });
  const spot = await getLTP(token, req.query.instrument_key);
  if (!spot) return res.json({ error: "could not fetch spot" });
  const result = await getOptionContracts(token, req.query.instrument_key, req.query.expiry_date);
  if (!result.ok) return res.json({ error: "failed", detail: result.data });
  const contracts = (result.data && result.data.data) || [];
  const optionType = (req.query.type || "CE").toUpperCase();
  const typed = contracts.filter(c => c.instrument_type === optionType);
  if (typed.length === 0) return res.json({ error: `no ${optionType} contracts` });
  let atm = typed[0], minDiff = Math.abs(typed[0].strike_price - spot);
  for (const c of typed) {
    const d = Math.abs(c.strike_price - spot);
    if (d < minDiff) { minDiff = d; atm = c; }
  }
  const optionLTP = await getLTP(token, atm.instrument_key);
  res.json({ spot_price: spot, atm_strike: atm.strike_price, instrument_key: atm.instrument_key, trading_symbol: atm.trading_symbol, lot_size: atm.lot_size, ltp: optionLTP });
});

// Upstox OAuth redirect handler — receives the authorization code
// Upstox redirects here after user approves login. We show a simple page
// so the redirect_uri validation passes. The semi-automated flow doesn't
// actually use this code, but it must exist and return 200.
app.get("/callback", (req, res) => {
  const code = req.query.code || "";
  const state = req.query.state || "";
  if (code) {
    addLog("INFO", "OAuth callback received with authorization code");
    res.send(`<html><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:40px;text-align:center">
      <h2 style="color:#3fb950">✅ Authorization Successful</h2>
      <p>You can close this page and return to the dashboard.</p>
      <p><a href="/" style="color:#58a6ff">Go to Dashboard →</a></p>
    </body></html>`);
  } else {
    res.send(`<html><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:40px;text-align:center">
      <h2 style="color:#d29922">⚠ No authorization code received</h2>
      <p><a href="/" style="color:#58a6ff">Go to Dashboard →</a></p>
    </body></html>`);
  }
});

app.get("/health", (req, res) => {
  const token = getSetting("access_token", "");
  const expiry = parseInt(getSetting("access_token_expiry", "0"), 10);
  res.json({ status: "ok", token_present: !!token, token_expired: token ? Date.now() >= expiry : null, kill_switch: getSetting("kill_switch", "off") === "on", market_open: isMarketOpen() });
});

// --- Dashboard HTML ---
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>Horse Engine — Dashboard</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--green:#3fb950;--red:#f85149;--amber:#d29922;--blue:#58a6ff;--green-bg:rgba(63,185,80,0.1);--red-bg:rgba(248,81,73,0.1);--amber-bg:rgba(210,153,34,0.1)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:20px;max-width:1300px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:4px}
h2{font-size:1.1rem;margin-bottom:10px;color:var(--blue)}
.subtitle{color:#8b949e;font-size:0.85rem;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}
.status-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:0.9rem}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.green{background:var(--green)}.dot.red{background:var(--red)}
.badge{padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600}
.badge.green{background:var(--green-bg);color:var(--green)}.badge.red{background:var(--red-bg);color:var(--red)}.badge.amber{background:var(--amber-bg);color:var(--amber)}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:600}
.btn-primary{background:var(--blue);color:#fff}.btn-success{background:var(--green);color:#fff}.btn-secondary{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.btn:hover{opacity:.85}
input,select{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:6px;font-size:0.85rem;width:100%}
label{font-size:0.8rem;color:#8b949e;display:block;margin-bottom:4px}
.form-row{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.form-row>div{flex:1;min-width:120px}
table{width:100%;border-collapse:collapse;font-size:0.8rem}
th{text-align:left;padding:6px 8px;color:#8b949e;border-bottom:1px solid var(--border);font-weight:600}
td{padding:6px 8px;border-bottom:1px solid var(--border)}
.toggle{position:relative;width:44px;height:24px}
.toggle input{opacity:0;width:0;height:0}
.toggle .slider{position:absolute;cursor:pointer;inset:0;background:var(--border);border-radius:24px;transition:.2s}
.toggle .slider:before{content:"";position:absolute;height:18px;width:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked+.slider{background:var(--green)}
.toggle input:checked+.slider:before{transform:translateX(20px)}
.tlight{display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:6px;vertical-align:middle;transition:background .2s,box-shadow .2s}
.tlight.on{background:#22c55e;box-shadow:0 0 6px #22c55e}
.tlight.off{background:#ef4444;box-shadow:0 0 6px #ef4444}
.tab-row{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
.tab{padding:6px 14px;border-radius:6px 6px 0 0;cursor:pointer;font-size:0.85rem;border:1px solid var(--border);background:var(--surface)}
.tab.active{background:var(--blue);color:#fff;border-color:var(--blue)}
.hidden{display:none}
.muted{color:#8b949e;font-size:0.8rem}
.pill{display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.7rem}
.pill.buy{background:var(--green-bg);color:var(--green)}.pill.sell{background:var(--red-bg);color:var(--red)}
.killed-banner{background:var(--red);color:#fff;padding:8px 16px;border-radius:6px;text-align:center;margin-bottom:16px;font-weight:600}
#toast{position:fixed;bottom:20px;right:20px;background:var(--surface);border:1px solid var(--border);padding:12px 16px;border-radius:8px;z-index:999;display:none;max-width:400px}
.json-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:monospace;font-size:0.8rem;white-space:pre-wrap;word-break:break-all;margin:10px 0}
.section-divider{border-top:1px solid var(--border);margin:14px 0;padding-top:10px}
.raw-msg{max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:0.75rem;color:#8b949e}
</style>
</head>
<body>
<h1>🐎 Horse Engine <span style="font-size:0.5em;color:var(--green);vertical-align:middle;">● LIVE</span></h1>
<p class="subtitle">VPS Edition v27.1</p>
<div id="killBanner" class="hidden killed-banner">⚠ BOT OFF — all incoming signals are blocked</div>
  </div>

<div class="grid">
  <div class="card"><h2>Token Status</h2>
    <div class="status-row"><span id="tokenDot" class="dot red"></span> <span id="tokenText">Checking...</span></div>
    <div class="status-row muted">Market: <span id="marketStatus">—</span></div>
    <button class="btn btn-primary" onclick="requestToken()" id="tokenBtn">Request New Token</button>
  </div>
  <div class="card"><h2>On / Off</h2>
    <div class="status-row"><label class="toggle"><input type="checkbox" id="killToggle" onchange="toggleKillSwitch()"><span class="slider"></span></label><span id="killText" style="margin-left:8px;">OFF</span><span class="tlight off" id="killLight"></span></div>
    <p class="muted">When ON, all signals are rejected.</p>
  </div>
</div>
<div class="tab-row">
  <div class="tab" onclick="showTab('builder',this)" style="display:none">📋 Order Builder</div>
  <div class="tab active" onclick="showTab('auto',this)">🤖 Auto Trade Config</div>
  <div class="tab" onclick="showTab('strategy',this)" style="display:none">📈 Strategy Engine</div>
  <div class="tab" onclick="showTab('backtest',this)" style="display:none">🧪 Backtest</div>
  <div class="tab" onclick="showTab('signals',this)">Signals</div>
  <div class="tab" onclick="showTab('orders',this)">Orders</div>
  <div class="tab" onclick="showTab('positions',this)">Positions</div>
  
  <div class="tab" onclick="showTab('futures',this)">📊 Futures Hedge</div>
  <div class="tab" onclick="showTab('settings',this)">⚙️ Settings</div>
</div>

<div id="tab-builder" class="card hidden">
  <h2>Order Builder — ATM Auto-Select</h2>
  <p class="muted" style="margin-bottom:12px;">Select instrument & expiry. Auto-selects ATM strike.</p>
  <div class="form-row">
    <div style="flex:2"><label>1. Underlying</label><select id="obInstrument" onchange="onInstrumentChange()"><option value="">— Select —</option></select></div>
    <div><label>2. Action</label><select id="obAction"><option value="BUY">BUY</option><option value="SELL">SELL</option></select></div>
  </div>
  <div class="form-row">
    <div><label>3. Expiry</label><select id="obExpiry" onchange="onExpiryChange()" disabled><option value="">Select instrument first</option></select></div>
    <div><label>4. Type</label><select id="obOptionType" onchange="onExpiryChange()"><option value="CE">CE (Call)</option><option value="PE">PE (Put)</option></select></div>
    <div><label>5. Lots</label><input id="obLots" type="number" value="1" min="1" onchange="updateJSON()"></div>
    <div><label>Qty</label><input id="obQty" type="number" readonly style="opacity:.6"></div>
  </div>
  <div id="atmInfo" class="hidden" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px;">
    <div class="status-row"><span class="dot green"></span> <b>ATM:</b> <span id="atmStrike">—</span> &nbsp; <b>Spot:</b> <span id="atmSpot">—</span> &nbsp; <b>LTP:</b> ₹<span id="atmLtp">—</span></div>
  </div>
  <div class="section-divider"></div>
  <div class="form-row">
    <div><label>6. Order Type</label><select id="obOrderType" onchange="updateJSON()"><option>MARKET</option><option>LIMIT</option></select></div>
    <div><label>7. Product</label><select id="obProduct" onchange="updateJSON()"><option value="D">D (Delivery)</option><option value="I">I (Intraday)</option></select></div>
  </div>
  <div class="form-row">
    <div><label>8. Exit Target (pts)</label><input id="obExitTarget" type="number" placeholder="40" onchange="updateJSON()"></div>
    
    <div><label>10. Trailing SL (pts)</label><input id="obTrailSL" type="number" placeholder="15" onchange="updateJSON()"></div>
    <div><label>11. Activate Trail (pts)</label><input id="obTrailAct" type="number" placeholder="10" onchange="updateJSON()"></div>
  </div>
  <div class="section-divider"></div>
  <h2 style="margin-bottom:6px;">Generated JSON</h2>
  <div class="json-box" id="jsonOutput">Fill in fields above...</div>
  <div class="form-row" style="margin-top:10px;">
    <button class="btn btn-success" onclick="copyJSON()">📋 Copy JSON</button>
    <button class="btn btn-primary" onclick="copyWebhookUrl()">📋 Copy Webhook URL</button>
    <button class="btn btn-secondary" onclick="placeBuilderOrder()">⚡ Place Order Now</button>
  </div>
</div>

<div id="tab-signals" class="card hidden">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h2>Signals — Raw Messages</h2><button class="btn btn-secondary" onclick="loadSignals()">Refresh</button></div>
  <table><thead><tr><th>Time</th><th>Action</th><th>Instrument</th><th>Status</th><th>Raw Message</th></tr></thead><tbody id="signalsBody"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table>
</div>

<div id="tab-orders" class="card hidden">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h2>Orders</h2><button class="btn btn-secondary" onclick="loadOrders()">Refresh</button></div>
  <table><thead><tr><th>Time</th><th>Type</th><th>Instrument</th><th>Action</th><th>Status</th></tr></thead><tbody id="ordersBody"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table>
</div>

<div id="tab-positions" class="card hidden">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><h2>Positions</h2>
    <div style="display:flex;gap:6px;"><button class="btn btn-secondary" onclick="loadPositions()">Tracked</button><button class="btn btn-secondary" onclick="loadUpstoxPositions()">Live</button></div></div>
  <table><thead><tr><th>Instrument</th><th>Side</th><th>Qty</th><th>Entry</th><th>High/Low</th><th>Action</th></tr></thead><tbody id="positionsBody"><tr><td colspan="6" class="muted">Loading...</td></tr></tbody></table>
</div>

<div id="tab-auto" class="card">
  <h2>🤖 Auto Trade Config</h2>
  <div class="form-row" style="align-items:center;margin-bottom:12px;">
    <label class="toggle"><input type="checkbox" id="tcAutoEnabled" checked onchange="saveTradingConfig()"><span class="slider"></span></label><span class="tlight on" id="autoLight"></span>
    <span style="margin-left:8px;font-weight:600;">Auto Trade (Option Only)</span>
    <span class="muted" style="margin-left:8px;font-size:0.75rem;">ON = buy_ce/buy_pe buy options. OFF = signals ignored.</span>
  </div>
  <p class="muted" style="margin-bottom:12px;">When a TradingView webhook sends <code>{"action":"buy_ce"}</code> or <code>{"action":"buy_pe"}</code>, the bot uses these settings to auto-select ATM strike, quantity, and exit conditions for each leg independently.</p>
  <div class="form-row">
    <div style="flex:2"><label>1. Underlying</label><select id="tcUnderlying" onchange="onTcInstrumentChange()"></select></div>
    <div><label>Lot Size (manual)</label><input id="tcLotSize" type="number" value="65" min="1" onchange="updateTcQty()" style="font-weight:600;"></div>
    <div><label>CE Qty</label><input id="tcCeQty" type="number" readonly style="opacity:.6"></div>
    <div><label>PE Qty</label><input id="tcPeQty" type="number" readonly style="opacity:.6"></div>
  </div>
  <div class="section-divider"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
    <div style="background:var(--bg);border:1px solid var(--green);border-radius:8px;padding:12px;">
      <h3 style="color:var(--green);margin-bottom:8px;font-size:0.95rem;">🟢 CE Leg (Buy CE alerts)</h3>
      <div class="form-row" style="align-items:center;margin-bottom:8px;">
        <label class="toggle"><input type="checkbox" id="tcCeEnabled" checked onchange="updateLights()"><span class="slider"></span></label><span class="tlight on" id="ceLight"></span>
        <span style="margin-left:8px;font-weight:600;">Enable CE leg</span>
      </div>
      <div><label>Lots</label><input id="tcCeLots" type="number" value="1" min="1"></div>
      <div style="margin-top:6px;"><label>Product</label><select id="tcCeProduct"><option value="D">D (Delivery)</option><option value="I">I (Intraday)</option></select></div>
      
    </div>
    <div style="background:var(--bg);border:1px solid var(--red);border-radius:8px;padding:12px;">
      <h3 style="color:var(--red);margin-bottom:8px;font-size:0.95rem;">🔴 PE Leg (Buy PE alerts)</h3>
      <div class="form-row" style="align-items:center;margin-bottom:8px;">
        <label class="toggle"><input type="checkbox" id="tcPeEnabled" checked onchange="updateLights()"><span class="slider"></span></label><span class="tlight on" id="peLight"></span>
        <span style="margin-left:8px;font-weight:600;">Enable PE leg</span>
      </div>
  

      <div><label>Lots</label><input id="tcPeLots" type="number" value="1" min="1"></div>
      <div style="margin-top:6px;"><label>Product</label><select id="tcPeProduct"><option value="D">D (Delivery)</option><option value="I">I (Intraday)</option></select></div>
      
    </div>


  </div>

  <h2 style="font-size:0.95rem;color:#8b949e;margin-bottom:8px;">TradingView Webhook Setup</h2>
  <p class="muted" style="margin-bottom:6px;">Webhook URL:</p>
  <div class="json-box" id="tcWebhookUrl" style="font-size:0.75rem;"></div>
  <p class="muted" style="margin-bottom:6px;">Alert Messages — send one of these from TradingView:</p>
  <div class="json-box" style="font-size:0.75rem;">{"action":"buy_ce"} &nbsp; — buy CE (Call)<br>{"action":"buy_pe"} &nbsp; — buy PE (Put)<br>{"action":"sell_ce"} &nbsp; — sell/exit CE<br>{"action":"sell_pe"} &nbsp; — sell/exit PE<br>{"action":"BUY"} &nbsp;&nbsp;&nbsp; — uses default leg (CE)</div>
  <button class="btn btn-primary" onclick="copyTcWebhookUrl()">📋 Copy Webhook URL</button>
</div>

<div id="tab-strategy" class="card hidden">
  <h2>📈 Strategy Engine</h2>
  <p class="muted" style="margin-bottom:12px;">Pick a strategy, adjust parameters, enable. Only one strategy runs at a time. Strategy code is saved internally — not shown.</p>
  <div id="stratStatus" class="muted" style="margin-bottom:10px;"></div>
  <div id="stratLastSignal" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px;display:none;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span id="stratSignalDot" class="dot" style="width:10px;height:10px;border-radius:50%;background:var(--blue);"></span>
      <b style="font-size:1rem;">Last Signal: <span id="stratSignalText" style="color:var(--blue);">—</span></b>
      <span class="muted" style="margin-left:auto;" id="stratSignalTime">—</span>
    </div>
    <div id="stratSignalDetails" class="muted" style="font-size:0.8rem;"></div>
  </div>
  <div id="stratSignalHistory" style="margin-bottom:12px;display:none;">
    <div class="muted" style="font-size:0.8rem;margin-bottom:4px;">Recent Signals:</div>
    <div id="stratSignalList" style="max-height:120px;overflow-y:auto;"></div>
  </div>
  <div class="section-divider"></div>
  <h2 style="font-size:0.95rem;color:#8b949e;margin-bottom:8px;">Live Signal Log — Open/Close (auto-refresh 5s)</h2>
  <div id="stratLiveLog" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;max-height:300px;overflow-y:auto;font-family:monospace;font-size:0.75rem;">
    <div class="muted" style="text-align:center;padding:20px;">No signals yet. Enable strategy engine to see live OPEN/CLOSE signals.</div>
  </div>
  <div class="form-row" style="align-items:center;margin-top:8px;">
    <button class="btn btn-secondary" onclick="clearStratLog()">Clear Log</button>
    <span class="muted" style="font-size:0.75rem;margin-left:8px;" id="stratLogCount">0 signals</span>
  </div>
  <div class="form-row" style="align-items:center;">
    <label class="toggle"><input type="checkbox" id="stratEnabled" onchange="toggleStratEngine()"><span class="slider"></span></label><span class="tlight off" id="stratLight"></span>
    <span style="margin-left:8px;font-weight:600;">Enable Strategy Engine</span>
    <button class="btn btn-secondary" onclick="loadStratConfig()" style="margin-left:auto;">Refresh</button>
    <button class="btn btn-primary" onclick="saveStratConfig()">💾 Save Config</button>
    <button class="btn btn-primary" onclick="previewStrat()">▶ Preview</button>
    <button class="btn btn-secondary" onclick="resetStratState()">Reset State</button>
  </div>
  <div class="section-divider"></div>
  <div class="form-row">
    <div style="flex:2"><label>Strategy</label><select id="stratSelect" onchange="onStratChange()"></select></div>
    <div style="flex:2"><label>Underlying</label><select id="stratUnderlying"></select></div>
    <div><label>Entry TF</label><select id="stratCandleInterval"><option value="1m">1 min</option><option value="3m" selected>3 min</option><option value="5m">5 min</option><option value="15m">15 min</option></select></div>
    <div><label>HTF</label><select id="stratHtfInterval"><option value="3m">3 min</option><option value="15m">15 min</option><option value="30m">30 min</option><option value="45m" selected>45 min</option></select></div>
  </div>
  <div class="form-row">
    <div><label>Lots</label><input id="stratLots" type="number" value="1" min="1"></div>
    <div><label>Product</label><select id="stratProduct"><option value="I">I (Intraday)</option><option value="D">D (Delivery)</option></select></div>
    <div><label>Cooldown (sec)</label><input id="stratCooldown" type="number" value="60"></div>
  </div>
  <div class="section-divider"></div>
  <h2 style="font-size:0.95rem;color:#8b949e;margin-bottom:8px;">Strategy Parameters</h2>
  <div id="stratParams" class="form-row" style="flex-wrap:wrap;gap:8px;"></div>
  <div id="stratPreview" class="json-box hidden" style="margin-top:10px;"></div>
  <div class="muted" style="font-size:0.8rem;margin-top:8px;">⚡ WebSocket real-time mode. Strategy code saved on server. Parameters editable here.</div>
</div>
<div id="tab-backtest" class="card hidden">
  <h2>🧪 Strategy Backtest</h2>
  <p class="muted" style="margin-bottom:12px;">Runs the selected strategy over historical candles and shows entry, exit, and P&L in points.</p>
  <div class="form-row" style="align-items:center;">
    <div style="flex:2"><label>Strategy (uses saved config)</label><select id="btStrategy" disabled></select></div>
    <div><label>Interval</label><select id="btInterval"><option value="1m">1 min</option><option value="3m">3 min</option><option value="5m" selected>5 min</option><option value="15m">15 min</option><option value="30m">30 min</option></select></div>
    <button class="btn btn-primary" onclick="runBacktest()" style="margin-top:18px;">▶ Run Backtest</button>
  </div>
  <div id="btStatus" class="muted" style="margin-top:10px;"></div>
  <div id="btSummary" style="display:none;margin-top:12px;"></div>
  <div id="btResults" style="margin-top:12px;max-height:400px;overflow-y:auto;"></div>
</div>



<div id="tab-futures" class="card hidden">
  <h2>📊 NIFTY 50 Futures Hedge</h2>
  <div class="form-row" style="align-items:center;margin-bottom:12px;">
    <label class="toggle"><input type="checkbox" id="tcFuturesEnabled" onchange="saveTradingConfig()"><span class="slider"></span></label><span class="tlight off" id="futuresLight"></span>
    <span style="margin-left:8px;font-weight:600;">Futures Hedge Mode</span>
    <span class="muted" style="margin-left:8px;font-size:0.75rem;">ON = buy_ce/buy_pe trade futures+option hedge. OFF = uses Auto Trade instead.</span>
  </div>
  <p class="muted" style="margin-bottom:12px;">Configure futures + option hedge strategy. Option is bought only for margin benefit — profit comes from futures.</p>
  
  <div style="background:var(--surface);border:1px solid var(--blue);border-radius:8px;padding:12px;margin-bottom:16px;">
    <h3 style="color:var(--blue);margin-bottom:8px;font-size:0.95rem;">How it works</h3>
    <p style="font-size:0.8rem;color:#8b949e;margin-bottom:4px;">🟢 <b>buy_ce</b> → BUY futures + BUY OTM PE (bullish, PE = hedge for margin benefit)</p>
    <p style="font-size:0.8rem;color:#8b949e;margin-bottom:4px;">🔴 <b>sell_ce</b> → SELL futures ONLY (option stays for manual exit from Positions)</p>
    <p style="font-size:0.8rem;color:#8b949e;margin-bottom:4px;">🟢 <b>buy_pe</b> → SELL futures + BUY OTM CE (bearish, CE = hedge for margin benefit)</p>
    <p style="font-size:0.8rem;color:#8b949e;margin-bottom:4px;">🔴 <b>sell_pe</b> → BUY BACK futures ONLY (option stays for manual exit from Positions)</p>
    <p style="font-size:0.75rem;color:#8b949e;margin-top:8px;">Profit comes from futures. Option is only for margin benefit — exit it manually from Positions tab.</p>
  </div>

  <div class="section-divider"></div>
  <h2 style="font-size:0.95rem;color:#8b949e;margin-bottom:8px;">Lot Selection</h2>
  <div class="form-row" style="align-items:center;margin-bottom:12px;">
    <div style="flex:1;">
      <label>Number of lots (futures + option)</label>
      <select id="tcHedgeLots" style="font-size:1rem;padding:8px;">
        <option value="1" selected>1 lot (65 qty NIFTY)</option>
        <option value="2">2 lots (130 qty NIFTY)</option>
        <option value="3">3 lots (195 qty NIFTY)</option>
        <option value="4">4 lots (260 qty NIFTY)</option>
        <option value="5">5 lots (325 qty NIFTY)</option>
        <option value="10">10 lots (650 qty NIFTY)</option>
      </select>
    </div>
    <div style="margin-left:12px;font-size:0.75rem;color:#8b949e;max-width:200px;">
      Both futures and option use the same lot count. Higher lots = more margin needed.
    </div>
  </div>
  <div class="section-divider"></div>
  <h2 style="font-size:0.95rem;color:#8b949e;margin-bottom:8px;">Option Strike Selection</h2>
  <div class="form-row" style="align-items:center;margin-bottom:12px;">
    <div style="flex:1;">
      <label>Strike distance from ATM (for protective option)</label>
      <select id="tcStrikeOffset" style="font-size:1rem;padding:8px;">
        <option value="1">1 strike from ATM — costliest option, max protection</option>
        <option value="2" selected>2 strikes from ATM</option>
        <option value="3">3 strikes from ATM</option>
        <option value="4">4 strikes from ATM</option>
        <option value="5">5 strikes from ATM</option>
        <option value="6">6 strikes from ATM — cheapest, min protection</option>
        <option value="8">8 strikes from ATM</option>
        <option value="10">10 strikes from ATM</option>
      </select>
    </div>
  </div>
  <p class="muted" style="font-size:0.75rem;margin-bottom:12px;">NIFTY strike interval = 50pts. Offset 3 = 150pts away from ATM.<br>Lower offset = more protection but costlier option. Higher offset = cheaper option, less protection.<br>You can also override per-signal: <code>{"action":"buy_ce","strike_offset":4}</code></p>

  <div class="section-divider"></div>
  <h2 style="font-size:0.95rem;color:#8b949e;margin-bottom:8px;">Webhook Alert Messages</h2>
  <div class="json-box" style="font-size:0.75rem;">{"action":"buy_ce"} &nbsp; — bullish: BUY futures + BUY OTM PE<br>{"action":"sell_ce"} &nbsp; — exit: SELL futures ONLY<br>{"action":"buy_pe"} &nbsp; — bearish: SELL futures + BUY OTM CE<br>{"action":"sell_pe"} &nbsp; — exit: BUY BACK futures ONLY<br><br>With custom strike offset:<br>{"action":"buy_ce","strike_offset":4}<br>{"action":"buy_pe","strike_offset":3}</div>
  
  <div class="section-divider"></div>
  <h2 style="font-size:0.95rem;color:#8b949e;margin-bottom:8px;">Strike Calculation Example</h2>
  <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;">
    <p style="margin-bottom:6px;"><b>If NIFTY spot = 24,350 and offset = 3:</b></p>
    <p style="margin-bottom:4px;color:var(--green);">buy_ce → PE strike = 24,350 - (3×50) = <b>24,200</b> (BUY futures + BUY PE)</p>
    <p style="margin-bottom:4px;color:var(--red);">buy_pe → CE strike = 24,350 + (3×50) = <b>24,500</b> (SELL futures + BUY CE)</p>
    <p style="color:#8b949e;font-size:0.7rem;margin-top:8px;">Bot selects nearest expiry futures contract + OTM option automatically.</p>
  </div>
</div>

<div id="tab-settings" class="card hidden">
  <h2>⚙️ Settings</h2>
  <p class="muted" style="margin-bottom:12px;">Configure Upstox API credentials and webhook secret.</p>
  <div id="settingsStatus" class="muted" style="margin-bottom:12px;"></div>
  <div class="form-row">
    <div style="flex:2"><label>Upstox API Key (Client ID)</label><input id="setClientId" type="text" placeholder="a97d9aad-..."></div>
  </div>
  <div class="form-row">
    <div style="flex:2"><label>Upstox API Secret</label><input id="setClientSecret" type="password" placeholder="Enter new secret"></div>
  </div>
  <div class="form-row">
    <div style="flex:2"><label>Dashboard Password (optional)</label><input id="setDashPass" type="password" placeholder="Set password to protect dashboard"></div>
  </div>
  <div class="form-row">
    <div style="flex:2"><label>Webhook Secret</label><input id="setWebhookSecret" type="password" placeholder="Enter new webhook secret"></div>
  </div>
  <div class="form-row" style="margin-top:10px;">
    <button class="btn btn-success" onclick="saveSettings()">Save Settings</button>
    <button class="btn btn-secondary" onclick="loadSettings()">Refresh</button>
  </div>
  <div class="section-divider"></div>
  <p class="muted" style="font-size:0.8rem;">Note: API Secret is stored in the database only. It is never committed to git.</p>
</div>

<script>
window.onerror=function(msg,url,line,col,err){document.body.insertAdjacentHTML('afterbegin','<div style="background:red;color:white;padding:16px;font-size:14px;position:fixed;top:0;left:0;right:0;z-index:9999">JS ERROR: '+msg+' (line '+line+')</div>');return false;};
document.addEventListener('DOMContentLoaded',function(){document.title=document.title;var d=document.createElement('div');d.id='jsCheck';d.style.cssText='position:fixed;bottom:0;left:0;background:green;color:white;padding:4px 8px;font-size:10px;z-index:9999';d.textContent='JS OK v3';document.body.appendChild(d);});
const api=async(p,o)=>{try{const r=await fetch(p,o);if(!r.ok){console.error('API error:',r.status,p);return{error:'HTTP '+r.status};}return await r.json();}catch(e){console.error('API fetch error:',e.message,p);return{error:e.message};}};
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',3500);}
function fmtTime(ts){return ts?new Date(ts).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}):'—';}
let _activeTab='';function showTab(n,el){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');document.querySelectorAll('[id^="tab-"]').forEach(d=>d.classList.add('hidden'));document.getElementById('tab-'+n).classList.remove('hidden');_activeTab=n;if(n==='signals')loadSignals();if(n==='orders')loadOrders();if(n==='positions')loadPositions();if(n==='settings')loadSettings();if(n==='futures')loadTradingConfig();if(n==='auto')loadTradingConfig();if(n==='strategy')loadStratConfig();if(n==='backtest')loadBacktestStrats();}
let obState={instrumentKey:null,lotSize:1,instrumentToken:null};
function updateLights(){const m=[['killToggle','killLight'],['tcAutoEnabled','autoLight'],['tcCeEnabled','ceLight'],['tcPeEnabled','peLight'],['stratEnabled','stratLight'],['tcFuturesEnabled','futuresLight']];m.forEach(function(p){var cb=document.getElementById(p[0]),lt=document.getElementById(p[1]);if(cb&&lt)lt.className='tlight '+(cb.checked?'on':'off');});}
async function loadStatus(){try{const s=await api('/api/token-status');if(!s||s.error){document.getElementById('tokenText').textContent='Error';return;}const d=document.getElementById('tokenDot'),t=document.getElementById('tokenText');if(!s.has_token){d.className='dot red';t.textContent='No token';}else if(s.is_expired){d.className='dot red';t.textContent='EXPIRED';}else{d.className='dot green';t.textContent='Valid until '+fmtTime(s.expires_at);}document.getElementById('killToggle').checked=s.kill_switch;document.getElementById('killText').textContent=s.kill_switch?'OFF':'ON';document.getElementById('killBanner').classList.toggle('hidden',!s.kill_switch);updateLights();api('/health').then(h=>{if(h&&!h.error)document.getElementById('marketStatus').textContent=h.market_open?'OPEN':'CLOSED';});}catch(e){console.error('loadStatus error:',e);}}
async function requestToken(){document.getElementById('tokenBtn').disabled=true;try{const r=await api('/api/request-token',{method:'POST'});if(r.ok){toast('✅ Token request sent — approve on Upstox app');}else{const msg=(r.data&&(r.data.message||r.data.error||JSON.stringify(r.data)))||'HTTP '+r.status;toast('❌ Failed: '+msg);}}catch(e){toast('❌ Network error: '+e.message);}document.getElementById('tokenBtn').disabled=false;setTimeout(loadStatus,3000);}
async function toggleKillSwitch(){const isOn=document.getElementById('killToggle').checked;try{await api('/api/kill-switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:isOn?'on':'off'})});document.getElementById('killText').textContent=isOn?'OFF':'ON';updateLights();document.getElementById('killBanner').classList.toggle('hidden',!isOn);toast(isOn?'⚠ Bot OFF — signals blocked':'✅ Bot ON — signals active');}catch(e){toast('❌ Error: '+e.message);}}
async function loadInstruments(){try{const r=await api('/api/instruments');if(!r||r.error){console.error('loadInstruments error');return;}const ob=document.getElementById('obInstrument');if(ob){ob.innerHTML='<option value="">— Select —</option>';r.instruments.forEach(i=>ob.innerHTML+='<option value="'+i.key+'" data-lot="'+i.lot_size+'">'+i.name+' (lot: '+i.lot_size+')</option>');}const tc=document.getElementById('tcUnderlying');if(tc){tc.innerHTML='';r.instruments.forEach(i=>tc.innerHTML+='<option value="'+i.key+'" data-lot="'+i.lot_size+'">'+i.name+' (lot: '+i.lot_size+')</option>');}}catch(e){console.error('loadInstruments error:',e);}}
function onTcInstrumentChange(){const s=document.getElementById('tcUnderlying');const o=s.options[s.selectedIndex];if(!o||!o.value)return;const lot=parseInt(o.dataset.lot||'1',10);const ls=document.getElementById('tcLotSize');if(ls)ls.value=lot;updateTcQty(lot);}
function updateTcQty(lot){const ls=document.getElementById('tcLotSize');if(!lot)lot=parseInt(ls&&ls.value||'65',10);const ceLots=parseInt(document.getElementById('tcCeLots').value||'1',10);const peLots=parseInt(document.getElementById('tcPeLots').value||'1',10);const ceq=document.getElementById('tcCeQty');const peq=document.getElementById('tcPeQty');if(ceq)ceq.value=ceLots*lot;if(peq)peq.value=peLots*lot;}
async function loadTradingConfig(){try{const c=await api('/api/trading-config');if(!c||c.error){console.error('loadTradingConfig error');return;}const s=document.getElementById('tcUnderlying');if(s&&c.underlying){for(let i=0;i<s.options.length;i++){if(s.options[i].value===c.underlying){s.selectedIndex=i;break;}}onTcInstrumentChange();}document.getElementById('tcCeEnabled').checked=c.ce_enabled!==false;document.getElementById('tcCeLots').value=c.ce_lots||c.lots||1;document.getElementById('tcCeProduct').value=c.ce_product||c.product||'D';document.getElementById('tcPeEnabled').checked=c.pe_enabled!==false;document.getElementById('tcPeLots').value=c.pe_lots||c.lots||1;document.getElementById('tcPeProduct').value=c.pe_product||c.product||'D';const so=document.getElementById('tcStrikeOffset');if(so)so.value=c.strike_offset||2;const hl=document.getElementById('tcHedgeLots');if(hl)hl.value=c.hedge_lots||1;
const ae=document.getElementById('tcAutoEnabled');if(ae)ae.checked=c.auto_enabled!==false;
const fe=document.getElementById('tcFuturesEnabled');if(fe)fe.checked=c.futures_enabled||false;updateLights();const wu=await api('/api/webhook-url');document.getElementById('tcWebhookUrl').textContent=wu.url||'Set WEBHOOK_SECRET in Settings first';document.getElementById('tcStatus').innerHTML='Config loaded';if(c.lot_size)document.getElementById('tcLotSize').value=c.lot_size;updateTcQty(c.lot_size||65);}catch(e){console.error('loadTradingConfig error:',e);}}
function getSetting_webhook_secret_hint(){return '';}
async function saveTradingConfig(){try{const s=document.getElementById('tcUnderlying');const o=s.options[s.selectedIndex];if(!o||!o.value){toast('Select underlying');return;}const lot=parseInt(document.getElementById('tcLotSize').value||o.dataset.lot||'65',10);const b={underlying:o.value,underlying_name:o.text.split(' (')[0],lot_size:lot,option_type:'CE',lots:parseInt(document.getElementById('tcCeLots').value||'1',10),product:document.getElementById('tcCeProduct').value,ce_enabled:document.getElementById('tcCeEnabled').checked,ce_lots:parseInt(document.getElementById('tcCeLots').value||'1',10),ce_product:document.getElementById('tcCeProduct').value,pe_enabled:document.getElementById('tcPeEnabled').checked,pe_lots:parseInt(document.getElementById('tcPeLots').value||'1',10),pe_product:document.getElementById('tcPeProduct').value,strike_offset:parseInt(document.getElementById('tcStrikeOffset')?.value||'2',10),hedge_lots:parseInt(document.getElementById('tcHedgeLots')?.value||'1',10),auto_enabled:document.getElementById('tcAutoEnabled')?.checked!==false,futures_enabled:document.getElementById('tcFuturesEnabled')?.checked||false};const r=await api('/api/trading-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(r&&r.error){toast('❌ Save failed: '+r.error);return;}toast('✅ Trading config saved!');updateLights();console.log('[CONFIG] Save response:',JSON.stringify(r));}catch(e){toast('❌ Error: '+e.message);}}
function copyTcWebhookUrl(){const u=document.getElementById('tcWebhookUrl').textContent;navigator.clipboard.writeText(u).then(()=>toast('✅ Webhook URL copied!'));}
let _strategies = {};
let _stratParams = {};

async function loadStratConfig(){
  try{
  const c = await api('/api/strategy-config');
  if(!c||c.error){console.error('loadStratConfig error');return;}
  const s = await api('/api/strategy-status');
  const strats = await api('/api/strategies');
  _strategies = strats.strategies || {};
  const sel = document.getElementById('stratSelect');
  sel.innerHTML = '';
  for (const [key, val] of Object.entries(_strategies)) {
    sel.innerHTML += '<option value="'+key+'">'+val.name+'</option>';
  }
  if (c.strategy) sel.value = c.strategy;
  const usel = document.getElementById('stratUnderlying');
  if (usel.options.length === 0) {
    const r = await api('/api/instruments');
    r.instruments.forEach(i => usel.innerHTML += '<option value="'+i.key+'" data-lot="'+i.lot_size+'">'+i.name+' (lot: '+i.lot_size+')</option>');
  }
  if (c.underlying) { for (let i=0; i<usel.options.length; i++) { if (usel.options[i].value===c.underlying) { usel.selectedIndex=i; break; } } }
  document.getElementById('stratCandleInterval').value = c.candle_interval || '3m';
  document.getElementById('stratHtfInterval').value = c.htf_candle_interval || '45m';
  document.getElementById('stratLots').value = c.lots || 1;
  document.getElementById('stratProduct').value = c.product || 'I';
  document.getElementById('stratCooldown').value = c.cooldown_seconds || 60;
  document.getElementById('stratEnabled').checked = c.enabled || false;
  _stratParams = c.params || {};
  // Render params with saved values
  renderStratParams();
  // After rendering, set saved values
  if (c.params) {
    for (const [pk, pv] of Object.entries(c.params)) {
      const el = document.getElementById('stratParam_'+pk);
      if (el) el.value = pv;
    }
  }
  let ws = s.ws_connected ? '🟢 WS LIVE' : '🔴 WS OFF';
  let ltp = s.last_ltp ? 'LTP: '+s.last_ltp : '';
  let st = 'Engine: '+(s.running?'🟢 RUNNING':'🔴 STOPPED')+' | '+ws+' | Market: '+(s.market_open?'OPEN':'CLOSED');
  if (s.position_open) st += ' | Position: '+s.position_type;
  if (ltp) st += ' | '+ltp;
  document.getElementById('stratStatus').textContent = st;
  updateStratSignalDisplay(s);
  }catch(e){console.error('loadStratConfig error:',e);}
}

function renderStratParams(){
  const key = document.getElementById('stratSelect').value;
  const strat = _strategies[key];
  const container = document.getElementById('stratParams');
  if (!strat || !strat.params) { container.innerHTML = '<span class="muted">No parameters</span>'; return; }
  let html = '';
  for (const [pk, pv] of Object.entries(strat.params)) {
    const val = _stratParams[pk] !== undefined ? _stratParams[pk] : pv.value;
    html += '<div><label>'+pv.label+'</label><input id="stratParam_'+pk+'" type="'+(pv.type||'number')+'" value="'+val+'" step="0.5"></div>';
  }
  container.innerHTML = html;
}

function onStratChange(){
  const key = document.getElementById('stratSelect').value;
  const strat = _strategies[key];
  if (strat && strat.needsHtf === false) {
    document.getElementById('stratHtfInterval').value = document.getElementById('stratCandleInterval').value;
  }
  _stratParams = {};
  renderStratParams();
}

function collectStratParams(){
  const key = document.getElementById('stratSelect').value;
  const strat = _strategies[key];
  if (!strat || !strat.params) return {};
  const out = {};
  for (const pk of Object.keys(strat.params)) {
    const el = document.getElementById('stratParam_'+pk);
    if (el) out[pk] = parseFloat(el.value);
  }
  return out;
}

async function saveStratConfig(){
  const sel = document.getElementById('stratUnderlying');
  const o = sel.options[sel.selectedIndex];
  if (!o || !o.value) { toast('Select underlying'); return; }
  const b = {
    enabled: document.getElementById('stratEnabled').checked,
    strategy: document.getElementById('stratSelect').value,
    underlying: o.value,
    underlying_name: o.text.split(' (')[0],
    lot_size: parseInt(o.dataset.lot||'1',10),
    candle_interval: document.getElementById('stratCandleInterval').value,
    htf_candle_interval: document.getElementById('stratHtfInterval').value,
    lots: parseInt(document.getElementById('stratLots').value||'1',10),
    product: document.getElementById('stratProduct').value,
    cooldown_seconds: parseInt(document.getElementById('stratCooldown').value||'60',10),
    params: collectStratParams(),
  };
  await api('/api/strategy-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
  toast('✅ Config saved!');
  setTimeout(loadStratConfig,500);
}

async function toggleStratEngine(){
  const isOn = document.getElementById('stratEnabled').checked;
  if (isOn) await saveStratConfig();
  await api('/api/strategy-toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:isOn?'start':'stop'})});
  toast(isOn?'📈 Engine started':'⏹ Engine stopped');updateLights();
  setTimeout(loadStratConfig,1000);
}

async function previewStrat(){
  const p = document.getElementById('stratPreview');
  p.classList.remove('hidden');
  p.textContent = 'Saving config & running preview...';
  try {
    // Save current params first so preview uses the latest values
    await saveStratConfig();
    const r = await api('/api/strategy-preview');
    if (r.error) { p.textContent = '❌ Error: '+r.error; return; }
    let html = 'Strategy: '+(r.strategy_name||'—')+'\\n';
    html += 'Signal: '+(r.signal||'null (no signal)')+'\\n';
    html += 'Candles: '+r.candle_count+', HTF: '+r.htf_candle_count+'\\n';
    html += 'Last Close: '+r.last_close+'\\n';
    html += 'Live LTP: '+(r.live_ltp||'—')+'\\n';
    html += 'WS: '+(r.ws_connected?'🟢 Connected':'🔴 Off')+'\\n';
    html += 'Running: '+(r.running?'🟢 Yes':'🔴 No')+'\\n';
    html += 'Position: '+(r.position_open?r.position_type:'Flat')+'\\n';
    html += 'State: '+JSON.stringify(r.state,null,2);
    p.textContent = html;
  } catch(e) { p.textContent = '❌ '+e.message; }
}

function updateStratSignalDisplay(s){
  const card = document.getElementById('stratLastSignal');
  const hist = document.getElementById('stratSignalHistory');
  const histList = document.getElementById('stratSignalList');
  if (s.last_signal && s.last_signal.signal) {
    card.style.display = 'block';
    const sig = s.last_signal.signal;
    const colors = {'BUY_CE':'var(--green)','BUY_PE':'var(--red)','EXIT_CE':'var(--amber)','EXIT_PE':'var(--amber)'};
    document.getElementById('stratSignalDot').style.background = colors[sig]||'var(--blue)';
    document.getElementById('stratSignalText').style.color = colors[sig]||'var(--blue)';
    document.getElementById('stratSignalText').textContent = sig;
    document.getElementById('stratSignalTime').textContent = fmtTime(s.last_signal.time);
    let d='';
    if (s.last_signal.state_snapshot) {
      const ss=s.last_signal.state_snapshot;
      if (ss.position) d+='Position: '+ss.position.type+' Entry: '+ss.position.entryPrice;
      if (ss.setupOpen) d+=' Setup O:'+ss.setupOpen+' C:'+ss.setupClose;
      if (ss.setupLine) d+=' SetupLine: '+ss.setupLine;
    }
    document.getElementById('stratSignalDetails').textContent = d;
  } else { card.style.display='none'; }
  if (s.signal_history && s.signal_history.length>0) {
    hist.style.display='block';
    histList.innerHTML = s.signal_history.map(h=>{
      const c={'BUY_CE':'green','BUY_PE':'red','EXIT_CE':'amber','EXIT_PE':'amber'}[h.signal]||'amber';
      return '<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:0.8rem;"><span class="badge '+c+'">'+h.signal+'</span><span class="muted">'+fmtTime(h.time)+'</span></div>';
    }).join('');
  } else { hist.style.display='none'; }
}

async function resetStratState(){
  await api('/api/strategy-reset-state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  toast('✅ State reset!');
  setTimeout(loadStratConfig,500);
}
async function loadInstruments_old(){}
async function onInstrumentChange(){const s=document.getElementById('obInstrument');const o=s.options[s.selectedIndex];if(!o||!o.value)return;obState.instrumentKey=o.value;obState.lotSize=parseInt(o.dataset.lot||'1',10);document.getElementById('obExpiry').disabled=true;document.getElementById('obExpiry').innerHTML='<option value="">Loading...</option>';const r=await api('/api/option-expiries?instrument_key='+encodeURIComponent(obState.instrumentKey));const e=document.getElementById('obExpiry');if(r.error){e.innerHTML='<option value="">Error</option>';return;}e.innerHTML='<option value="">— Select —</option>';r.expiries.forEach(exp=>e.innerHTML+='<option value="'+exp+'">'+exp+'</option>');e.disabled=false;updateJSON();}
async function onExpiryChange(){const exp=document.getElementById('obExpiry').value;if(!exp||!obState.instrumentKey)return;const type=document.getElementById('obOptionType').value;const r=await api('/api/atm-strike?instrument_key='+encodeURIComponent(obState.instrumentKey)+'&expiry_date='+encodeURIComponent(exp)+'&type='+type);if(r.error){toast('❌ ATM failed');document.getElementById('atmInfo').classList.add('hidden');return;}obState.instrumentToken=r.instrument_key;document.getElementById('atmInfo').classList.remove('hidden');document.getElementById('atmStrike').textContent=r.atm_strike;document.getElementById('atmSpot').textContent=r.spot_price;document.getElementById('atmLtp').textContent=r.ltp||'—';updateJSON();}
function updateJSON(){if(!obState.instrumentToken){document.getElementById('jsonOutput').textContent='Fill in fields...';return;}const q=parseInt(document.getElementById('obLots').value||'1',10)*obState.lotSize;document.getElementById('obQty').value=q;const p={action:document.getElementById('obAction').value,instrument_token:obState.instrumentToken,quantity:q};const ot=document.getElementById('obOrderType').value;if(ot!=='MARKET')p.order_type=ot;const pr=document.getElementById('obProduct').value;if(pr!=='D')p.product=pr;const et=document.getElementById('obExitTarget').value,es=document.getElementById('obExitSL').value,ts=document.getElementById('obTrailSL').value,ta=document.getElementById('obTrailAct').value;if(et)p.exit_target_points=parseFloat(et);if(es)p.exit_sl_points=parseFloat(es);if(ts)p.trailing_sl_points=parseFloat(ts);if(ta)p.trailing_activation_points=parseFloat(ta);document.getElementById('jsonOutput').textContent=JSON.stringify(p,null,2);}
function copyJSON(){const t=document.getElementById('jsonOutput').textContent;navigator.clipboard.writeText(t).then(()=>toast('✅ Copied!'));}
async function copyWebhookUrl(){const wu=await api('/api/webhook-url');const u=wu.url||'Set WEBHOOK_SECRET in Settings first';navigator.clipboard.writeText(u).then(()=>toast('✅ URL copied!'));}
async function placeBuilderOrder(){if(!obState.instrumentToken){toast('Select instrument first');return;}const q=parseInt(document.getElementById('obLots').value||'1',10)*obState.lotSize;const p={action:document.getElementById('obAction').value,instrument_token:obState.instrumentToken,quantity:q,order_type:document.getElementById('obOrderType').value,product:document.getElementById('obProduct').value};const r=await api('/api/manual-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});toast(r.ok?'✅ Order placed!':'❌ '+JSON.stringify(r.result||r.error));loadStatus();}
async function loadSignals(){const d=await api('/api/signals');const b=document.getElementById('signalsBody');if(!d||d.length===0){b.innerHTML='<tr><td colspan="5" class="muted">No signals</td></tr>';return;}b.innerHTML=d.map(s=>{const p=s.payload||{};const a=p.action||'—',i=(p.instrument_token||'—').substring(0,25),st=s.status||'—';const cls=st==='order_placed'?'green':st==='duplicate'?'amber':'red';return '<tr><td>'+fmtTime(s.timestamp)+'</td><td><span class="pill '+(a==='BUY'?'buy':'sell')+'">'+a+'</span></td><td>'+i+'</td><td><span class="badge '+cls+'">'+st+'</span></td><td class="raw-msg">'+(s.raw_message||'—').substring(0,80)+'</td></tr>';}).join('');}
async function loadOrders(){const d=await api('/api/orders');const b=document.getElementById('ordersBody');if(!d||d.length===0){b.innerHTML='<tr><td colspan="5" class="muted">No orders</td></tr>';return;}b.innerHTML=d.map(o=>'<tr><td>'+fmtTime(o.timestamp)+'</td><td>'+(o.type||'—')+'</td><td>'+(o.instrument_token||'—').substring(0,25)+'</td><td>'+(o.action||'—')+'</td><td>'+(o.ok?'<span class="badge green">OK</span>':'<span class="badge red">FAIL</span>')+'</td></tr>').join('');}
async function loadPositions(){const d=await api('/api/positions');const b=document.getElementById('positionsBody');if(!d||d.length===0){b.innerHTML='<tr><td colspan="6" class="muted">No positions</td></tr>';return;}b.innerHTML=d.map(p=>'<tr><td>'+(p.instrument_token||'').substring(0,25)+'</td><td><span class="pill '+(p.transaction_type==='BUY'?'buy':'sell')+'">'+p.transaction_type+'</span></td><td>'+p.quantity+'</td><td>'+p.entry_price+'</td><td>'+(p.highest_price||p.lowest_price||'—')+'</td><td><button class="btn btn-danger" style="padding:4px 12px;font-size:0.8rem;" onclick="exitPosition('+p.id+')">Exit</button></td></tr>').join('');}
async function loadUpstoxPositions(){const r=await api('/api/upstox-positions');const b=document.getElementById('positionsBody');if(r.error){b.innerHTML='<tr><td colspan="6" class="muted">Error: '+r.error+'</td></tr>';return;}const ps=(r.data&&r.data.data)||[];if(ps.length===0){b.innerHTML='<tr><td colspan="6" class="muted">No live positions</td></tr>';return;}b.innerHTML=ps.map(p=>'<tr><td>'+(p.instrument_token||'').substring(0,25)+'</td><td><span class="pill '+(p.transaction_type==='BUY'?'buy':'sell')+'">'+(p.transaction_type||'')+'</span></td><td>'+p.quantity+'</td><td>'+p.average_price+'</td><td>'+p.last_price+'</td><td>—</td></tr>').join('');}
async function exitPosition(id){if(!confirm('Exit this position now? This places a MARKET order.'))return;try{const r=await api('/api/exit-position',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});if(r.ok){toast('✅ Exit order placed!');loadPositions();}else{toast('❌ Exit failed: '+(r.error||'unknown'));}}catch(e){toast('❌ Error: '+e.message);}}
async function loadSettings(){const s=await api('/api/settings');document.getElementById('setClientId').value=s.upstox_client_id||'';document.getElementById('setClientSecret').value='';document.getElementById('setWebhookSecret').value='';let p=[];p.push(s.has_client_id?'✅ API Key':'❌ API Key');p.push(s.has_client_secret?'✅ Secret':'❌ Secret');p.push(s.has_webhook_secret?'✅ Webhook':'❌ Webhook');document.getElementById('settingsStatus').innerHTML=p.join(' &nbsp; ');}
async function saveSettings(){const b={};const ci=document.getElementById('setClientId').value.trim(),cs=document.getElementById('setClientSecret').value.trim(),ws=document.getElementById('setWebhookSecret').value.trim();if(ci)b.upstox_client_id=ci;if(cs)b.upstox_client_secret=cs;if(ws)b.webhook_secret=ws;if(!ci&&!cs&&!ws){toast('No changes');return;}await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});toast('✅ Saved!');loadSettings();loadStatus();}
async function loadBacktestStrats(){try{const c=await api('/api/strategy-config');const strats=await api('/api/strategies');const sel=document.getElementById('btStrategy');sel.innerHTML='';for(const[key,val]of Object.entries(strats.strategies||{})){sel.innerHTML+='<option value="'+key+'">'+val.name+'</option>';}if(c.strategy)sel.value=c.strategy;sel.disabled=false;}catch(e){console.error('loadBacktestStrats error:',e);}}
async function runBacktest(){const st=document.getElementById('btStatus');const sm=document.getElementById('btSummary');const rs=document.getElementById('btResults');const btn=event.target;btn.disabled=true;st.textContent='Running backtest...';sm.style.display='none';rs.innerHTML='';try{const interval=document.getElementById('btInterval').value;const r=await api('/api/strategy-backtest?interval='+interval);if(r.error){st.textContent='Error: '+r.error;btn.disabled=false;return;}st.textContent='Backtest complete — '+r.total_trades+' trades on '+r.candle_count+' candles ('+r.interval+')';sm.style.display='block';sm.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:12px;">'+'<div class="card" style="text-align:center;padding:8px;"><div class="muted" style="font-size:0.7rem;">Trades</div><div style="font-size:1.2rem;font-weight:bold;">'+r.total_trades+'</div></div>'+'<div class="card" style="text-align:center;padding:8px;"><div class="muted" style="font-size:0.7rem;">Win Rate</div><div style="font-size:1.2rem;font-weight:bold;color:'+(parseFloat(r.win_rate)>=50?'var(--green)':'var(--red)')+';">'+r.win_rate+'%</div></div>'+'<div class="card" style="text-align:center;padding:8px;"><div class="muted" style="font-size:0.7rem;">Total P&L</div><div style="font-size:1.2rem;font-weight:bold;color:'+(parseFloat(r.total_pnl)>=0?'var(--green)':'var(--red)')+';">'+(parseFloat(r.total_pnl)>=0?'+':'')+r.total_pnl+'</div></div>'+'<div class="card" style="text-align:center;padding:8px;"><div class="muted" style="font-size:0.7rem;">Avg P&L</div><div style="font-size:1.2rem;font-weight:bold;color:'+(parseFloat(r.avg_pnl)>=0?'var(--green)':'var(--red)')+';">'+(parseFloat(r.avg_pnl)>=0?'+':'')+r.avg_pnl+'</div></div>'+'<div class="card" style="text-align:center;padding:8px;"><div class="muted" style="font-size:0.7rem;">Max Win</div><div style="font-size:1.2rem;font-weight:bold;color:var(--green);">+'+r.max_win+'</div></div>'+'<div class="card" style="text-align:center;padding:8px;"><div class="muted" style="font-size:0.7rem;">Max Loss</div><div style="font-size:1.2rem;font-weight:bold;color:var(--red);">'+r.max_loss+'</div></div>'+'</div>';if(r.trades.length===0){rs.innerHTML='<p class="muted">No trades generated. Try a different interval or adjust strategy params.</p>';btn.disabled=false;return;}let html='<table><thead><tr><th>#</th><th>Type</th><th>Entry</th><th>Exit</th><th>Entry Time</th><th>Exit Time</th><th>P&L (pts)</th></tr></thead><tbody>';for(let i=0;i<r.trades.length;i++){const t=r.trades[i];const pnlColor=t.pnl>0?'var(--green)':t.pnl<0?'var(--red)':'var(--text)';const pnlStr=(t.pnl>0?'+':'')+t.pnl;const noteStr=t.note?' <span class="muted" style="font-size:0.7rem;">('+t.note+')</span>':'';html+='<tr><td>'+(i+1)+'</td><td><span class="pill '+(t.type==='CE'?'buy':'sell')+'">'+t.type+'</span></td><td>'+t.entry_price+'</td><td>'+t.exit_price+'</td><td style="font-size:0.75rem;">'+t.entry_time+'</td><td style="font-size:0.75rem;">'+t.exit_time+'</td><td style="color:'+pnlColor+';font-weight:bold;">'+pnlStr+'</td></tr>';}html+='</tbody></table>';rs.innerHTML=html;}catch(e){st.textContent='Error: '+e.message;}btn.disabled=false;}
loadStatus();loadInstruments().then(()=>loadTradingConfig());
// Live auto-refresh — polls active tab data without page reload
setInterval(loadStatus,30000); // token status every 30s
setInterval(async()=>{
  try{
    // Always refresh signals + positions (most important live data)
    if(_activeTab==='signals'){await loadSignals();}
    else if(_activeTab==='orders'){await loadOrders();}
    else if(_activeTab==='positions'){await loadPositions();}
    // Also refresh strategy status if on strategy tab
    if(_activeTab==='strategy'){const s=await api('/api/strategy-status');if(s&&!s.error){updateStratSignalDisplay(s);updateLiveLog(s);}}
  }catch(e){}
},3000); // every 3 seconds = near real-time
let _stratLogSignals=[];
let _stratLogLastCount=0;
function updateLiveLog(s){if(!s||!s.signal_history)return;const logEl=document.getElementById('stratLiveLog');const countEl=document.getElementById('stratLogCount');if(!logEl)return;const hist=s.signal_history;if(hist.length===_stratLogLastCount)return;_stratLogLastCount=hist.length;let html='';for(let i=hist.length-1;i>=0;i--){const h=hist[i];const isEntry=h.signal==='BUY_CE'||h.signal==='BUY_PE';const isExit=h.signal==='EXIT_CE'||h.signal==='EXIT_PE';const label=isEntry?'OPEN':(isExit?'CLOSE':h.signal);const color=isEntry?(h.signal==='BUY_CE'?'var(--green)':'var(--red)'):(isExit?'var(--amber)':'var(--blue)');const bgColor=isEntry?'rgba(63,185,80,0.05)':(isExit?'rgba(210,153,34,0.05)':'transparent');const time=new Date(h.time).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});const src=h.source||'';html+='<div style="padding:6px 8px;border-bottom:1px solid var(--border);background:'+bgColor+';border-radius:4px;margin-bottom:4px;">';html+='<span style="color:'+color+';font-weight:bold;">'+label+'</span> ';html+='<span style="color:'+(h.signal.includes('CE')?'var(--green)':'var(--red)')+';">'+(h.signal.includes('CE')?'CE':'PE')+'</span> ';html+='<span class="muted" style="font-size:0.7rem;">'+time+'</span>';if(src)html+='<span class="muted" style="font-size:0.7rem;margin-left:8px;">('+src+')</span>';html+='</div>';}if(html==='')html='<div class="muted" style="text-align:center;padding:20px;">No signals yet.</div>';logEl.innerHTML=html;countEl.textContent=hist.length+' signals';}
function clearStratLog(){const logEl=document.getElementById('stratLiveLog');const countEl=document.getElementById('stratLogCount');logEl.innerHTML='<div class="muted" style="text-align:center;padding:20px;">Log cleared.</div>';countEl.textContent='0 signals';_stratLogLastCount=-1;}
setInterval(async()=>{try{const s=await api('/api/strategy-status');if(s&&!s.error)updateLiveLog(s);}catch(e){}},5000);
</script>
<div id="toast"></div>
</body></html>`;

// Initialize Strategy Engine (optional module — does nothing if not enabled)
const strategyEngine = require("./strategy-engine");
strategyEngine.init(app, {
  db, getSetting, setSetting, getToken,
  placeUpstoxOrder, getLTP, calculateATM, isMarketOpen,
  logOrder, logSignal, addLog, fetchIPv4, getTradingConfig,
});

// Start server

// --- Error handler (no stack trace leakage) ---
app.use((err, req, res, next) => {
  console.error("[ERROR]", err.message);
  addLog("ERROR", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {

// BUG 26: Graceful shutdown — save state and close WebSocket on PM2 stop
process.on("SIGTERM", () => {
  console.log("[SHUTDOWN] SIGTERM received — saving state and shutting down");
  try {
    if (typeof strategyEngine !== "undefined" && strategyEngine.running) {
      strategyEngine.saveState();
      strategyEngine.stop();
    }
  } catch (e) { console.log("[SHUTDOWN] Error:", e.message); }
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[SHUTDOWN] SIGINT received — saving state and shutting down");
  try {
    if (typeof strategyEngine !== "undefined" && strategyEngine.running) {
      strategyEngine.saveState();
      strategyEngine.stop();
    }
  } catch (e) { console.log("[SHUTDOWN] Error:", e.message); }
  process.exit(0);
});
  console.log(`Horse Engine running on port ${PORT}`);
  addLog("INFO", "Server started on port " + PORT);
});


// === PRE-WARM CACHE on startup ===
// Fetches instrument data immediately so the FIRST signal is also fast
// Re-warms every 50 seconds (before 60s cache expires)
async function preWarmCache() {
  try {
    const { token, expiry } = await getToken();
    if (!token || Date.now() >= expiry) {
      console.log('[PREWARM] No valid token — skipping. Click Request New Token.');
      return;
    }
    const tcfg = getTradingConfig();
    const underlying = tcfg.underlying || 'NSE_INDEX|Nifty 50';
    console.log('[PREWARM] Warming cache for', underlying, '...');

    const [futResult, optResult] = await Promise.all([
      findFuturesContract(token, underlying),
      getOptionContracts(token, underlying, null)
    ]);

    if (futResult) {
      console.log('[PREWARM] Futures cached:', futResult.trading_symbol, '(lot:', futResult.lot_size + ')');
    } else {
      console.log('[PREWARM] Could not fetch futures contract');
    }

    if (optResult && optResult.ok) {
      const contracts = (optResult.data && optResult.data.data) || [];
      const expiries = [...new Set(contracts.map(x => x.expiry))].sort();
      console.log('[PREWARM] Options cached:', contracts.length, 'contracts, nearest expiry:', expiries[0] || 'none');
    } else {
      console.log('[PREWARM] Could not fetch option contracts');
    }

    console.log('[PREWARM] Cache warmed — signals will be fast');
  } catch (e) {
    console.log('[PREWARM] Error:', e.message);
  }
}

// Start pre-warm 3 seconds after startup (allows token DB to be ready)
setTimeout(preWarmCache, 3000);
// Re-warm every 50 seconds (before 60s cache TTL expires)
setInterval(preWarmCache, 50000);
