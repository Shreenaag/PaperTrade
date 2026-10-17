import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../../app.js";
import { createDb } from "../../infra/db.js";
import { createRedis } from "../../infra/redis.js";
import { sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";

// Integration test against compose Postgres/Redis. Skipped when they're down.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()])
  .then(() => false)
  .catch(() => (redis.disconnect(), "postgres/redis not reachable: docker compose up -d"));

const tag = randomUUID().slice(0, 6).toUpperCase();
const [A, B, C] = ["A", "B", "C"].map((s) => `I${s}${tag}`) as [string, string, string];

before(async () => {
  if (skip) return;
  const yesterday = sessionAt().tradingDay - 1;
  await db.instrument.createMany({ data: [A, B, C].map((symbol) => ({ symbol, name: `${symbol} Ltd`, initialPrice: "100" })) });
  await db.dailyBar.createMany({
    data: [
      { symbol: A, tradingDay: yesterday, open: "100", high: "100", low: "100", close: "100" },
      { symbol: B, tradingDay: yesterday, open: "95", high: "95", low: "95", close: "95" },
    ],
  });
  await redis.hset(RedisKeys.prices, A, JSON.stringify({ symbol: A, price: "110" }));
});
after(async () => {
  if (!skip) {
    await db.dailyBar.deleteMany({ where: { symbol: { in: [A, B, C] } } });
    await db.instrument.deleteMany({ where: { symbol: { in: [A, B, C] } } });
    await redis.hdel(RedisKeys.prices, A, B, C);
  }
  redis.disconnect();
  await db.$disconnect();
});

test("instruments: live tick, close fallback, initial price fallback; public", { skip }, async () => {
  const app = buildApp({ logLevel: "silent", checks: {}, orders: { db, redis } });
  const res = await app.inject({ url: "/market/instruments" });
  assert.equal(res.statusCode, 200);
  const mine = (res.json().instruments as { symbol: string }[]).filter((i) => [A, B, C].includes(i.symbol));
  assert.deepEqual(mine, [
    { symbol: A, name: `${A} Ltd`, lastPrice: "110.0000", prevClose: "100.0000", changePct: "10.00" },
    { symbol: B, name: `${B} Ltd`, lastPrice: "95.0000", prevClose: "95.0000", changePct: "0.00" },
    { symbol: C, name: `${C} Ltd`, lastPrice: "100.0000", prevClose: "100.0000", changePct: "0.00" },
  ]);
  await app.close();
});

test("session reports whether the market engine (worker) is running", { skip }, async () => {
  const app = buildApp({ logLevel: "silent", checks: {}, orders: { db, redis } });
  const expected = (await redis.exists(RedisKeys.workerLock)) ? "running" : "stopped"; // never touch the real lock
  const res = await app.inject({ url: "/market/session" });
  assert.equal(res.json().engine, expected);
  await app.close();
});
