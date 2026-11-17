// btc-race-24h bot: a fee-aware, long-only trend follower for cbBTC/USDC.
//
// Strategy in one paragraph: a full round trip costs roughly 12-26 bps in
// fees, slippage and pool impact, while one-minute noise is only ~6 bps, so
// this bot ignores minute-level motion entirely. Its default posture is to
// be long early -- as soon as the opening bars show the price is not in
// freefall and holds above its 30-minute EMA -- because on a drifting day
// every hour spent waiting for a "proven" trend is paid for in entry price,
// and tight stops inside the noise band (this market pulls back 1-2% on
// ordinary days) only convert recoverable dips into realized losses and
// fees. It leaves the position alone unless the slow regime truly breaks
// (price under its 4-hour EMA by a buffer, sustained), a wide hard stop
// fires, or the account's drawdown brake trips. After any exit it cools
// down, longer after a loss, so a choppy day costs a handful of trades,
// not dozens.
//
// Risk rails, in order: a wide per-position hard stop, a sustained break
// of the buffered slow regime line, an equity drawdown brake that flattens
// and pauses, and a deeper drawdown level that stops entries for the rest
// of the run. A tiny late "guardrail" trade
// makes sure the bot has at least one filled order in a window where no
// signal ever fired (the race ranks an entry with no trades below every
// entry that has one), at a cost of a fraction of a cent.
//
// Deterministic: the bot is a pure function of the bars it is sent. It
// reads no clock, no environment and no files, and uses no randomness.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- signal parameters (in bars; one bar is one minute) -------------------
const EMA_FAST_N = 30;        // 30-minute EMA
const EMA_SLOW_N = 240;       // 4-hour EMA (the slow regime line)
const ENTRY_CONFIRM = 3;      // entry signal must hold this many bars
const ENTRY_DELAY = 10;       // first bars are observation only
const ENTRY_MAX_DIP = 0.004;  // no entry if price fell > 0.4% from the open
const EXIT_CONFIRM = 45;      // regime break must hold this many bars
const EXIT_BUFFER = 0.008;    // regime line is the slow EMA less this buffer

// --- sizing and exits -------------------------------------------------------
const SIZE_PERCENT = 90n;     // spend this share of cash on a full entry
const STOP_LOSS = 0.03;       // hard stop: -3% from the entry reference close
const COOLDOWN = 90;          // bars to wait after an exit
const COOLDOWN_LOSS = 240;    // bars to wait after a losing exit
const DD_BRAKE = 0.08;        // equity drawdown from peak: flatten and pause
const DD_PAUSE = 360;         // pause length after the brake trips
const DD_STOP = 0.13;         // deeper drawdown: no new entries for the rest
const MAX_SLIPPAGE_BPS = 150; // bound on fill distance from the latest close

// --- guardrail trade (guarantees >= 1 filled order in a signal-less run) ----
const GUARD_DEADLINE = 1250;        // scored bar by which a trade must have happened
const GUARD_NOTIONAL = 5_000_000n;  // 5 USDC
const MIN_NOTIONAL = 1_000_000n;    // the market's 1 USDC minimum buy

// --- strategy state (rebuilt on hello, so a run starts clean) ---------------
const closes: number[] = [];
let emaFast = 0;
let emaSlow = 0;
let seenBar = false;
let entryStreak = 0;
let exitStreak = 0;
let inPosition = false;
let pendingEntry = false;
let entryRef = 0;        // close at the entry decision (raw price units)
let peakClose = 0;       // highest close since the entry decision
let equityAtEntry = 0;   // equity when the position was first seen
let cooldownUntil = -1;  // scored-bar index before which no entry
let pauseUntil = -1;     // scored-bar index before which no entry (brake)
let peakEquity = 0;
let startEquity = 0;
let stopEntries = false; // DD_STOP latched
let trades = 0;          // our filled orders (not the harness's _flatten_)
let guardDone = false;

function reset(state: BarsState): void {
  closes.length = 0;
  emaFast = 0;
  emaSlow = 0;
  seenBar = false;
  entryStreak = 0;
  exitStreak = 0;
  inPosition = false;
  pendingEntry = false;
  entryRef = 0;
  peakClose = 0;
  equityAtEntry = 0;
  cooldownUntil = -1;
  pauseUntil = -1;
  peakEquity = Number(state.equity);
  startEquity = Number(state.equity);
  stopEntries = false;
  trades = 0;
  guardDone = false;
}

