import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_SECONDS, dayStartsAt, sessionAt } from "./marketClock.js";

const day0 = dayStartsAt(0).getTime();
const at = (s: number) => sessionAt(new Date(day0 + s * 1000));

test("a trading day is 6 min 20 s: 30 s pre, 5 min open, 30 s closing, 20 s closed", () => {
  assert.equal(DAY_SECONDS, 380);
  assert.equal(at(0).phase, "PRE_OPEN");
  assert.equal(at(29.999).phase, "PRE_OPEN");
  assert.equal(at(30).phase, "OPEN");
  assert.equal(at(329.999).phase, "OPEN");
  assert.equal(at(330).phase, "POST_CLOSE");
  assert.equal(at(359.999).phase, "POST_CLOSE");
  assert.equal(at(360).phase, "CLOSED");
  assert.equal(at(379.999).phase, "CLOSED");
  assert.equal(at(380).phase, "PRE_OPEN");
});

test("days repeat back-to-back with phase boundaries", () => {
  const s = at(380 * 7 + 200);
  assert.equal(s.tradingDay, 7);
  assert.equal(s.phase, "OPEN");
  assert.equal(s.phaseStartsAt.getTime(), day0 + (380 * 7 + 30) * 1000);
  assert.equal(s.phaseEndsAt.getTime(), day0 + (380 * 7 + 330) * 1000);
  assert.deepEqual([at(379.999).tradingDay, at(380).tradingDay], [0, 1]);
});
