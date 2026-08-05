/**
 * Upstox ← TradingView Webhook Bridge for Cloudflare Workers.
 * v4 — lot sizes updated, points-based exits, ATM-only strikes, raw alert logging,
 * webhook 500 fix, message sent/received logging.
 */

const KV = {
  async get(env, key) { return env.UPSTOX_KV.get(key); },
  async getJson(env, key, fallback = null) {
    const v = await env.UPSTOX_KV.get(key);
    if (!v) return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  },
  async put(env, key, value, opts) {
    return env.UPSTOX_KV.put(key, typeof value === "string" ? value : JSON.stringify(value), opts);
  },
  async list(env, prefix) {
    const results = [];
    let cursor;
    do {
      const resp = await env.UPSTOX_KV.list({ prefix, cursor });
      for (const k of resp.keys) results.push(k.name);
      cursor = resp.list_complete ? null : resp.cursor;
    } while (cursor);
    return results;
  },
  async delete(env, key) { return env.UPSTOX_KV.delete(key); },
};

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extraHeaders },
  });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

async function sha1(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isMarketOpen(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return istMinutes >= 555 && istMinutes <= 990;
}

// LATEST LOT SIZES — effective from January 2026 series (NSE circular Oct 2025)
const UNDERLYING_INSTRUMENTS = [
  { name: "NIFTY 50", key: "NSE_INDEX|Nifty 50", symbol: "NIFTY", lot_size: 65 },
  { name: "NIFTY BANK", key: "NSE_INDEX|Nifty Bank", symbol: "BANKNIFTY", lot_size: 30 },
  { name: "NIFTY FIN SERVICE", key: "NSE_INDEX|Nifty Fin Service", symbol: "FINNIFTY", lot_size: 60 },
  { name: "NIFTY MIDCAP SELECT", key: "NSE_INDEX|Nifty Midcap 50", symbol: "MIDCPNIFTY", lot_size: 120 },
  { name: "SENSEX", key: "BSE_INDEX|Sensex", symbol: "SENSEX", lot_size: 20 },
  { name: "BANKEX", key: "BSE_INDEX|Bankex", symbol: "BANKEX", lot_size: 30 },
];

// ---------------------------------------------------------------------------
// Secrets management — all secrets in KV, editable via dashboard
// ---------------------------------------------------------------------------

async function getSecret(env, key) {
  const kvVal = await KV.get(env, `secret:${key}`);
  return kvVal || env[key] || "";
}

async function getAllSettings(env) {
  return {
    webhook_secret: await getSecret(env, "WEBHOOK_SECRET"),
    upstox_client_id: await getSecret(env, "UPSTOX_CLIENT_ID"),
    upstox_client_secret: await getSecret(env, "UPSTOX_CLIENT_SECRET"),
  };
}

async function saveSettings(env, settings) {
  if (settings.upstox_client_id !== undefined && settings.upstox_client_id !== "")
    await KV.put(env, "secret:UPSTOX_CLIENT_ID", settings.upstox_client_id);
  if (settings.upstox_client_secret !== undefined && settings.upstox_client_secret !== "")
    await KV.put(env, "secret:UPSTOX_CLIENT_SECRET", settings.upstox_client_secret);
  if (settings.webhook_secret !== undefined && settings.webhook_secret !== "")
    await KV.put(env, "secret:WEBHOOK_SECRET", settings.webhook_secret);
  return await getAllSettings(env);
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function getToken(env) {
  const token = await KV.get(env, "access_token");
  const expiryStr = await KV.get(env, "access_token_expiry");
  const expiry = expiryStr ? parseInt(expiryStr, 10) : 0;
  return { token, expiry };
}

async function saveToken(env, token, expiresAtMs) {
  await KV.put(env, "access_token", token);
  await KV.put(env, "access_token_expiry", String(expiresAtMs));
}

// ---------------------------------------------------------------------------
// Logging — signals and orders stored in KV with timestamp keys
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 200;

async function logSignal(env, signal) {
  const key = `signal:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await KV.put(env, key, signal, { expirationTtl: 7 * 24 * 3600 });
  const all = await KV.list(env, "signal:");
  if (all.length > MAX_LOG_ENTRIES) {
    await Promise.all(all.slice(0, all.length - MAX_LOG_ENTRIES).map((k) => KV.delete(env, k)));
  }
}

async function logOrder(env, order) {
  const key = `order:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await KV.put(env, key, order, { expirationTtl: 7 * 24 * 3600 });
  const all = await KV.list(env, "order:");
  if (all.length > MAX_LOG_ENTRIES) {
    await Promise.all(all.slice(0, all.length - MAX_LOG_ENTRIES).map((k) => KV.delete(env, k)));
  }
}

async function getSignals(env, limit = 50) {
  const keys = await KV.list(env, "signal:");
  const recent = keys.slice(-limit).reverse();
  const items = [];
  for (const k of recent) { const v = await KV.getJson(env, k, null); if (v) items.push(v); }
  return items;
}

async function getOrders(env, limit = 50) {
  const keys = await KV.list(env, "order:");
  const recent = keys.slice(-limit).reverse();
  const items = [];
  for (const k of recent) { const v = await KV.getJson(env, k, null); if (v) items.push(v); }
  return items;
}

// ---------------------------------------------------------------------------
// Position tracking
// ---------------------------------------------------------------------------

async function getTrackedPositions(env) { return KV.getJson(env, "positions", []); }
async function saveTrackedPositions(env, positions) { await KV.put(env, "positions", positions); }
async function addTrackedPosition(env, pos) {
  const positions = await getTrackedPositions(env);
  positions.push(pos);
  await saveTrackedPositions(env, positions);
}

// ---------------------------------------------------------------------------
// Exit config — POINTS based (not percentage)
// ---------------------------------------------------------------------------

const DEFAULT_EXIT_CONFIG = {
  enabled: false,
  mode: "none",               // "none" | "trailing_sl" | "fixed_sl_target" | "both"
  trailing_sl_points: 20,          // points below highest price (trails upward)
  trailing_activation_points: 10,  // price must rise this many points before trailing begins
  fixed_sl_points: 30,             // hard stop-loss in points
  fixed_target_points: 40,         // target in points
};

async function getExitConfig(env) {
  return { ...DEFAULT_EXIT_CONFIG, ...(await KV.getJson(env, "exit_config", {})) };
}

async function saveExitConfig(env, config) {
  const merged = { ...DEFAULT_EXIT_CONFIG, ...config };
  await KV.put(env, "exit_config", merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

async function getKillSwitch(env) { return (await KV.get(env, "kill_switch")) === "on"; }
async function setKillSwitch(env, on) { await KV.put(env, "kill_switch", on ? "on" : "off"); }

// ---------------------------------------------------------------------------
// Upstox API calls
// ---------------------------------------------------------------------------

async function placeUpstoxOrder(env, accessToken, order) {
  const body = {
    quantity: order.quantity,
    product: order.product ?? "D",
    validity: order.validity ?? "DAY",
    price: order.price ?? 0,
    tag: order.tag ?? "tv-webhook",
    instrument_token: order.instrument_token,
    order_type: order.order_type ?? "MARKET",
    transaction_type: order.transaction_type,
    disclosed_quantity: order.disclosed_quantity ?? 0,
    trigger_price: order.trigger_price ?? 0,
    is_amo: order.is_amo ?? false,
    market_protection: -1,
    slice: false,
  };
  const resp = await fetch("https://api-hft.upstox.com/v2/order/place", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function placeExitOrder(env, accessToken, instrumentToken, quantity, transactionType, tag = "exit") {
  const body = {
    quantity, product: "I", validity: "DAY", price: 0, tag,
    instrument_token: instrumentToken, order_type: "MARKET",
    transaction_type: transactionType, disclosed_quantity: 0,
    trigger_price: 0, is_amo: false, market_protection: -1, slice: false,
  };
  const resp = await fetch("https://api-hft.upstox.com/v2/order/place", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function getLTP(env, accessToken, instrumentToken) {
  const url = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentToken)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const key = Object.keys(data.data || {})[0];
  return key ? data.data[key].last_price : null;
}

/** Fetch spot price of an index (e.g. Nifty 50) to determine ATM strike */
async function getSpotPrice(env, accessToken, instrumentKey) {
  return await getLTP(env, accessToken, instrumentKey);
}

async function getUpstoxPositions(env) {
  const { token, expiry } = await getToken(env);
  if (!token || Date.now() >= expiry) return { error: "no_token" };
  const resp = await fetch("https://api.upstox.com/v2/portfolio/short-term-positions", {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function requestAccessToken(env) {
  const clientId = await getSecret(env, "UPSTOX_CLIENT_ID");
  const clientSecret = await getSecret(env, "UPSTOX_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return { ok: false, status: 0, data: { error: "missing_credentials", message: "Set Upstox API Key and Secret in the Settings tab first." } };
  }
  const url = `https://api.upstox.com/v3/login/auth/token/request/${clientId}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_secret: clientSecret }),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

/** GET /v2/option/contract — fetch option contracts for an expiry */
async function getOptionContracts(env, instrumentKey, expiryDate) {
  const { token, expiry } = await getToken(env);
  if (!token || Date.now() >= expiry) return { error: "no_token" };
  let url = `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`;
  if (expiryDate) url += `&expiry_date=${encodeURIComponent(expiryDate)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

async function isDuplicate(env, payload) {
  const key = `sig:${await sha1(JSON.stringify(payload))}`;
  const seen = await KV.get(env, key);
  if (seen) return true;
  await KV.put(env, key, "1", { expirationTtl: 10 });
  return false;
}

// ---------------------------------------------------------------------------
// Exit engine — POINTS based, checks trailing SL, fixed SL, target
// ---------------------------------------------------------------------------

async function checkExits(env) {
  const config = await getExitConfig(env);
  if (!config.enabled || config.mode === "none") return { checked: 0, exits: [] };

  const { token, expiry } = await getToken(env);
  if (!token || Date.now() >= expiry) return { error: "no_token" };

  const positions = await getTrackedPositions(env);
  if (positions.length === 0) return { checked: 0, exits: [] };

  const results = [];
  const remaining = [];

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    let shouldExit = false;
    let exitReason = "";

    // Per-position exit config overrides global if present
    const exitCfg = pos.exit_config || {};
    const mode = exitCfg.mode || config.mode;
    const trailSLpts = exitCfg.trailing_sl_points ?? config.trailing_sl_points;
    const trailActPts = exitCfg.trailing_activation_points ?? config.trailing_activation_points;
    const fixedSLpts = exitCfg.fixed_sl_points ?? config.fixed_sl_points;
    const fixedTargetPts = exitCfg.fixed_target_points ?? config.fixed_target_points;

    const ltp = await getLTP(env, token, pos.instrument_token);
    if (ltp === null) { remaining.push(pos); continue; }

    if (pos.transaction_type === "BUY") {
      if (!pos.highest_price || ltp > pos.highest_price) pos.highest_price = ltp;
    } else {
      if (!pos.lowest_price || ltp < pos.lowest_price) pos.lowest_price = ltp;
    }

    const entry = pos.entry_price;
    const isBuy = pos.transaction_type === "BUY";

    // --- Trailing SL (points based) ---
    if (mode === "trailing_sl" || mode === "both") {
      if (isBuy) {
        const movePts = pos.highest_price - entry;
        if (movePts >= trailActPts) {
          // Trailing active — SL is trailSLpts below highest price
          const sl = pos.highest_price - trailSLpts;
          if (ltp <= sl) {
            shouldExit = true;
            exitReason = `Trailing SL hit (SL: ${sl.toFixed(2)}, LTP: ${ltp})`;
          }
        }
      } else {
        const movePts = entry - pos.lowest_price;
        if (movePts >= trailActPts) {
          const sl = pos.lowest_price + trailSLpts;
          if (ltp >= sl) {
            shouldExit = true;
            exitReason = `Trailing SL hit (SL: ${sl.toFixed(2)}, LTP: ${ltp})`;
          }
        }
      }
    }

    // --- Fixed SL + Target (points based) ---
    if (!shouldExit && (mode === "fixed_sl_target" || mode === "both")) {
      if (isBuy) {
        const slPrice = entry - fixedSLpts;
        const targetPrice = entry + fixedTargetPts;
        if (ltp <= slPrice) {
          shouldExit = true;
          exitReason = `Fixed SL hit (SL: ${slPrice.toFixed(2)}, LTP: ${ltp})`;
        } else if (ltp >= targetPrice) {
          shouldExit = true;
          exitReason = `Target hit (Target: ${targetPrice.toFixed(2)}, LTP: ${ltp})`;
        }
      } else {
        const slPrice = entry + fixedSLpts;
        const targetPrice = entry - fixedTargetPts;
        if (ltp >= slPrice) {
          shouldExit = true;
          exitReason = `Fixed SL hit (SL: ${slPrice.toFixed(2)}, LTP: ${ltp})`;
        } else if (ltp <= targetPrice) {
          shouldExit = true;
          exitReason = `Target hit (Target: ${targetPrice.toFixed(2)}, LTP: ${ltp})`;
        }
      }
    }

    if (shouldExit) {
      const exitSide = isBuy ? "SELL" : "BUY";
      const result = await placeExitOrder(env, token, pos.instrument_token, pos.quantity, exitSide, `exit:${exitReason}`);
      results.push({ position: pos, exitReason, ltp, orderResult: result.data });
      await logOrder(env, { timestamp: Date.now(), type: "exit", reason: exitReason, instrument_token: pos.instrument_token, transaction_type: exitSide, quantity: pos.quantity, ltp, result: result.data, ok: result.ok });
    } else {
      remaining.push(pos);
    }
  }

  await saveTrackedPositions(env, remaining);
  return { checked: positions.length, exits: results };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /webhook?token=<SECRET>
 * IMPORTANT FIX: Always return HTTP 200 to prevent TradingView "delivery failed" errors.
 * TradingView treats any non-2xx as a delivery failure and retries. We log errors
 * internally but return 200 with the error in the body.
 * Also captures the RAW alert text for the signals log.
 */
/**
 * POST /webhook?token=<SECRET>
 *
 * IMPORTANT: TradingView webhook format research findings (Aug 2026):
 *
 * 1. Content-Type: TradingView sends application/json IF the message body
 *    starts with { or [. Otherwise it sends text/plain. Some relays also
 *    receive application/x-www-form-urlencoded. We must handle ALL three.
 *
 * 2. Action field: TradingView's {{strategy.order.action}} returns LOWERCASE
 *    "buy"/"sell". We must accept both lowercase and uppercase.
 *
 * 3. Field name alternatives: Different TradingView setups use different
 *    field names. We must accept all common variants:
 *    - action / side / transaction_type / data
 *    - instrument_token / ticker / symbol / instrument_key
 *    - quantity / qty / contracts / order_contracts
 *    - order_type / type / orderType
 *
 * 4. TradingView strips newlines from the Message field on save. The body
 *    is always a single line, even if you pasted formatted JSON.
 *
 * 5. ALWAYS return HTTP 200. TradingView treats any non-2xx as "delivery
 *    failed" and shows an error in the alerts log. We log errors internally
 *    but return 200 with error details in the JSON body.
 *
 * 6. The raw alert message is captured and logged for debugging, so you can
 *    see exactly what TradingView sent in the Signals tab.
 */
async function handleWebhook(request, env) {
  const url = new URL(request.url);
  const webhookSecret = await getSecret(env, "WEBHOOK_SECRET");

  // Capture raw body text FIRST — for logging regardless of what happens
  const rawText = await request.text();
  const contentType = request.headers.get("content-type") || "";

  // If webhook secret not set, log and return 200 (don't 500)
  if (!webhookSecret) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), status: "error_no_webhook_secret" });
    return json({ status: "error", message: "WEBHOOK_SECRET not set. Go to Settings tab to configure." }, 200);
  }

  // Auth: check token in query string OR in the JSON body (some setups put it in body)
  const queryToken = url.searchParams.get("token") || "";
  let bodyToken = "";

  // Parse the payload — handle JSON, text/plain, and form-urlencoded
  let payload = {};
  let parseError = null;

  if (rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
    // Looks like JSON — try parsing
    try {
      payload = JSON.parse(rawText);
      bodyToken = payload.token || payload.secret || "";
    } catch (e) {
      parseError = "JSON parse error: " + e.message;
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    // Form-urlencoded — parse as URL params
    try {
      const params = new URLSearchParams(rawText);
      for (const [k, v] of params) {
        // Try to parse JSON values, otherwise keep as string
        try { payload[k] = JSON.parse(v); } catch { payload[k] = v; }
      }
      bodyToken = payload.token || payload.secret || "";
    } catch (e) {
      parseError = "form parse error: " + e.message;
    }
  } else {
    // Plain text — try JSON first (TradingView might send text/plain with JSON body)
    try {
      payload = JSON.parse(rawText);
      bodyToken = payload.token || payload.secret || "";
    } catch (e) {
      parseError = "not valid JSON: " + e.message;
    }
  }

  // Check auth — token in query string OR in body
  const isAuthenticated = safeEqual(queryToken, webhookSecret) || (bodyToken && safeEqual(bodyToken, webhookSecret));
  if (!isAuthenticated) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), content_type: contentType, status: "unauthorized" });
    return json({ status: "error", message: "unauthorized — check webhook secret" }, 200);
  }

  // If parsing failed, log and return 200
  if (parseError) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), content_type: contentType, status: "parse_error", error: parseError });
    return json({ status: "error", message: "could not parse alert: " + parseError }, 200);
  }

  // --- Normalize field names (accept all TradingView variants) ---
  // Action: accept action, side, transaction_type, data
  // TradingView's {{strategy.order.action}} returns lowercase "buy"/"sell"
  let action = String(
    payload.action || payload.side || payload.transaction_type || payload.data || ""
  ).toUpperCase().trim();

  // Instrument: accept instrument_token, ticker, symbol, instrument_key
  const instrumentToken = payload.instrument_token || payload.ticker || payload.symbol || payload.instrument_key || "";

  // Quantity: accept quantity, qty, contracts, order_contracts
  const quantity = parseInt(payload.quantity ?? payload.qty ?? payload.contracts ?? payload.order_contracts ?? 1, 10);

  // Order type: accept order_type, type, orderType
  const orderType = payload.order_type || payload.type || payload.orderType || "MARKET";

  // Exit config — accept both _points and _percent variants (normalize to points)
  const exitTargetPoints = payload.exit_target_points ?? payload.exit_target ?? payload.target_points;
  const exitSLPoints = payload.exit_sl_points ?? payload.sl_points ?? payload.stoploss_points;
  const trailSLPoints = payload.trailing_sl_points ?? payload.trail_sl ?? payload.trail_points;
  const trailActPoints = payload.trailing_activation_points ?? payload.trail_activation_points ?? payload.trail_trigger_points;

  // Validate action
  if (!["BUY", "SELL"].includes(action)) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: "invalid_action", action_received: action });
    return json({ status: "error", message: `invalid action: "${action}" (must be BUY or SELL). Received fields: ${Object.keys(payload).join(", ")}` }, 200);
  }

  // Validate instrument
  if (!instrumentToken) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: "missing_instrument" });
    return json({ status: "error", message: "missing instrument_token (or ticker/symbol/instrument_key)" }, 200);
  }

  // Validate quantity
  if (!quantity || quantity < 1) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: "invalid_quantity" });
    return json({ status: "error", message: "invalid quantity" }, 200);
  }

  // Kill switch check
  if (await getKillSwitch(env)) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: "rejected_kill_switch" });
    return json({ status: "rejected", reason: "kill_switch_active" }, 200);
  }

  // Dedupe
  if (await isDuplicate(env, payload)) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: "duplicate" });
    return json({ status: "duplicate" }, 200);
  }

  const { token, expiry } = await getToken(env);
  if (!token || Date.now() >= expiry) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: "no_token" });
    return json({ status: "error", message: "no Upstox access token. Request one from the dashboard." }, 200);
  }

  const order = {
    quantity,
    product: payload.product || "D",
    validity: payload.validity || "DAY",
    price: parseFloat(payload.price ?? 0),
    order_type: String(orderType).toUpperCase(),
    transaction_type: action,
    instrument_token: instrumentToken,
  };

  let result;
  try {
    result = await placeUpstoxOrder(env, token, order);
  } catch (err) {
    await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: "order_api_error", error: String(err) });
    return json({ status: "error", message: "Upstox API call failed: " + String(err) }, 200);
  }

  await logSignal(env, { timestamp: Date.now(), raw_message: rawText.substring(0, 1000), payload, status: result.ok ? "order_placed" : "order_failed" });
  await logOrder(env, { timestamp: Date.now(), type: "entry", action, instrument_token: instrumentToken, quantity, result: result.data, ok: result.ok });

  // Track position for exit management — supports per-position exit config from payload
  if (result.ok) {
    const exitConfig = await getExitConfig(env);
    const hasExit = (exitConfig.enabled && exitConfig.mode !== "none") || payload.exit_config || exitTargetPoints || exitSLPoints || trailSLPoints;
    if (hasExit) {
      const entryPrice = await getLTP(env, token, instrumentToken);
      const posExitConfig = {};
      if (payload.exit_config) Object.assign(posExitConfig, payload.exit_config);
      if (exitTargetPoints) { posExitConfig.mode = posExitConfig.mode || "fixed_sl_target"; posExitConfig.fixed_target_points = exitTargetPoints; }
      if (exitSLPoints) { posExitConfig.mode = posExitConfig.mode || "fixed_sl_target"; posExitConfig.fixed_sl_points = exitSLPoints; }
      if (trailSLPoints) { posExitConfig.mode = "trailing_sl"; posExitConfig.trailing_sl_points = trailSLPoints; }
      if (trailActPoints) { posExitConfig.trailing_activation_points = trailActPoints; }
      await addTrackedPosition(env, {
        instrument_token: instrumentToken,
        transaction_type: action,
        quantity,
        entry_price: entryPrice || 0,
        highest_price: entryPrice || 0,
        lowest_price: entryPrice || 0,
        added_at: Date.now(),
        exit_config: Object.keys(posExitConfig).length > 0 ? posExitConfig : undefined,
      });
    }
  }

  return json({ status: result.ok ? "order_placed" : "order_failed", action, instrument_token: instrumentToken, quantity, upstox: result.data }, 200);
}

