import type { MarketPhase } from "../../shared/marketClock.js";
import { toTickString } from "../market/fairValue.js";
import type { PlaceOrderInput } from "../orders/orders.service.js";

// What each dummy trader wants to do, given what it can see. Pure: no I/O, randomness injected,
// so the behaviour is unit-tested and the runner (bots.ts) only does the plumbing.
//   MARKET_MAKER  keeps one bid and one ask a little around the hidden fair value (PRE_OPEN + OPEN);
//                 its quotes give the opening auction and players someone to trade with
//   NOISE         random small orders near fair value (OPEN): volume and a bit of randomness
//   MOMENTUM      chases the traded price when it moved since its last look (OPEN): trends players can ride

export const BotKinds = ["MARKET_MAKER", "NOISE", "MOMENTUM"] as const;
export type BotKind = (typeof BotKinds)[number];

export const BotRules = {
  quoteValue: 100_000, // ₹ per market-maker quote
  halfSpread: 0.001, // market maker quotes fair value ±0.1%
  noiseValue: 25_000,
  noiseBand: 0.005, // noise LIMIT orders within ±0.5% of fair value
  momentumValue: 50_000,
  momentumTrigger: 0.002, // a 0.2% move since the last look triggers a MARKET order
  maxOpen: 3, // noise/momentum orders left resting before the oldest is cancelled
} as const;

export interface OpenOrder {
  id: string;
  side: "BUY" | "SELL";
  limitPrice: string | null; // "1234.5000"
}

export interface BotView {
  kind: BotKind;
  symbol: string;
  phase: MarketPhase;
  fair: number;
  last: number; // last traded price (previous close before the first trade)
  ref: number | null; // MOMENTUM: last price at its previous look
  tick: number;
  lot: number;
  open: OpenOrder[]; // oldest first, pending cancels already removed
}

export interface Plan {
  cancel: string[];
  place: PlaceOrderInput[];
}

export function decide(v: BotView, rand: () => number = Math.random): Plan {
  if (v.kind === "MARKET_MAKER") return v.phase === "POST_CLOSE" ? idle : quote(v);
  if (v.phase !== "OPEN") return idle;
  return v.kind === "NOISE" ? noise(v, rand) : momentum(v);
}

const idle: Plan = { cancel: [], place: [] };

// Shares worth about `value` rupees, in whole lots, at least one lot.
export function sizeFor(value: number, price: number, lot: number): number {
  return Math.max(1, Math.round(value / price / lot)) * lot;
}

// Requote only when the fair value moved off the current quote: fewer cancels, and resting quotes keep time priority.
function quote(v: BotView): Plan {
  const plan: Plan = { cancel: [], place: [] };
  const quantity = sizeFor(BotRules.quoteValue, v.fair, v.lot);
  for (const side of ["BUY", "SELL"] as const) {
    const target = toTickString(v.fair * (side === "BUY" ? 1 - BotRules.halfSpread : 1 + BotRules.halfSpread), v.tick);
    const mine = v.open.filter((o) => o.side === side);
    plan.cancel.push(...mine.filter((o) => o.limitPrice !== target).map((o) => o.id));
    if (!mine.some((o) => o.limitPrice === target)) plan.place.push({ symbol: v.symbol, side, type: "LIMIT", quantity, limitPrice: target });
  }
  return plan;
}

function noise(v: BotView, rand: () => number): Plan {
  const side = rand() < 0.5 ? "BUY" : "SELL";
  const quantity = sizeFor(BotRules.noiseValue, v.fair, v.lot);
  const order: PlaceOrderInput =
    rand() < 0.5
      ? { symbol: v.symbol, side, type: "MARKET", quantity }
      : { symbol: v.symbol, side, type: "LIMIT", quantity, limitPrice: toTickString(v.fair * (1 + (rand() - 0.5) * 2 * BotRules.noiseBand), v.tick) };
  return { cancel: oldestOverCap(v.open), place: [order] };
}

function momentum(v: BotView): Plan {
  if (v.ref === null) return idle;
  const move = (v.last - v.ref) / v.ref;
  if (Math.abs(move) < BotRules.momentumTrigger) return idle;
  const quantity = sizeFor(BotRules.momentumValue, v.last, v.lot);
  return { cancel: oldestOverCap(v.open), place: [{ symbol: v.symbol, side: move > 0 ? "BUY" : "SELL", type: "MARKET", quantity }] };
}

// Keeps room for one more order under maxOpen.
function oldestOverCap(open: OpenOrder[]): string[] {
  return open.slice(0, Math.max(0, open.length - BotRules.maxOpen + 1)).map((o) => o.id);
}
