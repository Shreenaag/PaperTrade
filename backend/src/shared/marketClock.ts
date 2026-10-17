// Market calendar: one "trading day" every 6 min 20 s, back-to-back, forever.
// Mostly open, so the game runs at the player's pace (P5 feedback):
//   PRE_OPEN   30 s     prices frozen at previous close; orders queue, nothing fills;
//                       at OPEN an opening auction fills crossing orders at one price per symbol
//   OPEN       5 min    prices move; continuous matching
//   POST_CLOSE 30 s     prices frozen at the close; orders fill only at the closing price;
//                       unfilled LIMIT orders carry over to the next day (while the worker keeps running)
//   CLOSED     20 s     a pause before the next day: no new orders (cancels still work), nothing trades
//
// Pure function of wall-clock time: the API and every worker compute the same phase with no shared state.
// The phase at the moment an order is *matched* decides how it fills, not the phase when it was placed.

export const MarketPhases = ["PRE_OPEN", "OPEN", "POST_CLOSE", "CLOSED"] as const;
export type MarketPhase = (typeof MarketPhases)[number];

export const PHASE_SECONDS: Record<MarketPhase, number> = { PRE_OPEN: 30, OPEN: 300, POST_CLOSE: 30, CLOSED: 20 };

export const DAY_SECONDS = MarketPhases.reduce((s, p) => s + PHASE_SECONDS[p], 0); // 380
// Day numbers must only ever go up: books, bars, order expiry and bot top-ups all compare them.
// Changing the day length therefore restarts the count from a new epoch at a number above every day used so far
// (the 10-minute days reached ~41,700 and the 6-minute days ~69,500). Keep frontend/src/format.ts in step.
const EPOCH_MS = Date.UTC(2026, 9, 17, 17, 0); // start of trading day FIRST_DAY; one day every 6 min 20 s from here
const FIRST_DAY = 70_000;

export interface MarketSession {
  tradingDay: number;
  phase: MarketPhase;
  phaseStartsAt: Date;
  phaseEndsAt: Date;
}

export function dayStartsAt(tradingDay: number): Date {
  return new Date(EPOCH_MS + (tradingDay - FIRST_DAY) * DAY_SECONDS * 1000);
}

export function sessionAt(now: Date = new Date()): MarketSession {
  const elapsedMs = now.getTime() - EPOCH_MS;
  const tradingDay = FIRST_DAY + Math.floor(elapsedMs / (DAY_SECONDS * 1000));
  let phaseStartMs = dayStartsAt(tradingDay).getTime();
  for (const phase of MarketPhases) {
    const phaseEndMs = phaseStartMs + PHASE_SECONDS[phase] * 1000;
    if (now.getTime() < phaseEndMs) {
      return { tradingDay, phase, phaseStartsAt: new Date(phaseStartMs), phaseEndsAt: new Date(phaseEndMs) };
    }
    phaseStartMs = phaseEndMs;
  }
  throw new Error("unreachable: phases cover the whole day");
}