function entrySignal(barIndex: number): boolean {
  // Long early, but never into a falling open: the price must have held
  // roughly level with the window's first close and sit above its
  // 30-minute EMA.
  if (barIndex < ENTRY_DELAY || closes.length === 0) return false;
  const c = closes[closes.length - 1];
  return c >= closes[0] * (1 - ENTRY_MAX_DIP) && c > emaFast;
}

function exitSignal(): boolean {
  // The slow regime has broken only when price sits under the buffered
  // 4-hour EMA; ordinary 1-2% pullbacks stay above that line.
  const c = closes[closes.length - 1];
  return c < emaSlow * (1 - EXIT_BUFFER);
}

function buyOrder(state: BarsState, notional: bigint): OrderInput | null {
  const room = state.weightRoom(SYMBOL);
  let spend = notional < room ? notional : room;
  if (spend > state.cash) spend = state.cash;
  if (spend < MIN_NOTIONAL) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellAllOrder(state: BarsState): OrderInput | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty <= 0n) return null;
  return { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // Count our filled orders from this batch's fills (the harness's own
  // end-of-window closes carry client ids starting with "_": not ours).
  for (const fill of batch.fills) {
    if (fill.status === 'filled' && !fill.client_id.startsWith('_')) trades += 1;
  }

  const closeBig = state.close(SYMBOL);
  if (closeBig === null) return [];
  const close = Number(closeBig);

  // Indicators first: this bar's close feeds every decision below.
  closes.push(close);
  if (!seenBar) {
    emaFast = close;
    emaSlow = close;
    seenBar = true;
  } else {
    emaFast += (2 / (EMA_FAST_N + 1)) * (close - emaFast);
    emaSlow += (2 / (EMA_SLOW_N + 1)) * (close - emaSlow);
  }

  const barIndex = state.seq - state.warmupBars;
  const equity = Number(state.equity);

  // Sync position state from the account the harness reports.
  const held = state.positions.get(SYMBOL);
  const holding = held !== undefined && held.qty > 0n;
  if (holding && !inPosition) {
    // An entry filled on the previous bar.
    inPosition = true;
    pendingEntry = false;
    equityAtEntry = equity;
    peakClose = close;
  } else if (!holding && inPosition) {
    // An exit filled: cool down, longer if the round trip lost money.
    inPosition = false;
    exitStreak = 0;
    const lost = equityAtEntry > 0 && equity < equityAtEntry;
    cooldownUntil = barIndex + (lost ? COOLDOWN_LOSS : COOLDOWN);
  }
  if (inPosition && close > peakClose) peakClose = close;

  // Drawdown bookkeeping on the harness's own equity marks.
  if (equity > peakEquity) peakEquity = equity;
  if (startEquity > 0 && equity <= startEquity * (1 - DD_STOP)) stopEntries = true;

  if (state.warmingUp) return [];

  // --- exits -----------------------------------------------------------------
  if (inPosition) {
    let sell: OrderInput | null = null;
    if (entryRef > 0 && close <= entryRef * (1 - STOP_LOSS)) {
      sell = sellAllOrder(state); // hard stop: no delay
    } else if (exitSignal()) {
      exitStreak += 1;
      if (exitStreak >= EXIT_CONFIRM) sell = sellAllOrder(state); // confirmed trend break
    } else {
      exitStreak = 0;
    }
    if (sell === null && peakEquity > 0 && equity <= peakEquity * (1 - DD_BRAKE)) {
      sell = sellAllOrder(state); // drawdown brake
      pauseUntil = barIndex + DD_PAUSE;
    }
    return sell === null ? [] : [sell];
  }

  // --- entries -----------------------------------------------------------------
  entryStreak = entrySignal(barIndex) ? entryStreak + 1 : 0;
  const blocked = stopEntries || barIndex < cooldownUntil || barIndex < pauseUntil || pendingEntry;
  if (!blocked && entryStreak >= ENTRY_CONFIRM) {
    const order = buyOrder(state, (state.cash * SIZE_PERCENT) / 100n);
    if (order !== null) {
      entryRef = close;
      peakClose = close;
      pendingEntry = true;
      return [order];
    }
  }

  // --- guardrail: one small trade so the run is never tradeless -----------------
  if (!guardDone && trades === 0 && !pendingEntry && barIndex >= GUARD_DEADLINE) {
    const order = buyOrder(state, GUARD_NOTIONAL);
    if (order !== null) {
      entryRef = close;
      peakClose = close;
      pendingEntry = true;
      guardDone = true;
      return [order];
    }
  }

  return [];
}

await runBars({
  onHello(state) {
    reset(state);
  },
  onBatch,
});
