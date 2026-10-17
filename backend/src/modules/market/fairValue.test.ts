import assert from "node:assert/strict";
import { test } from "node:test";
import { PHASE_SECONDS } from "../../shared/marketClock.js";
import { stepFairValue, toTickString } from "./fairValue.js";

test("one simulated day of steps has roughly the instrument's daily volatility", () => {
  const sigma = 0.25;
  const days = 2000;
  const returns: number[] = [];
  for (let d = 0; d < days; d++) {
    let p = 1000;
    for (let s = 0; s < PHASE_SECONDS.OPEN; s += 10) p = stepFairValue(p, sigma, 10);
    returns.push(Math.log(p / 1000));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / days;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / days);
  const expected = sigma / Math.sqrt(252);
  assert.ok(Math.abs(sd - expected) < expected * 0.15, `daily sd ${sd} vs ${expected}`);
});

test("prices round to the tick and never reach zero", () => {
  assert.equal(toTickString(2900.123, 0.05), "2900.1000");
  assert.equal(toTickString(2900.13, 0.05), "2900.1500");
  assert.equal(toTickString(0.001, 0.05), "0.0500");
});

// Integration: nudge (a player's order) moves the saved fair value at once. Needs compose; skipped when it's down.
test("nudge moves the saved fair value immediately", async (t) => {
  const { randomUUID } = await import("node:crypto");
  const { createDb } = await import("../../infra/db.js");
  const { createRedis } = await import("../../infra/redis.js");
  const { RedisKeys } = await import("../../shared/redisKeys.js");
  const { startFairValue } = await import("./fairValue.js");
  const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
  const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
  const up = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()]).then(() => true, () => false);
  if (!up) {
    redis.disconnect();
    return t.skip("postgres/redis not reachable: docker compose up -d");
  }
  const symbol = `F${randomUUID().slice(0, 8).toUpperCase()}`;
  await db.instrument.create({ data: { symbol, name: "Test Co", initialPrice: "200" } });
  const fair = await startFairValue(db, redis, 3600); // no random steps during the test
  try {
    assert.equal(await redis.hget(RedisKeys.fairValue, symbol), "200.0000");
    await fair.nudge(symbol, 0.05);
    assert.equal(await redis.hget(RedisKeys.fairValue, symbol), "210.0000");
    await fair.nudge("NOPE", 0.05); // unknown symbol: ignored
  } finally {
    fair.stop();
    await redis.hdel(RedisKeys.fairValue, symbol);
    await db.instrument.delete({ where: { symbol } });
    redis.disconnect();
    await db.$disconnect();
  }
});
