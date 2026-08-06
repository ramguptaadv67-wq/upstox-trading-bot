/**
 * Engulfing + Doji Touch + TSL Exit Strategy
 *
 * Converted from Pine Script v5 "NIFTY — webhook ()"
 * — Engulfing detection sets a setup line
 * — Doji touching that line triggers entry
 * — TSL exit with profit-locking trail
 *
 * Parameters are exposed to dashboard via module.exports.params.
 * Code is NOT shown on dashboard — only params are editable.
 */

const params = {
  engulfMin:     { label: "Engulfing Min Body (pts)",  value: 16, type: "number" },
  dojiBodyMax:   { label: "Max Doji Body (pts)",         value: 16, type: "number" },
  activationPts: { label: "Activate At (pts)",           value: 12, type: "number" },
  lockProfit:    { label: "Lock Profit At (pts)",        value: 8,  type: "number" },
  profitStep:    { label: "Increase Profit By (pts)",    value: 6,  type: "number" },
  trailStep:     { label: "Increase TSL By (pts)",       value: 6,  type: "number" },
};

function run(candles, htfCandles, state, params, helpers) {
  // Extract param values
  const p = {};
  for (const k in params) p[k] = params[k].value;

  // === INIT STATE ===
  if (!state.setupLine) state.setupLine = null;
  if (!state.setupType) state.setupType = null;
  if (!state.position) state.position = null;
  if (!state.longHh) state.longHh = null;
  if (!state.shortLl) state.shortLl = null;
  if (!state.longTsl) state.longTsl = null;
  if (!state.shortTsl) state.shortTsl = null;

  if (candles.length < 2) return null;

  const n = candles.length;
  const cur = candles[n - 1];
  const prev = candles[n - 2];

  // === Body helpers ===
  const body = Math.abs(cur.close - cur.open);
  const isBull = cur.close > cur.open;
  const isBear = cur.close < cur.open;
  const prevIsBull = prev.close > prev.open;
  const prevIsBear = prev.close < prev.open;

  // === Engulfing Detection ===
  const bullEngulf =
    isBull &&
    prevIsBear &&
    cur.close > prev.open &&
    cur.open < prev.close &&
    body >= p.engulfMin;

  const bearEngulf =
    isBear &&
    prevIsBull &&
    cur.close < prev.open &&
    cur.open > prev.close &&
    body >= p.engulfMin;

  if (bullEngulf) {
    state.setupLine = (cur.open + cur.close) / 2;
    state.setupType = "bull";
  }
  if (bearEngulf) {
    state.setupLine = (cur.open + cur.close) / 2;
    state.setupType = "bear";
  }

  // === Doji Detection (matches Pine Script: body <= doji_body_max AND (high-low) >= body()*2) ===
  const isDoji = body <= p.dojiBodyMax && (cur.high - cur.low) >= body * 2;
  const valid = state.setupLine !== null;
  const touchesLine = valid && cur.high >= state.setupLine && cur.low <= state.setupLine;
  const greenDoji = isDoji && cur.close > cur.open;
  const redDoji = isDoji && cur.close < cur.open;

  // === Entry Signals ===
  const flat = !state.position;
  if (touchesLine && greenDoji && flat) {
    state.position = { type: "CE", entryPrice: cur.close };
    state.longHh = cur.high;
    state.longTsl = null;
    return "BUY_CE";
  }
  if (touchesLine && redDoji && flat) {
    state.position = { type: "PE", entryPrice: cur.close };
    state.shortLl = cur.low;
    state.shortTsl = null;
    return "BUY_PE";
  }

  // === TSL Exit Logic ===
  if (state.position) {
    const isLong = state.position.type === "CE";
    const isShort = state.position.type === "PE";
    const entryPrice = state.position.entryPrice;

    // === LONG TSL ===
    if (isLong) {
      const profitReached = cur.high - entryPrice >= p.activationPts;
      if (profitReached) {
        state.longHh = state.longHh === null ? cur.high : Math.max(state.longHh, cur.high);
        const extraProfit = Math.max(0, state.longHh - entryPrice - p.activationPts);
        const tslMove = Math.floor(extraProfit / p.profitStep) * p.trailStep;
        state.longTsl = entryPrice + p.lockProfit + tslMove;
      }
      if (state.longTsl !== null && cur.low <= state.longTsl) {
        state.position = null;
        state.longHh = null;
        state.longTsl = null;
        return "EXIT_CE";
      }
    }

    // === SHORT TSL ===
    if (isShort) {
      const profitReached = entryPrice - cur.low >= p.activationPts;
      if (profitReached) {
        state.shortLl = state.shortLl === null ? cur.low : Math.min(state.shortLl, cur.low);
        const extraProfit = Math.max(0, entryPrice - state.shortLl - p.activationPts);
        const tslMove = Math.floor(extraProfit / p.profitStep) * p.trailStep;
        state.shortTsl = entryPrice - p.lockProfit - tslMove;
      }
      if (state.shortTsl !== null && cur.high >= state.shortTsl) {
        state.position = null;
        state.shortLl = null;
        state.shortTsl = null;
        return "EXIT_PE";
      }
    }
  }

  return null;
}

module.exports = { name: "Engulf-Doji-TSL", params, run, needsHtf: false };
