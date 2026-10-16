import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, sizeFor, type BotView } from "./strategies.js";

const view = (over: Partial<BotView>): BotView => ({
  kind: "MARKET_MAKER",
  symbol: "ITC",
  phase: "OPEN",
  fair: 450,
  last: 450,
  ref: null,
  tick: 0.05,
  lot: 1,
  open: [],
  ...over,
});
const seq = (...xs: number[]) => () => xs.shift() ?? 0;

test("market maker quotes both sides around fair value", () => {
  const plan = decide(view({}));
  assert.deepEqual(plan.cancel, []);
  assert.deepEqual(
    plan.place.map((o) => [o.side, o.type, o.limitPrice, o.quantity]),
    [["BUY", "LIMIT", "449.5500", 222], ["SELL", "LIMIT", "450.4500", 222]],
  );
});

test("market maker keeps a quote still on target and replaces a stale one", () => {
  const plan = decide(view({ open: [{ id: "b", side: "BUY", limitPrice: "449.5500" }, { id: "s", side: "SELL", limitPrice: "451.0000" }] }));
  assert.deepEqual(plan.cancel, ["s"]);
  assert.deepEqual(plan.place.map((o) => o.side), ["SELL"]);
});

test("market maker quotes in PRE_OPEN, leaves its quotes alone in POST_CLOSE", () => {
  assert.equal(decide(view({ phase: "PRE_OPEN" })).place.length, 2);
  assert.deepEqual(decide(view({ phase: "POST_CLOSE", open: [{ id: "b", side: "BUY", limitPrice: "1.0000" }] })), { cancel: [], place: [] });
});

test("noise and momentum only trade while OPEN", () => {
  for (const phase of ["PRE_OPEN", "POST_CLOSE"] as const) {
    assert.equal(decide(view({ kind: "NOISE", phase })).place.length, 0);
    assert.equal(decide(view({ kind: "MOMENTUM", phase, ref: 400 })).place.length, 0);
  }
});

test("noise places a random MARKET or LIMIT near fair value and caps resting orders", () => {
  assert.deepEqual(decide(view({ kind: "NOISE" }), seq(0.1, 0.1)).place, [{ symbol: "ITC", side: "BUY", type: "MARKET", quantity: 56 }]);
  const limit = decide(view({ kind: "NOISE" }), seq(0.9, 0.9, 1)).place[0]!;
  assert.deepEqual([limit.side, limit.type, limit.limitPrice], ["SELL", "LIMIT", "452.2500"]);

  const open = ["a", "b", "c", "d"].map((id) => ({ id, side: "BUY" as const, limitPrice: "449.0000" }));
  assert.deepEqual(decide(view({ kind: "NOISE", open }), seq(0.1, 0.1)).cancel, ["a", "b"]);
});

test("momentum follows a move past the trigger, ignores small ones", () => {
  assert.equal(decide(view({ kind: "MOMENTUM", ref: null })).place.length, 0);
  assert.equal(decide(view({ kind: "MOMENTUM", ref: 449.5 })).place.length, 0);
  assert.equal(decide(view({ kind: "MOMENTUM", last: 452, ref: 450 })).place[0]!.side, "BUY");
  assert.deepEqual(decide(view({ kind: "MOMENTUM", last: 448, ref: 450 })).place[0], { symbol: "ITC", side: "SELL", type: "MARKET", quantity: 112 });
});

test("order size is whole lots, at least one", () => {
  assert.equal(sizeFor(25_000, 450, 1), 56);
  assert.equal(sizeFor(25_000, 450, 10), 60);
  assert.equal(sizeFor(25_000, 100_000, 1), 1);
});
