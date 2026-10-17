import { createHash } from "node:crypto";
import type { Payload } from "../../shared/events.js";
import { FEE_RATE } from "../../shared/limits.js";
import { MarketPhases, type MarketPhase } from "../../shared/marketClock.js";

// One instrument's order book. Pure and deterministic: no I/O, no clock, no randomness. The same commands
// in the same order always give the same output, which is what makes replaying the Kafka log safe.
//   PRE_OPEN    orders queue; nothing fills
//   -> OPEN     opening auction: one price that trades the most volume, then continuous matching
//               (price-time priority, trade at the resting order's price)
//   POST_CLOSE  fills only at the closing price (last trade of the day)
//   CLOSED      the API takes no new orders; one already in flight is treated like POST_CLOSE
//   -> next day the day's bar is emitted; resting LIMIT orders carry over
// MARKET orders never rest after the auction: they fill up to their protection price, the rest is cancelled.
// Self-trade: the newer of the two orders is cancelled.
// Modify is a PLACE that replaces a resting order (loses time priority), see `replaces` in shared/events.ts.
// Kafka is at-least-once, so a PLACE can arrive twice: the book ignores an order id it has already seen today.

type Command = Payload<"orderCommands">;
type Place = Extract<Command, { kind: "PLACE" }>;
type Execution = Payload<"executions">;
type Side = Place["side"];

export type BookEvent =
  | { kind: "EXEC"; id: string; payload: Execution }
  | { kind: "PRICE"; price: string; phase: MarketPhase }
  | { kind: "BAR"; tradingDay: number; open: string; high: string; low: string; close: string };

interface BookOrder {
  orderId: string;
  userId: string;
  side: Side;
  type: Place["type"];
  price: number; // limit, or protection price for MARKET
  remaining: number;
  seq: number; // arrival order = time priority
}

// Prices in integer units of ₹0.0001 (the DB's Decimal(20,4)): exact compare and multiply, no floats.
const SCALE = 10_000;
export function toUnits(s: string): number {
  const [int = "0", frac = ""] = s.split(".");
  return Number(int) * SCALE + Number(frac.padEnd(4, "0").slice(0, 4));
}
export function fromUnits(u: number): string {
  return `${Math.floor(u / SCALE)}.${String(u % SCALE).padStart(4, "0")}`;
}
const FEE_UNITS = toUnits(FEE_RATE);
const feeUnits = (valueUnits: number) => Math.round((valueUnits * FEE_UNITS) / SCALE);

