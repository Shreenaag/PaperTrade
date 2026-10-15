import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_SECONDS, sessionAt } from "./marketClock.js";

const day0 = Date.UTC(2026, 0, 1);
const at = (s: number) => sessionAt(new Date(day0 + s * 1000));

test("a trading day is 10 minutes: 2.5 pre, 5 open, 2.5 post", () => {
  assert.equal(DAY_SECONDS, 600);
  assert.equal(at(0).phase, "PRE_OPEN");
  assert.equal(at(149.999).phase, "PRE_OPEN");
  assert.equal(at(150).phase, "OPEN");
  assert.equal(at(449.999).phase, "OPEN");
  assert.equal(at(450).phase, "POST_CLOSE");
  assert.equal(at(599.999).phase, "POST_CLOSE");
});

test("days repeat back-to-back with phase boundaries", () => {
  const s = at(600 * 7 + 200);
  assert.equal(s.tradingDay, 7);
  assert.equal(s.phase, "OPEN");
  assert.equal(s.phaseStartsAt.getTime(), day0 + (600 * 7 + 150) * 1000);
  assert.equal(s.phaseEndsAt.getTime(), day0 + (600 * 7 + 450) * 1000);
  assert.deepEqual([at(599.999).tradingDay, at(600).tradingDay], [0, 1]);
});
