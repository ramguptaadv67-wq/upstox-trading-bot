/**
 * TRONE Strategy — 45m Setup + 3m Entry + TSL Exit
 *
 * Parameters are exposed to dashboard via module.exports.params.
 * Code is NOT shown on dashboard — only params are editable.
 */

const params = {
  setupBodyPts:      { label: "45m Setup Min Body (pts)",   value: 17,  type: "number" },
  entryBodyPts:      { label: "3m Entry Min Body (pts)",     value: 2,   type: "number" },
  breakoutBufferPts: { label: "Breakout Buffer (pts)",       value: 6,   type: "number" },
  rejectionBufferPts: { label: "Rejection Buffer (pts)",      value: 3,   type: "number" },
  tslPts:            { label: "TSL Points",                   value: 7,   type: "number" },
  tslRejectionPts:   { label: "TSL Rejection Points",         value: 1,   type: "number" },
  activateTslAfterPts: { label: "Activate TSL After (pts)",   value: 98,  type: "number" },
  swingLookback:     { label: "Swing Lookback (bars)",        value: 20,  type: "number" },
};

function run(candles, htfCandles, state, params, helpers) {
  const { sma, emaArray, ema, rsi, highest, lowest, crossover, crossunder } = helpers;

  // === INIT STATE ===
  if (!state.setupOpen) state.setupOpen = null;
  if (!state.setupClose) state.setupClose = null;
  if (!state.setupType) state.setupType = null;
  if (!state.position) state.position = null;
  if (!state.triggerStop) state.triggerStop = null;
  if (!state.highestSinceEntry) state.highestSinceEntry = null;

  const p = {
    setupBodyPts:      params.setupBodyPts.value,
    entryBodyPts:      params.entryBodyPts.value,
    breakoutBufferPts: params.breakoutBufferPts.value,
    rejectionBufferPts: params.rejectionBufferPts.value,
    tslPts:            params.tslPts.value,
    tslRejectionPts:   params.tslRejectionPts.value,
    activateTslAfterPts: params.activateTslAfterPts.value,
    swingLookback:     params.swingLookback.value,
  };

  if (candles.length < 5) return null;
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // === HTF (45m) SETUP DETECTION ===
  if (htfCandles && htfCandles.length >= 2) {
    const htf = htfCandles[htfCandles.length - 1];
    const htfPrev = htfCandles[htfCandles.length - 2];
    const htfBody = Math.abs(htf.close - htf.open);

    if (htfBody >= p.setupBodyPts) {
      if (htf.close > htf.open) {
        state.setupOpen = htf.open;
        state.setupClose = htf.close;
        state.setupType = "bull";
        state.triggerStop = htf.open;
      } else {
        state.setupOpen = htf.open;
        state.setupClose = htf.close;
        state.setupType = "bear";
        state.triggerStop = htf.open;
      }
    }
  }

  if (!state.setupOpen) return null;

  // === ENTRY LOGIC (3m) ===
  const flat = !state.position;
  const body = Math.abs(cur.close - cur.open);

  if (flat && state.setupType === "bull") {
    const breakoutLevel = state.setupClose + p.breakoutBufferPts;
    if (cur.close > breakoutLevel && body >= p.entryBodyPts) {
      state.position = { type: "CE", entryPrice: cur.close, kind: "breakout" };
      state.triggerStop = state.setupOpen;
      state.highestSinceEntry = cur.high;
      return "BUY_CE";
    }
    const rejectionLevel = state.setupOpen - p.rejectionBufferPts;
    if (cur.low <= rejectionLevel && cur.close > state.setupOpen && body >= p.entryBodyPts) {
      state.position = { type: "CE", entryPrice: cur.close, kind: "rejection" };
      state.triggerStop = state.setupOpen - p.tslRejectionPts;
      state.highestSinceEntry = cur.high;
      return "BUY_CE";
    }
  }

  if (flat && state.setupType === "bear") {
    const breakoutLevel = state.setupClose - p.breakoutBufferPts;
    if (cur.close < breakoutLevel && body >= p.entryBodyPts) {
      state.position = { type: "PE", entryPrice: cur.close, kind: "breakout" };
      state.triggerStop = state.setupOpen;
      state.highestSinceEntry = cur.low;
      return "BUY_PE";
    }
    const rejectionLevel = state.setupOpen + p.rejectionBufferPts;
    if (cur.high >= rejectionLevel && cur.close < state.setupOpen && body >= p.entryBodyPts) {
      state.position = { type: "PE", entryPrice: cur.close, kind: "rejection" };
      state.triggerStop = state.setupOpen + p.tslRejectionPts;
      state.highestSinceEntry = cur.low;
      return "BUY_PE";
    }
  }

  // === TSL EXIT LOGIC ===
  if (state.position) {
    const isLong = state.position.type === "CE";
    const entryPrice = state.position.entryPrice;

    if (isLong) {
      if (cur.high > (state.highestSinceEntry || 0)) state.highestSinceEntry = cur.high;
      const profit = (state.highestSinceEntry || entryPrice) - entryPrice;

      if (profit >= p.activateTslAfterPts) {
        state.triggerStop = Math.max(state.triggerStop, (state.highestSinceEntry || entryPrice) - p.tslPts);
      }
      if (cur.low <= (state.triggerStop || 0)) {
        state.position = null;
        state.triggerStop = null;
        state.highestSinceEntry = null;
        return "EXIT_CE";
      }
    } else {
      if (cur.low < (state.highestSinceEntry || 999999)) state.highestSinceEntry = cur.low;
      const profit = entryPrice - (state.highestSinceEntry || entryPrice);

      if (profit >= p.activateTslAfterPts) {
        state.triggerStop = Math.min(state.triggerStop || 999999, (state.highestSinceEntry || entryPrice) + p.tslPts);
      }
      if (cur.high >= (state.triggerStop || 999999)) {
        state.position = null;
        state.triggerStop = null;
        state.highestSinceEntry = null;
        return "EXIT_PE";
      }
    }
  }

  return null;
}

module.exports = { name: "TRONE", params, run, needsHtf: true };
