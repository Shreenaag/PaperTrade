import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEvent, parseEvent } from "./events.js";

const tick = { symbol: "TCS", price: "3812.4500", ts: new Date().toISOString() };

test("event round-trips through JSON", () => {
  const ev = makeEvent("prices", tick);
  assert.equal(ev.topic, "market.prices.v1");
  assert.deepEqual(parseEvent("prices", JSON.stringify(ev)), ev);
});

test("money as a float is rejected", () => {
  assert.throws(() => makeEvent("prices", { ...tick, price: 3812.45 as unknown as string }));
});

test("event for the wrong topic is rejected", () => {
  const ev = makeEvent("prices", tick);
  assert.throws(() => parseEvent("tradesExecuted", JSON.stringify(ev)));
});
