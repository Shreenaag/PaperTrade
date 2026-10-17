import type { MarketPhase } from "../../shared/marketClock.js";
import { toTickString } from "../market/fairValue.js";
import type { PlaceOrderInput } from "../orders/orders.service.js";

// What each dummy trader wants to do, given what it can see. Pure: no I/O, randomness injected,
// so the behaviour is unit-tested and the runner (bots.ts) only does the plumbing.
//   MARKET_MAKER  keeps one bid and one ask a little around the hidden fair value (PRE_OPEN + OPEN);
//                 its quotes give the opening auction and players someone to trade with
//   NOISE         random small orders near fair value (OPEN): volume and a bit of randomness
//   MOMENTUM      chases the traded price when it moved since its last look (OPEN): trends players can ride
// Player flow (P5 feedback: the market must react to the player): right after a player's order, its stock's bots
// trade WITH the player for a while (momentum every tick, noise mostly on the player's side), and the hidden fair
// value jumps by impactOf(); the market maker re-quotes around it, so the player's order finds a counterparty.

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
  impactPerLakh: 0.03, // a player's ₹1,00,000 order moves the fair value 3% (dramatic, by request)...
  impactCap: 0.08, // ...but one order moves it at most 8%
  flowSeconds: 15, // how long the stock's bots follow the player's order
  noiseWithFlow: 0.75, // share of noise orders on the player's side while following
} as const;

// Signed fraction a player's order moves the fair value by.
export function impactOf(side: "BUY" | "SELL", value: number): number {
  const size = Math.min(BotRules.impactCap, (BotRules.impactPerLakh * value) / 100_000);
  return side === "BUY" ? size : -size;
}

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
  flow: "BUY" | "SELL" | null; // a player just traded this stock in this direction
  tick: number;
  lot: number;
  open: OpenOrder[]; // oldest first, pending cancels already removed
}

export interface Plan {
  cancel: string[];
  place: PlaceOrderInput[];
}

export function decide(v: BotView, rand: () => number = Math.random): Plan {
  if (v.kind === "MARKET_MAKER") return v.phase === "PRE_OPEN" || v.phase === "OPEN" ? quote(v) : idle;
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
  const opposite = (s: "BUY" | "SELL") => (s === "BUY" ? "SELL" : "BUY");
  const side = v.flow ? (rand() < BotRules.noiseWithFlow ? v.flow : opposite(v.flow)) : rand() < 0.5 ? "BUY" : "SELL";
  const quantity = sizeFor(BotRules.noiseValue, v.fair, v.lot);
  const order: PlaceOrderInput =
    rand() < 0.5
      ? { symbol: v.symbol, side, type: "MARKET", quantity }
      : { symbol: v.symbol, side, type: "LIMIT", quantity, limitPrice: toTickString(v.fair * (1 + (rand() - 0.5) * 2 * BotRules.noiseBand), v.tick) };
  return { cancel: oldestOverCap(v.open), place: [order] };
}

function momentum(v: BotView): Plan {
  if (v.flow) {
    const quantity = sizeFor(BotRules.momentumValue, v.last, v.lot);
    return { cancel: oldestOverCap(v.open), place: [{ symbol: v.symbol, side: v.flow, type: "MARKET", quantity }] };
  }
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