async function handleNotifier(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (body.message_type !== "access_token" || !body.access_token) return json({ error: "unexpected payload" }, 400);
  const clientId = await getSecret(env, "UPSTOX_CLIENT_ID");
  if (clientId && body.client_id !== clientId) return json({ error: "client_id mismatch" }, 403);
  const expiresAt = body.expires_at ? parseInt(body.expires_at, 10) : 0;
  await saveToken(env, body.access_token, expiresAt);
  return json({ status: "token_stored", expires_at: expiresAt });
}

async function handleManualOrder(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.instrument_token || !["BUY", "SELL"].includes(body.action)) return json({ error: "missing fields" }, 400);
  const { token, expiry } = await getToken(env);
  if (!token || Date.now() >= expiry) return json({ error: "no_access_token" }, 401);
  if (await getKillSwitch(env)) return json({ error: "kill_switch_active" }, 403);

  const order = {
    quantity: parseInt(body.quantity || 1, 10),
    product: body.product || "D",
    validity: "DAY",
    price: parseFloat(body.price || 0),
    order_type: body.order_type || "MARKET",
    transaction_type: body.action,
    instrument_token: body.instrument_token,
  };
  const result = await placeUpstoxOrder(env, token, order);
  await logOrder(env, { timestamp: Date.now(), type: "manual", action: body.action, instrument_token: body.instrument_token, quantity: order.quantity, result: result.data, ok: result.ok });

  if (result.ok) {
    const exitConfig = await getExitConfig(env);
    const hasExit = (exitConfig.enabled && exitConfig.mode !== "none") || body.exit_config || body.exit_target_points;
    if (hasExit) {
      const entryPrice = await getLTP(env, token, body.instrument_token);
      const posExitConfig = {};
      if (body.exit_config) Object.assign(posExitConfig, body.exit_config);
      if (body.exit_target_points) { posExitConfig.mode = posExitConfig.mode || "fixed_sl_target"; posExitConfig.fixed_target_points = body.exit_target_points; }
      if (body.exit_sl_points) { posExitConfig.mode = posExitConfig.mode || "fixed_sl_target"; posExitConfig.fixed_sl_points = body.exit_sl_points; }
      if (body.trailing_sl_points) { posExitConfig.mode = "trailing_sl"; posExitConfig.trailing_sl_points = body.trailing_sl_points; }
      await addTrackedPosition(env, {
        instrument_token: body.instrument_token, transaction_type: body.action, quantity: order.quantity,
        entry_price: entryPrice || 0, highest_price: entryPrice || 0, lowest_price: entryPrice || 0,
        added_at: Date.now(), exit_config: Object.keys(posExitConfig).length > 0 ? posExitConfig : undefined,
      });
    }
  }
  return json({ ok: result.ok, result: result.data }, result.ok ? 200 : 502);
}

