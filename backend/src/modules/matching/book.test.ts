import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Payload } from "../../shared/events.js";
import type { MarketPhase } from "../../shared/marketClock.js";
import { Book, fromUnits, toUnits, type BookEvent } from "./book.js";

type Command = Payload<"orderCommands">;
const DAY = 100;
const AT = "2026-10-15T10:00:00.000Z";
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const limit = (userId: string, side: "BUY" | "SELL", quantity: number, price: string, tradingDay = DAY): Command => ({
  kind: "PLACE", orderId: id(), userId, symbol: "TCS", side, type: "LIMIT", quantity, limitPrice: price, protectionPrice: null, tradingDay,
});
const market = (userId: string, side: "BUY" | "SELL", quantity: number, protection: string): Command => ({
  kind: "PLACE", orderId: id(), userId, symbol: "TCS", side, type: "MARKET", quantity, limitPrice: null, protectionPrice: protection, tradingDay: DAY,
});
const clock = (phase: MarketPhase, tradingDay = DAY): Command => ({ kind: "CLOCK", symbol: "TCS", tradingDay, phase });

const fills = (ev: BookEvent[]) =>
  ev.flatMap((e) => (e.kind === "EXEC" && e.payload.kind === "FILL" ? [[e.payload.side, e.payload.quantity, e.payload.price]] : []));
const ends = (ev: BookEvent[]) =>
  ev.flatMap((e) => (e.kind === "EXEC" && e.payload.kind === "END" ? [[e.payload.status, e.payload.reason]] : []));

function openBook() {
  const book = new Book("TCS", "100", DAY);
  book.handle(clock("OPEN"), AT);
  return book;
}

test("price units are exact", () => {
  assert.equal(toUnits("3800.05"), 38_000_500);
  assert.equal(fromUnits(38_000_500), "3800.0500");
  assert.equal(fromUnits(toUnits("0.0003")), "0.0003");
});

test("continuous: trades at the resting price, best price first, then oldest", () => {
  const book = openBook();
  book.handle(limit(A, "SELL", 5, "101"), AT);
  book.handle(limit(B, "SELL", 5, "100"), AT);
  book.handle(limit(C, "SELL", 5, "100"), AT);
  const ev = book.handle(limit(A, "BUY", 8, "102"), AT);
  // B's 100 first (older at the best price), then 3 of C's 100; A's own 101 is never reached
  assert.deepEqual(fills(ev), [["BUY", 5, "100.0000"], ["SELL", 5, "100.0000"], ["BUY", 3, "100.0000"], ["SELL", 3, "100.0000"]]);
  assert.equal(book.openOrders, 2); // C's last 2 + A's ask
});

test("partial fill rests the remainder; fee is 0.03% per side", () => {
  const book = openBook();
  book.handle(limit(A, "SELL", 4, "99"), AT);
  const ev = book.handle(limit(B, "BUY", 10, "100"), AT);
  const fill = ev.find((e) => e.kind === "EXEC" && e.payload.kind === "FILL");
  assert.equal(fill?.kind === "EXEC" && fill.payload.kind === "FILL" && fill.payload.fee, "0.1188"); // 396 x 0.0003
  assert.deepEqual(ends(ev), []);
  assert.equal(book.openOrders, 1);
});

test("MARKET fills up to its protection price, the rest is cancelled", () => {
  const book = openBook();
  book.handle(limit(A, "SELL", 5, "100"), AT);
  book.handle(limit(A, "SELL", 5, "106"), AT);
  const ev = book.handle(market(B, "BUY", 8, "105"), AT);
  assert.deepEqual(fills(ev), [["BUY", 5, "100.0000"], ["SELL", 5, "100.0000"]]);
  assert.deepEqual(ends(ev), [["CANCELLED", "NO_LIQUIDITY"]]);
});

test("self-trade cancels the newer order", () => {
  const book = openBook();
  book.handle(limit(A, "SELL", 5, "100"), AT);
  const ev = book.handle(limit(A, "BUY", 5, "100"), AT);
  assert.deepEqual(fills(ev), []);
  assert.deepEqual(ends(ev), [["CANCELLED", "SELF_TRADE"]]);
  assert.equal(book.openOrders, 1);
});

test("PRE_OPEN queues; the opening auction trades the most volume at one price", () => {
  const book = new Book("TCS", "100", DAY);
  assert.deepEqual(book.handle(limit(A, "BUY", 10, "103"), AT), []);
  book.handle(limit(B, "BUY", 5, "101"), AT);
  book.handle(limit(C, "SELL", 8, "100"), AT);
  book.handle(limit(C, "SELL", 10, "102"), AT);
  book.handle(market(B, "SELL", 2, "95"), AT);
  const ev = book.handle(clock("OPEN"), AT);
  // 100 and 101 both trade 10 with imbalance 5 (102/103: imbalance 10); 100 is closest to the previous close
  assert.ok(fills(ev).every(([, , price]) => price === "100.0000"));
  assert.equal(fills(ev).reduce((s, [side, q]) => s + (side === "BUY" ? (q as number) : 0), 0), 10);
  assert.equal(book.phase, "OPEN");
});

