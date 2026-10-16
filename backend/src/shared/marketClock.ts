// Market calendar: one "trading day" every 10 minutes, back-to-back, forever.
//   PRE_OPEN   2.5 min  prices frozen at previous close; orders queue, nothing fills;
//                       at OPEN an opening auction fills crossing orders at one price per symbol
//   OPEN       5 min    prices move; continuous matching
//   POST_CLOSE 2.5 min  prices frozen at the close; orders fill only at the closing price;
//                       at the end, unfilled orders EXPIRE (day orders) and reservations are released
//
// Pure function of wall-clock time: the API and every worker compute the same phase with no shared state.
// The phase at the moment an order is *matched* decides how it fills, not the phase when it was placed.

export const MarketPhases = ["PRE_OPEN", "OPEN", "POST_CLOSE"] as const;
export type MarketPhase = (typeof MarketPhases)[number];

export const PHASE_SECONDS: Record<MarketPhase, number> = { PRE_OPEN: 150, OPEN: 300, POST_CLOSE: 150 };

export const DAY_SECONDS = MarketPhases.reduce((s, p) => s + PHASE_SECONDS[p], 0); // 600
const EPOCH_MS = Date.UTC(2026, 0, 1); // trading day 0; days start on :00/:10/:20... boundaries

export interface MarketSession {
  tradingDay: number;
  phase: MarketPhase;
  phaseStartsAt: Date;
  phaseEndsAt: Date;
}

export function dayStartsAt(tradingDay: number): Date {
  return new Date(EPOCH_MS + tradingDay * DAY_SECONDS * 1000);
}

export function sessionAt(now: Date = new Date()): MarketSession {
  const elapsedMs = now.getTime() - EPOCH_MS;
  const tradingDay = Math.floor(elapsedMs / (DAY_SECONDS * 1000));
  let phaseStartMs = EPOCH_MS + tradingDay * DAY_SECONDS * 1000;
  for (const phase of MarketPhases) {
    const phaseEndMs = phaseStartMs + PHASE_SECONDS[phase] * 1000;
    if (now.getTime() < phaseEndMs) {
      return { tradingDay, phase, phaseStartsAt: new Date(phaseStartMs), phaseEndsAt: new Date(phaseEndMs) };
    }
    phaseStartMs = phaseEndMs;
  }
  throw new Error("unreachable: phases cover the whole day");
}