async function handleKillSwitch(request, env) {
  let body = {}; try { body = await request.json(); } catch {}
  const action = body.action || "toggle";
  let isOn;
  if (action === "on") isOn = true;
  else if (action === "off") isOn = false;
  else isOn = !(await getKillSwitch(env));
  await setKillSwitch(env, isOn);
  return json({ kill_switch: isOn ? "on" : "off" });
}

async function handleSaveExitConfig(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const config = await saveExitConfig(env, body);
  return json({ status: "saved", config });
}

async function handleDashboard(env) {
  return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    if ((path === "/" || path === "/dashboard") && method === "GET") return handleDashboard(env);
    if (path === "/webhook" && method === "POST") return handleWebhook(request, env);
    if (path === "/notifier" && method === "POST") return handleNotifier(request, env);
    if (path === "/api/manual-order" && method === "POST") return handleManualOrder(request, env);
    if (path === "/api/kill-switch" && method === "POST") return handleKillSwitch(request, env);
    if (path === "/api/exit-config" && method === "POST") return handleSaveExitConfig(request, env);

    if (path === "/api/token-status" && method === "GET") {
      const { token, expiry } = await getToken(env);
      return json({ has_token: !!token, expires_at: expiry || null, is_expired: token ? Date.now() >= expiry : null, kill_switch: await getKillSwitch(env) });
    }
    if (path === "/api/signals" && method === "GET") return json(await getSignals(env, 50));
    if (path === "/api/orders" && method === "GET") return json(await getOrders(env, 50));
    if (path === "/api/positions" && method === "GET") return json(await getTrackedPositions(env));
    if (path === "/api/exit-config" && method === "GET") return json(await getExitConfig(env));
    if (path === "/api/upstox-positions" && method === "GET") return json(await getUpstoxPositions(env));
    if (path === "/api/request-token" && method === "POST") return json(await requestAccessToken(env));

    // Settings
    if (path === "/api/settings" && method === "GET") {
      const s = await getAllSettings(env);
      return json({
        webhook_secret: s.webhook_secret ? "***set***" : "",
        upstox_client_id: s.upstox_client_id,
        upstox_client_secret: s.upstox_client_secret ? "***set***" : "",
        has_webhook_secret: !!s.webhook_secret,
        has_client_id: !!s.upstox_client_id,
        has_client_secret: !!s.upstox_client_secret,
      });
    }
    if (path === "/api/settings" && method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const result = await saveSettings(env, body);
      return json({ status: "saved", settings: {
        webhook_secret: result.webhook_secret ? "***set***" : "",
        upstox_client_id: result.upstox_client_id,
        upstox_client_secret: result.upstox_client_secret ? "***set***" : "",
      }});
    }

    // Option chain — ATM only
    if (path === "/api/option-expiries" && method === "GET") {
      const instrumentKey = url.searchParams.get("instrument_key");
      if (!instrumentKey) return json({ error: "missing instrument_key" }, 400);
      const result = await getOptionContracts(env, instrumentKey, null);
      if (!result.ok) return json({ error: "failed", detail: result.data }, result.status);
      const contracts = (result.data && result.data.data) || [];
      const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
      return json({ expiries, count: expiries.length });
    }

    // ATM strike auto-selection — fetches spot price, finds nearest strike
    if (path === "/api/atm-strike" && method === "GET") {
      const instrumentKey = url.searchParams.get("instrument_key");
      const expiryDate = url.searchParams.get("expiry_date");
      const optionType = (url.searchParams.get("type") || "CE").toUpperCase(); // CE or PE
      if (!instrumentKey || !expiryDate) return json({ error: "missing instrument_key or expiry_date" }, 400);
      const { token, expiry } = await getToken(env);
      if (!token || Date.now() >= expiry) return json({ error: "no_token" }, 401);

      // Get spot price of the underlying index
      const spot = await getSpotPrice(env, token, instrumentKey);
      if (!spot) return json({ error: "could not fetch spot price" }, 500);

      // Get all option contracts for this expiry
      const result = await getOptionContracts(env, instrumentKey, expiryDate);
      if (!result.ok) return json({ error: "failed to fetch contracts", detail: result.data }, result.status);
      const contracts = (result.data && result.data.data) || [];

      // Filter for the requested type (CE or PE) and find ATM (nearest to spot)
      const typed = contracts.filter(c => c.instrument_type === optionType);
      if (typed.length === 0) return json({ error: `no ${optionType} contracts found` }, 404);

      // Find the strike nearest to spot price
      let atm = typed[0];
      let minDiff = Math.abs(typed[0].strike_price - spot);
      for (const c of typed) {
        const diff = Math.abs(c.strike_price - spot);
        if (diff < minDiff) { minDiff = diff; atm = c; }
      }

      // Also get LTP of the ATM option
      const optionLTP = await getLTP(env, token, atm.instrument_key);

      return json({
        spot_price: spot,
        atm_strike: atm.strike_price,
        instrument_key: atm.instrument_key,
        trading_symbol: atm.trading_symbol,
        lot_size: atm.lot_size,
        option_type: optionType,
        expiry: expiryDate,
        ltp: optionLTP,
      });
    }

    if (path === "/api/instruments" && method === "GET") return json({ instruments: UNDERLYING_INSTRUMENTS });

    if (path === "/health" && method === "GET") {
      const { token, expiry } = await getToken(env);
      return json({ status: "ok", token_present: !!token, token_expired: token ? Date.now() >= expiry : null, kill_switch: await getKillSwitch(env), market_open: isMarketOpen(), server_time: Date.now() });
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "40 3 * * 1-5") {
      const result = await requestAccessToken(env);
      console.log("Token request triggered:", JSON.stringify(result));
    } else if (event.cron === "* * * * *") {
      if (isMarketOpen()) {
        const result = await checkExits(env);
        if (result.exits && result.exits.length > 0) {
          console.log(`Exit engine: checked ${result.checked} positions, ${result.exits.length} exits triggered`);
        }
      }
    }
    return;
  },
};