// Name-based UUID (v5 layout): the same match always gets the same ids, so a replay is deduped downstream.
export function stableUuid(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const phaseIndex = (p: MarketPhase) => MarketPhases.indexOf(p);

export class Book {
  private bids: BookOrder[] = []; // best first: price desc, then seq asc
  private asks: BookOrder[] = []; // best first: price asc, then seq asc
  private seq = 0;
  private seen = new Set<string>(); // order ids placed today, plus resting orders carried from earlier days
  private prevClose: number;
  private last: number | null = null;
  private bar: { open: number; high: number; low: number } | null = null;
  private out: BookEvent[] = [];
  private at = "";

  constructor(
    readonly symbol: string,
    prevClose: string,
    public day: number,
    public phase: MarketPhase = "PRE_OPEN",
  ) {
    this.prevClose = toUnits(prevClose);
  }

  // `at` (ISO time of the command in the log) only stamps executedAt; it never changes matching.
  handle(cmd: Command, at: string): BookEvent[] {
    this.out = [];
    this.at = at;
    if (cmd.kind === "CLOCK") this.advance(cmd.tradingDay, cmd.phase);
    else if (cmd.kind === "CANCEL") this.cancel(cmd.orderId, cmd.userId);
    else this.place(cmd);
    return this.out;
  }

  get openOrders(): number {
    return this.bids.length + this.asks.length;
  }

  private advance(day: number, phase: MarketPhase) {
    const target = day * MarketPhases.length + phaseIndex(phase);
    const now = () => this.day * MarketPhases.length + phaseIndex(this.phase);
    while (now() < target) {
      if (this.phase === "PRE_OPEN" && this.day < day && !this.openOrders && !this.bar) {
        this.day = day; // nothing happened on the skipped days (e.g. worker was off): jump
        continue;
      }
      if (this.phase === "PRE_OPEN") {
        this.phase = "OPEN";
        this.auction();
      } else if (this.phase === "OPEN") {
        this.phase = "POST_CLOSE";
      } else if (this.phase === "POST_CLOSE") {
        this.phase = "CLOSED";
      } else {
        this.endDay();
      }
    }
  }

  private place(cmd: Place) {
    if (this.seen.has(cmd.orderId)) return;
    this.seen.add(cmd.orderId);
    const o: BookOrder = {
      orderId: cmd.orderId,
      userId: cmd.userId,
      side: cmd.side,
      type: cmd.type,
      price: toUnits((cmd.limitPrice ?? cmd.protectionPrice)!),
      remaining: cmd.quantity,
      seq: this.seq++,
    };
    if (cmd.tradingDay < this.day) return this.end(o, "EXPIRED", "DAY_END"); // arrived after its day ended
    if (cmd.tradingDay > this.day) this.advance(cmd.tradingDay, "PRE_OPEN");
    if (cmd.replaces) {
      const old = this.take(cmd.replaces.orderId, cmd.userId, cmd.replaces.remaining);
      if (!old) return this.end(o, "REJECTED", "ORDER_CHANGED"); // filled, cancelled or part-filled since the request
      this.end(old, "CANCELLED", "MODIFIED");
    }
    if (this.phase === "PRE_OPEN") return this.rest(o);

    const ended = this.matchIncoming(o, this.phase === "POST_CLOSE" || this.phase === "CLOSED" ? this.closePrice : null);
    if (ended || o.remaining === 0) return;
    if (o.type === "MARKET") this.end(o, "CANCELLED", "NO_LIQUIDITY");
    else this.rest(o);
  }

  private get closePrice(): number {
    return this.last ?? this.prevClose;
  }

  // fixedPrice set = POST_CLOSE: both sides must accept it and every fill happens at it.
  // Returns true if the incoming order was ended (self-trade).
  private matchIncoming(o: BookOrder, fixedPrice: number | null): boolean {
    const accepts = (x: BookOrder, p: number) => (x.side === "BUY" ? x.price >= p : x.price <= p);
    if (fixedPrice !== null && !accepts(o, fixedPrice)) return false;
    const opposite = o.side === "BUY" ? this.asks : this.bids;
    let i = 0;
    while (o.remaining > 0 && i < opposite.length) {
      const r = opposite[i]!;
      // opposite is sorted best-first, so the first one that doesn't qualify ends the walk
      if (fixedPrice === null ? !accepts(o, r.price) : !accepts(r, fixedPrice)) break;
      if (r.userId === o.userId) {
        this.end(o, "CANCELLED", "SELF_TRADE");
        return true;
      }
      const qty = Math.min(o.remaining, r.remaining);
      this.trade(o.side === "BUY" ? o : r, o.side === "BUY" ? r : o, qty, fixedPrice ?? r.price);
      if (r.remaining === 0) opposite.splice(i, 1);
      else i++;
    }
    return false;
  }

  private auction() {
    const price = this.auctionPrice();
    if (price !== null) {
      let b = 0;
      let a = 0;
      while (b < this.bids.length && a < this.asks.length) {
        const bid = this.bids[b]!;
        const ask = this.asks[a]!;
        if (bid.price < price || ask.price > price) break;
        if (bid.userId === ask.userId) {
          const newer = bid.seq > ask.seq ? this.bids.splice(b, 1)[0]! : this.asks.splice(a, 1)[0]!;
          this.end(newer, "CANCELLED", "SELF_TRADE");
          continue;
        }
        this.trade(bid, ask, Math.min(bid.remaining, ask.remaining), price);
        if (bid.remaining === 0) b++;
        if (ask.remaining === 0) a++;
      }
      this.bids = this.bids.filter((o) => o.remaining > 0);
      this.asks = this.asks.filter((o) => o.remaining > 0);
    }
    for (const o of [...this.bids, ...this.asks]) if (o.type === "MARKET") this.end(o, "CANCELLED", "NO_LIQUIDITY");
    this.bids = this.bids.filter((o) => o.type === "LIMIT");
    this.asks = this.asks.filter((o) => o.type === "LIMIT");
  }

  // Price that executes the most shares; ties -> smallest leftover imbalance -> closest to previous close -> lower.
  private auctionPrice(): number | null {
    const candidates = [...new Set([...this.bids, ...this.asks].map((o) => o.price))].sort((x, y) => x - y);
    let best: { price: number; volume: number; imbalance: number; distance: number } | null = null;
    for (const price of candidates) {
      const buy = this.bids.reduce((s, o) => s + (o.price >= price ? o.remaining : 0), 0);
      const sell = this.asks.reduce((s, o) => s + (o.price <= price ? o.remaining : 0), 0);
      const c = { price, volume: Math.min(buy, sell), imbalance: Math.abs(buy - sell), distance: Math.abs(price - this.prevClose) };
      if (
        !best ||
        c.volume > best.volume ||
        (c.volume === best.volume && (c.imbalance < best.imbalance || (c.imbalance === best.imbalance && c.distance < best.distance)))
      ) {
        best = c;
      }
    }
    return best && best.volume > 0 ? best.price : null;
  }

  private trade(buy: BookOrder, sell: BookOrder, qty: number, price: number) {
    const matchId = stableUuid(buy.orderId, sell.orderId);
    for (const o of [buy, sell]) {
      const tradeId = stableUuid(matchId, o.side);
      this.out.push({
        kind: "EXEC",
        id: stableUuid("fill", tradeId),
        payload: {
          kind: "FILL",
          tradeId,
          matchId,
          orderId: o.orderId,
          userId: o.userId,
          symbol: this.symbol,
          side: o.side,
          quantity: qty,
          price: fromUnits(price),
          fee: fromUnits(feeUnits(price * qty)),
          tradingDay: this.day,
          executedAt: this.at,
        },
      });
      o.remaining -= qty;
    }
    this.last = price;
    this.bar = this.bar
      ? { open: this.bar.open, high: Math.max(this.bar.high, price), low: Math.min(this.bar.low, price) }
      : { open: price, high: price, low: price };
    this.out.push({ kind: "PRICE", price: fromUnits(price), phase: this.phase });
  }

  private endDay() {
    // Resting LIMIT orders carry over to the next day. `seen` keeps only them: a late copy of one is ignored,
    // a late copy of any other earlier-day order is expired on arrival (same END id, so a no-op downstream).
    this.seen = new Set([...this.bids, ...this.asks].map((o) => o.orderId));
    if (this.bar) {
      const { open, high, low } = this.bar;
      this.out.push({ kind: "BAR", tradingDay: this.day, open: fromUnits(open), high: fromUnits(high), low: fromUnits(low), close: fromUnits(this.closePrice) });
    }
    this.prevClose = this.closePrice;
    this.last = null;
    this.bar = null;
    this.day += 1;
    this.phase = "PRE_OPEN";
  }

  private cancel(orderId: string, userId: string) {
    for (const side of [this.bids, this.asks]) {
      const i = side.findIndex((o) => o.orderId === orderId && o.userId === userId);
      if (i >= 0) return this.end(side.splice(i, 1)[0]!, "CANCELLED", "USER");
    }
    // not in the book: already filled/ended, or it never reached us; settlement keeps the order's real state
  }

  // Removes a resting order only if it still has exactly `remaining` shares open (compare-and-swap for modify).
  private take(orderId: string, userId: string, remaining: number): BookOrder | null {
    for (const side of [this.bids, this.asks]) {
      const i = side.findIndex((o) => o.orderId === orderId && o.userId === userId);
      if (i >= 0) return side[i]!.remaining === remaining ? side.splice(i, 1)[0]! : null;
    }
    return null;
  }

  private rest(o: BookOrder) {
    const side = o.side === "BUY" ? this.bids : this.asks;
    const better = (x: BookOrder) => (o.side === "BUY" ? x.price > o.price : x.price < o.price) || (x.price === o.price && x.seq < o.seq);
    const i = side.findIndex((x) => !better(x));
    side.splice(i < 0 ? side.length : i, 0, o);
  }

  private end(o: BookOrder, status: "CANCELLED" | "EXPIRED" | "REJECTED", reason: string) {
    this.out.push({ kind: "EXEC", id: stableUuid("end", o.orderId), payload: { kind: "END", orderId: o.orderId, userId: o.userId, status, reason } });
  }
}