test("POST_CLOSE fills only at the closing price; resting orders carry over to the next day; the bar is emitted", () => {
  const book = openBook();
  book.handle(limit(A, "SELL", 5, "100"), AT);
  book.handle(limit(B, "BUY", 5, "100"), AT); // last trade 100 = close
  book.handle(clock("POST_CLOSE"), AT);
  book.handle(limit(A, "SELL", 5, "99"), AT);
  const ev = book.handle(limit(B, "BUY", 3, "105"), AT);
  assert.deepEqual(fills(ev), [["BUY", 3, "100.0000"], ["SELL", 3, "100.0000"]]); // at close, not 99
  assert.deepEqual(fills(book.handle(limit(C, "BUY", 1, "98"), AT)), []); // below close: rests

  book.handle(clock("CLOSED"), AT);
  assert.deepEqual(fills(book.handle(limit(B, "BUY", 1, "105"), AT)), [["BUY", 1, "100.0000"], ["SELL", 1, "100.0000"]], "an order in flight at CLOSED still fills at the close");
  const next = book.handle(clock("PRE_OPEN", DAY + 1), AT);
  assert.deepEqual(ends(next), [], "A's 1 left at 99 and C's bid at 98 stay in the book");
  assert.deepEqual(next.find((e) => e.kind === "BAR"), { kind: "BAR", tradingDay: DAY, open: "100.0000", high: "100.0000", low: "100.0000", close: "100.0000" });
  assert.equal(book.day, DAY + 1);
  assert.equal(book.openOrders, 2);

  book.handle(clock("OPEN", DAY + 1), AT);
  assert.deepEqual(fills(book.handle(limit(B, "BUY", 2, "99", DAY + 1), AT)), [["BUY", 1, "99.0000"], ["SELL", 1, "99.0000"]], "a carried order fills the next day");
});

test("a late duplicate of a carried resting order is ignored, not expired", () => {
  const book = openBook();
  const resting = limit(A, "BUY", 5, "99");
  book.handle(resting, AT);
  book.handle(clock("PRE_OPEN", DAY + 1), AT);
  assert.deepEqual(book.handle(resting, AT), []);
  assert.equal(book.openOrders, 1);
});

test("cancel removes a resting order; an order from a finished day is expired on arrival", () => {
  const book = openBook();
  const order = limit(A, "BUY", 5, "99");
  book.handle(order, AT);
  assert.deepEqual(ends(book.handle({ kind: "CANCEL", orderId: order.kind === "PLACE" ? order.orderId : "", userId: B, symbol: "TCS" }, AT)), []); // not B's
  assert.deepEqual(ends(book.handle({ kind: "CANCEL", orderId: order.kind === "PLACE" ? order.orderId : "", userId: A, symbol: "TCS" }, AT)), [["CANCELLED", "USER"]]);
  assert.deepEqual(ends(book.handle(limit(A, "BUY", 1, "99", DAY - 1), AT)), [["EXPIRED", "DAY_END"]]);
});

test("a re-delivered PLACE is ignored: resting, filled or ended orders are never added twice", () => {
  const book = openBook();
  const resting = limit(A, "BUY", 5, "99");
  const ended = limit(A, "SELL", 5, "98"); // crosses A's own bid: self-trade
  const filled = limit(B, "SELL", 2, "99");
  for (const c of [resting, ended, filled]) book.handle(c, AT);
  assert.equal(book.openOrders, 1); // the rest of A's bid

  for (const c of [resting, ended, filled]) assert.deepEqual(book.handle(c, AT), []);
  assert.equal(book.openOrders, 1);
  assert.deepEqual(fills(book.handle(limit(C, "SELL", 5, "99"), AT)), [["BUY", 3, "99.0000"], ["SELL", 3, "99.0000"]]);
});

test("replay is deterministic: same commands -> identical events and ids", () => {
  const commands = [limit(A, "BUY", 10, "103"), limit(B, "SELL", 4, "100"), clock("OPEN"), limit(C, "SELL", 10, "102"), market(B, "BUY", 3, "105")];
  const run = () => {
    const book = new Book("TCS", "100", DAY);
    return commands.flatMap((c) => book.handle(c, AT));
  };
  assert.deepEqual(run(), run());
});

const place = (c: Command) => c as Extract<Command, { kind: "PLACE" }>;
const replacing = (old: Command, next: Command, remaining: number): Command => ({ ...place(next), replaces: { orderId: place(old).orderId, remaining } });

test("modify swaps an untouched resting order and sends it to the back of the queue", () => {
  const book = openBook();
  const old = limit(A, "BUY", 10, "99");
  book.handle(old, AT);
  const b = limit(B, "BUY", 5, "99");
  book.handle(b, AT);
  const next = limit(A, "BUY", 6, "99");
  assert.deepEqual(ends(book.handle(replacing(old, next, 10), AT)), [["CANCELLED", "MODIFIED"]]);
  assert.equal(book.openOrders, 2);
  const ev = book.handle(limit(C, "SELL", 5, "99"), AT);
  const buyer = ev.find((e) => e.kind === "EXEC" && e.payload.kind === "FILL" && e.payload.side === "BUY");
  assert.equal(buyer?.kind === "EXEC" && buyer.payload.orderId, place(b).orderId, "B was ahead of the modified order");
});

test("modify is rejected when the order filled in the meantime; the old order keeps resting", () => {
  const book = openBook();
  const old = limit(A, "BUY", 10, "99");
  book.handle(old, AT);
  book.handle(limit(C, "SELL", 4, "99"), AT); // 4 fill before the modify arrives
  assert.deepEqual(ends(book.handle(replacing(old, limit(A, "BUY", 10, "98"), 10), AT)), [["REJECTED", "ORDER_CHANGED"]]);
  assert.equal(book.openOrders, 1);
  assert.deepEqual(ends(book.handle(replacing(old, limit(A, "BUY", 10, "98"), 99), AT)), [["REJECTED", "ORDER_CHANGED"]]);
});