// ---------------------------------------------------------------------------
// Dashboard HTML (v4 — ATM auto-select, points-based exits, raw message log)
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Upstox TV Webhook — Dashboard</title>
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
.dot.green{background:var(--green)}.dot.red{background:var(--red)}.dot.amber{background:var(--amber)}
.badge{padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600}
.badge.green{background:var(--green-bg);color:var(--green)}.badge.red{background:var(--red-bg);color:var(--red)}.badge.amber{background:var(--amber-bg);color:var(--amber)}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:opacity .15s}
.btn-primary{background:var(--blue);color:#fff}.btn-danger{background:var(--red);color:#fff}.btn-success{background:var(--green);color:#fff}.btn-secondary{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.btn:hover{opacity:.85}.btn:disabled{opacity:.4;cursor:not-allowed}
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
.tab-row{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
.tab{padding:6px 14px;border-radius:6px 6px 0 0;cursor:pointer;font-size:0.85rem;border:1px solid var(--border);background:var(--surface)}
.tab.active{background:var(--blue);color:#fff;border-color:var(--blue)}
.tab:hover:not(.active){border-color:var(--blue)}
.hidden{display:none}
.muted{color:#8b949e;font-size:0.8rem}
.pill{display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.7rem}
.pill.buy{background:var(--green-bg);color:var(--green)}.pill.sell{background:var(--red-bg);color:var(--red)}
.killed-banner{background:var(--red);color:#fff;padding:8px 16px;border-radius:6px;text-align:center;margin-bottom:16px;font-weight:600}
#toast{position:fixed;bottom:20px;right:20px;background:var(--surface);border:1px solid var(--border);padding:12px 16px;border-radius:8px;z-index:999;display:none;max-width:400px}
.json-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:monospace;font-size:0.8rem;white-space:pre-wrap;word-break:break-all;margin:10px 0;max-height:300px;overflow-y:auto;position:relative}
.section-divider{border-top:1px solid var(--border);margin:14px 0;padding-top:10px}
.raw-msg{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:0.75rem;color:#8b949e}
</style>
</head>
<body>
<h1>Upstox &larr; TradingView Bridge</h1>
<p class="subtitle">v4 — Updated lot sizes | Points-based exits | ATM auto-select | Raw alert logging</p>
<div id="killBanner" class="hidden killed-banner">⚠ KILL SWITCH ACTIVE — all incoming signals are blocked</div>
<div class="grid">
  <div class="card"><h2>Token Status</h2>
    <div class="status-row"><span id="tokenDot" class="dot red"></span> <span id="tokenText">Checking...</span></div>
    <div class="status-row muted">Market: <span id="marketStatus">—</span></div>
    <button class="btn btn-primary" onclick="requestToken()" id="tokenBtn">Request New Token</button>
  </div>
  <div class="card"><h2>Kill Switch</h2>
    <div class="status-row"><label class="toggle"><input type="checkbox" id="killToggle" onchange="toggleKillSwitch()"><span class="slider"></span></label><span id="killText" style="margin-left:8px;">OFF</span></div>
    <p class="muted">When ON, all incoming TradingView signals are rejected immediately.</p>
  </div>
</div>
<div class="tab-row">
  <div class="tab active" onclick="showTab('builder',this)">📋 Order Builder</div>
  <div class="tab" onclick="showTab('signals',this)">Signals</div>
  <div class="tab" onclick="showTab('orders',this)">Orders</div>
  <div class="tab" onclick="showTab('positions',this)">Positions</div>
  <div class="tab" onclick="showTab('exit',this)">Exit Conditions</div>
  <div class="tab" onclick="showTab('settings',this)">⚙️ Settings</div>
</div>

<!-- ORDER BUILDER -->
<div id="tab-builder" class="card">
  <h2>Order Builder — ATM Auto-Select</h2>
  <p class="muted" style="margin-bottom:12px;">Select instrument & expiry. The worker fetches the spot price and auto-selects the ATM strike. Choose CE or PE.</p>
  <div class="form-row">
    <div style="flex:2"><label>1. Underlying Instrument</label><select id="obInstrument" onchange="onInstrumentChange()"><option value="">— Select —</option></select></div>
    <div><label>2. Action</label><select id="obAction"><option value="BUY">BUY</option><option value="SELL">SELL</option></select></div>
  </div>
  <div class="form-row">
    <div><label>3. Expiry</label><select id="obExpiry" onchange="onExpiryChange()" disabled><option value="">— Select instrument first —</option></select></div>
    <div><label>4. Option Type</label><select id="obOptionType" onchange="onOptionTypeChange()" disabled><option value="CE">CE (Call)</option><option value="PE">PE (Put)</option></select></div>
    <div><label>5. Lots</label><input id="obLots" type="number" value="1" min="1" onchange="updateGeneratedJSON()"></div>
    <div><label>Computed Qty</label><input id="obQty" type="number" value="0" readonly style="opacity:.6"></div>
  </div>
  <div id="atmInfo" class="hidden" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px;">
    <div class="status-row"><span class="dot green"></span> <b>ATM Strike:</b> <span id="atmStrike">—</span> &nbsp; <b>Spot:</b> <span id="atmSpot">—</span> &nbsp; <b>LTP:</b> ₹<span id="atmLtp">—</span></div>
    <div class="muted">Instrument: <span id="atmToken">—</span></div>
  </div>
  <div class="section-divider"></div>
  <div class="form-row">
    <div><label>6. Order Type</label><select id="obOrderType" onchange="updateGeneratedJSON()"><option>MARKET</option><option>LIMIT</option></select></div>
    <div><label>7. Product</label><select id="obProduct" onchange="updateGeneratedJSON()"><option value="D">D (Delivery)</option><option value="I">I (Intraday)</option><option value="MTF">MTF</option></select></div>
  </div>
  <div class="form-row">
    <div><label>8. Exit Target (points)</label><input id="obExitTarget" type="number" step="0.5" value="" placeholder="e.g. 40" onchange="updateGeneratedJSON()"></div>
    <div><label>9. Exit SL (points)</label><input id="obExitSL" type="number" step="0.5" value="" placeholder="e.g. 25" onchange="updateGeneratedJSON()"></div>
    <div><label>10. Trailing SL (points)</label><input id="obTrailSL" type="number" step="0.5" value="" placeholder="e.g. 15" onchange="updateGeneratedJSON()"></div>
    <div><label>11. Activate Trail at (points)</label><input id="obTrailAct" type="number" step="0.5" value="" placeholder="e.g. 10" onchange="updateGeneratedJSON()"></div>
  </div>
  <div class="section-divider"></div>
  <h2 style="margin-bottom:6px;">Generated JSON Payload</h2>
  <div class="json-box" id="jsonOutput">Fill in the fields above to generate JSON...</div>
  <div class="form-row" style="margin-top:10px;">
    <button class="btn btn-success" onclick="copyJSON()">📋 Copy JSON</button>
    <button class="btn btn-primary" onclick="copyWebhookUrl()">📋 Copy Webhook URL</button>
    <button class="btn btn-secondary" onclick="placeBuilderOrder()">⚡ Place Order Now</button>
  </div>
</div>

<!-- SIGNALS -->
<div id="tab-signals" class="card hidden">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
    <h2>Signals — Raw Alert Messages</h2>
    <button class="btn btn-secondary" onclick="loadSignals()">Refresh</button>
  </div>
  <table><thead><tr><th>Time</th><th>Action</th><th>Instrument</th><th>Status</th><th>Raw Message</th></tr></thead>
  <tbody id="signalsBody"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table>
</div>

<!-- ORDERS -->
<div id="tab-orders" class="card hidden">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
    <h2>Recent Orders</h2><button class="btn btn-secondary" onclick="loadOrders()">Refresh</button>
  </div>
  <table><thead><tr><th>Time</th><th>Type</th><th>Instrument</th><th>Action</th><th>Status</th></tr></thead>
  <tbody id="ordersBody"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table>
</div>

<!-- POSITIONS -->
<div id="tab-positions" class="card hidden">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
    <h2>Tracked Positions</h2>
    <div style="display:flex;gap:6px;">
      <button class="btn btn-secondary" onclick="loadPositions()">Tracked</button>
      <button class="btn btn-secondary" onclick="loadUpstoxPositions()">Live (Upstox)</button>
    </div>
  </div>
  <table><thead><tr><th>Instrument</th><th>Side</th><th>Qty</th><th>Entry</th><th>High/Low</th></tr></thead>
  <tbody id="positionsBody"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table>
</div>

<!-- EXIT CONDITIONS -->
<div id="tab-exit" class="card hidden">
  <h2>Exit Conditions — Points Based</h2>
  <p class="muted" style="margin-bottom:12px;">All values are in absolute points (not percentage). E.g. SL=30 means exit if price drops 30 points below entry.</p>
  <div class="form-row" style="align-items:center;">
    <label class="toggle"><input type="checkbox" id="exitEnabled"><span class="slider"></span></label>
    <span style="margin-left:8px;font-weight:600;">Enable Exit Engine</span>
  </div>
  <div class="form-row"><div><label>Mode</label><select id="exitMode"><option value="none">None</option><option value="trailing_sl">Trailing SL only</option><option value="fixed_sl_target">Fixed SL + Target</option><option value="both">Both</option></select></div></div>
  <div class="form-row">
    <div><label>Trailing SL (points)</label><input id="trailSL" type="number" step="0.5" value="20"></div>
    <div><label>Activate Trailing at (points)</label><input id="trailAct" type="number" step="0.5" value="10"></div>
  </div>
  <div class="form-row">
    <div><label>Fixed SL (points)</label><input id="fixedSL" type="number" step="0.5" value="30"></div>
    <div><label>Fixed Target (points)</label><input id="fixedTarget" type="number" step="0.5" value="40"></div>
  </div>
  <button class="btn btn-success" onclick="saveExitConfig()">Save Exit Config</button>
</div>

<!-- SETTINGS -->
<div id="tab-settings" class="card hidden">
  <h2>⚙️ Settings — API Credentials</h2>
  <p class="muted" style="margin-bottom:12px;">All secrets stored in KV. Changes take effect immediately. Leave blank to keep current.</p>
  <div class="form-row">
    <div style="flex:2"><label>Upstox API Key (client_id)</label><input id="setClientId" placeholder="e.g. a97d9aad-..."></div>
    <div style="flex:2"><label>Upstox API Secret</label><input id="setClientSecret" type="password" placeholder="Leave blank to keep current"></div>
  </div>
  <div class="form-row"><div style="flex:2"><label>Webhook Secret (TradingView URL ?token=...)</label><input id="setWebhookSecret" type="password" placeholder="Leave blank to keep current"></div></div>
  <div id="settingsStatus" class="muted" style="margin-bottom:10px;"></div>
  <button class="btn btn-success" onclick="saveSettings()">Save Settings</button>
  <button class="btn btn-secondary" onclick="loadSettings()">Refresh</button>
</div>

<div id="toast"></div>
<script>
const api=(path,opts)=>fetch(path,opts).then(r=>r.json());
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',3500);}
function fmtTime(ts){if(!ts)return'—';return new Date(ts).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false});}
function showTab(name,el){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');document.querySelectorAll('[id^="tab-"]').forEach(d=>d.classList.add('hidden'));document.getElementById('tab-'+name).classList.remove('hidden');if(name==='signals')loadSignals();if(name==='orders')loadOrders();if(name==='positions')loadPositions();if(name==='exit')loadExitConfig();if(name==='settings')loadSettings();}
let obState={instrumentKey:null,lotSize:1,expiry:null,selectedType:'CE',instrumentToken:null,atmStrike:null,spotPrice:null};
async function loadStatus(){const s=await api('/api/token-status');const dot=document.getElementById('tokenDot'),txt=document.getElementById('tokenText');if(!s.has_token){dot.className='dot red';txt.textContent='No token stored';}else if(s.is_expired){dot.className='dot red';txt.textContent='Token EXPIRED';}else{dot.className='dot green';txt.textContent='Token valid until '+fmtTime(s.expires_at);}const ks=document.getElementById('killToggle');ks.checked=s.kill_switch;document.getElementById('killText').textContent=s.kill_switch?'ON':'OFF';document.getElementById('killBanner').classList.toggle('hidden',!s.kill_switch);fetch('/health').then(r=>r.json()).then(h=>{document.getElementById('marketStatus').textContent=h.market_open?'OPEN':'CLOSED';});}
async function requestToken(){document.getElementById('tokenBtn').disabled=true;const r=await api('/api/request-token',{method:'POST'});toast(r.ok?'✅ Token request sent — approve on your Upstox app':'❌ Failed: '+JSON.stringify(r.data));document.getElementById('tokenBtn').disabled=false;setTimeout(loadStatus,3000);}
async function toggleKillSwitch(){const isOn=document.getElementById('killToggle').checked;await api('/api/kill-switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:isOn?'on':'off'})});document.getElementById('killText').textContent=isOn?'ON':'OFF';document.getElementById('killBanner').classList.toggle('hidden',!isOn);toast(isOn?'⚠ Kill switch ACTIVATED':'✅ Kill switch deactivated');}
async function loadInstruments(){const r=await api('/api/instruments');const sel=document.getElementById('obInstrument');sel.innerHTML='<option value="">— Select —</option>';for(const inst of r.instruments){sel.innerHTML+='<option value="'+inst.key+'" data-symbol="'+inst.symbol+'" data-lot="'+inst.lot_size+'">'+inst.name+' ('+inst.symbol+', lot: '+inst.lot_size+')</option>';}}
async function onInstrumentChange(){const sel=document.getElementById('obInstrument');const opt=sel.options[sel.selectedIndex];if(!opt||!opt.value)return;obState.instrumentKey=opt.value;obState.lotSize=parseInt(opt.dataset.lot||'1',10);document.getElementById('obExpiry').disabled=true;document.getElementById('obExpiry').innerHTML='<option value="">Loading...</option>';document.getElementById('atmInfo').classList.add('hidden');const r=await api('/api/option-expiries?instrument_key='+encodeURIComponent(obState.instrumentKey));const expSel=document.getElementById('obExpiry');if(r.error){expSel.innerHTML='<option value="">Error: '+r.error+'</option>';return;}if(!r.expiries||r.expiries.length===0){expSel.innerHTML='<option value="">No expiries found</option>';return;}expSel.innerHTML='<option value="">— Select expiry —</option>';for(const exp of r.expiries){expSel.innerHTML+='<option value="'+exp+'">'+exp+'</option>';}expSel.disabled=false;updateGeneratedJSON();}
async function onExpiryChange(){obState.expiry=document.getElementById('obExpiry').value;if(!obState.expiry||!obState.instrumentKey)return;await fetchATM();updateGeneratedJSON();}
async function onOptionTypeChange(){obState.selectedType=document.getElementById('obOptionType').value;if(obState.expiry&&obState.instrumentKey)await fetchATM();updateGeneratedJSON();}
async function fetchATM(){const type=document.getElementById('obOptionType').value;const r=await api('/api/atm-strike?instrument_key='+encodeURIComponent(obState.instrumentKey)+'&expiry_date='+encodeURIComponent(obState.expiry)+'&type='+type);if(r.error){toast('❌ ATM fetch failed: '+(r.error||''));document.getElementById('atmInfo').classList.add('hidden');return;}obState.instrumentToken=r.instrument_key;obState.atmStrike=r.atm_strike;obState.spotPrice=r.spot_price;document.getElementById('atmInfo').classList.remove('hidden');document.getElementById('atmStrike').textContent=r.atm_strike;document.getElementById('atmSpot').textContent=r.spot_price;document.getElementById('atmLtp').textContent=r.ltp||'—';document.getElementById('atmToken').textContent=r.instrument_key;toast('✅ ATM strike '+r.atm_strike+' '+type+' selected (LTP: ₹'+r.ltp+')');}
function updateGeneratedJSON(){if(!obState.instrumentToken){document.getElementById('jsonOutput').textContent='Fill in the fields above to generate JSON...';return;}const lots=parseInt(document.getElementById('obLots').value||'1',10);const qty=lots*obState.lotSize;document.getElementById('obQty').value=qty;const payload={action:document.getElementById('obAction').value,instrument_token:obState.instrumentToken,quantity:qty,};const orderType=document.getElementById('obOrderType').value;if(orderType!=='MARKET')payload.order_type=orderType;const product=document.getElementById('obProduct').value;if(product!=='D')payload.product=product;const exitTarget=document.getElementById('obExitTarget').value;const exitSL=document.getElementById('obExitSL').value;const trailSL=document.getElementById('obTrailSL').value;const trailAct=document.getElementById('obTrailAct').value;if(exitTarget)payload.exit_target_points=parseFloat(exitTarget);if(exitSL)payload.exit_sl_points=parseFloat(exitSL);if(trailSL)payload.trailing_sl_points=parseFloat(trailSL);if(trailAct)payload.trailing_activation_points=parseFloat(trailAct);document.getElementById('jsonOutput').textContent=JSON.stringify(payload,null,2);}
function copyJSON(){const text=document.getElementById('jsonOutput').textContent;if(text.startsWith('Fill')){toast('Nothing to copy yet');return;}navigator.clipboard.writeText(text).then(()=>toast('✅ JSON copied!')).catch(()=>{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);toast('✅ JSON copied!');});}
function copyWebhookUrl(){const url=window.location.origin+'/webhook?token=YOUR_WEBHOOK_SECRET';navigator.clipboard.writeText(url).then(()=>toast('✅ Webhook URL copied! (replace YOUR_WEBHOOK_SECRET)')).catch(()=>{const ta=document.createElement('textarea');ta.value=url;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);toast('✅ Webhook URL copied!');});}
async function placeBuilderOrder(){if(!obState.instrumentToken){toast('Select instrument & expiry first');return;}const lots=parseInt(document.getElementById('obLots').value||'1',10);const qty=lots*obState.lotSize;const payload={action:document.getElementById('obAction').value,instrument_token:obState.instrumentToken,quantity:qty,order_type:document.getElementById('obOrderType').value,product:document.getElementById('obProduct').value,};const et=document.getElementById('obExitTarget').value,es=document.getElementById('obExitSL').value,ts=document.getElementById('obTrailSL').value,ta=document.getElementById('obTrailAct').value;if(et)payload.exit_target_points=parseFloat(et);if(es)payload.exit_sl_points=parseFloat(es);if(ts)payload.trailing_sl_points=parseFloat(ts);if(ta)payload.trailing_activation_points=parseFloat(ta);const r=await api('/api/manual-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});toast(r.ok?'✅ Order placed!':'❌ Failed: '+JSON.stringify(r.result||r.error));loadStatus();}
async function loadSignals(){const data=await api('/api/signals');const body=document.getElementById('signalsBody');if(!data||data.length===0){body.innerHTML='<tr><td colspan="5" class="muted">No signals yet</td></tr>';return;}body.innerHTML=data.map(s=>{const p=s.payload||{};const action=p.action||'—';const inst=(p.instrument_token||'—').substring(0,30);const st=s.status||'—';const cls=st==='order_placed'?'green':st==='duplicate'?'amber':'red';const raw=s.raw_message||'—';return '<tr><td>'+fmtTime(s.timestamp)+'</td><td><span class="pill '+(action==='BUY'?'buy':'sell')+'">'+action+'</span></td><td>'+inst+'</td><td><span class="badge '+cls+'">'+st+'</span></td><td class="raw-msg" title="'+raw.replace(/"/g,'"')+'">'+raw.substring(0,80)+'</td></tr>';}).join('');}
async function loadOrders(){const data=await api('/api/orders');const body=document.getElementById('ordersBody');if(!data||data.length===0){body.innerHTML='<tr><td colspan="5" class="muted">No orders yet</td></tr>';return;}body.innerHTML=data.map(o=>{const ok=o.ok?'<span class="badge green">Success</span>':'<span class="badge red">Failed</span>';return '<tr><td>'+fmtTime(o.timestamp)+'</td><td>'+(o.type||'—')+'</td><td>'+(o.instrument_token||'—').substring(0,30)+'</td><td>'+(o.action||o.transaction_type||'—')+'</td><td>'+ok+'</td></tr>';}).join('');}
async function loadPositions(){const data=await api('/api/positions');const body=document.getElementById('positionsBody');if(!Array.isArray(data)||data.length===0){body.innerHTML='<tr><td colspan="5" class="muted">No tracked positions</td></tr>';return;}body.innerHTML=data.map(p=>'<tr><td>'+(p.instrument_token||'—').substring(0,30)+'</td><td><span class="pill '+(p.transaction_type==='BUY'?'buy':'sell')+'">'+p.transaction_type+'</span></td><td>'+p.quantity+'</td><td>'+(p.entry_price||'—')+'</td><td>'+(p.highest_price||p.lowest_price||'—')+'</td></tr>').join('');}
async function loadUpstoxPositions(){const r=await api('/api/upstox-positions');const body=document.getElementById('positionsBody');if(r.error){body.innerHTML='<tr><td colspan="5" class="muted">Error: '+r.error+'</td></tr>';return;}const positions=(r.data&&r.data.data)||[];if(positions.length===0){body.innerHTML='<tr><td colspan="5" class="muted">No open positions on Upstox</td></tr>';return;}body.innerHTML=positions.map(p=>'<tr><td>'+(p.instrument_token||'—').substring(0,30)+'</td><td><span class="pill '+(p.transaction_type==='BUY'?'buy':'sell')+'">'+(p.transaction_type||'—')+'</span></td><td>'+(p.quantity||'—')+'</td><td>'+(p.average_price||'—')+'</td><td>'+(p.last_price||'—')+'</td></tr>').join('');}
async function loadExitConfig(){const c=await api('/api/exit-config');document.getElementById('exitEnabled').checked=c.enabled;document.getElementById('exitMode').value=c.mode||'none';document.getElementById('trailSL').value=c.trailing_sl_points;document.getElementById('trailAct').value=c.trailing_activation_points;document.getElementById('fixedSL').value=c.fixed_sl_points;document.getElementById('fixedTarget').value=c.fixed_target_points;}
async function saveExitConfig(){const body={enabled:document.getElementById('exitEnabled').checked,mode:document.getElementById('exitMode').value,trailing_sl_points:parseFloat(document.getElementById('trailSL').value),trailing_activation_points:parseFloat(document.getElementById('trailAct').value),fixed_sl_points:parseFloat(document.getElementById('fixedSL').value),fixed_target_points:parseFloat(document.getElementById('fixedTarget').value),};await api('/api/exit-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('✅ Exit config saved — mode: '+body.mode);}
async function loadSettings(){const s=await api('/api/settings');document.getElementById('setClientId').value=s.upstox_client_id||'';document.getElementById('setClientSecret').value='';document.getElementById('setWebhookSecret').value='';const status=document.getElementById('settingsStatus');let parts=[];if(s.has_client_id)parts.push('✅ API Key set');else parts.push('❌ API Key missing');if(s.has_client_secret)parts.push('✅ API Secret set');else parts.push('❌ API Secret missing');if(s.has_webhook_secret)parts.push('✅ Webhook Secret set');else parts.push('❌ Webhook Secret missing');status.innerHTML=parts.join(' &nbsp; ');}
async function saveSettings(){const body={};const cid=document.getElementById('setClientId').value.trim();const cs=document.getElementById('setClientSecret').value.trim();const ws=document.getElementById('setWebhookSecret').value.trim();if(cid)body.upstox_client_id=cid;if(cs)body.upstox_client_secret=cs;if(ws)body.webhook_secret=ws;if(!cid&&!cs&&!ws){toast('No changes to save');return;}await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('✅ Settings saved!');loadSettings();loadStatus();}
loadStatus();loadInstruments();setInterval(loadStatus,30000);
</script>
</body></html>`;
