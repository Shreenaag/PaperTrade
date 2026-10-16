import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../../app.js";
import { Prisma } from "../../generated/prisma/client.js";
import { createDb } from "../../infra/db.js";
import { createRedis } from "../../infra/redis.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { lastPrices, listOrders, listTrades } from "./orders.service.js";

// Integration test for order/trade history paging and the shared last-price rule. Skipped when compose is down.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()])
  .then(() => false)
  .catch(() => (redis.disconnect(), "postgres/redis not reachable: docker compose up -d"));

const tag = randomUUID().slice(0, 6).toUpperCase();
const [A, B, C] = ["A", "B", "C"].map((s) => `H${s}${tag}`) as [string, string, string];
const userIds: string[] = [];

before(async () => {
  if (skip) return;
  await db.instrument.createMany({ data: [A, B, C].map((symbol) => ({ symbol, name: "Test Co", initialPrice: "100" })) });
});
after(async () => {
  if (!skip) {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.dailyBar.deleteMany({ where: { symbol: { in: [A, B, C] } } });
    await db.instrument.deleteMany({ where: { symbol: { in: [A, B, C] } } });
    await redis.hdel(RedisKeys.prices, A, B, C);
  }
  redis.disconnect();
  await db.$disconnect();
});

async function newUser() {
  const user = await db.user.create({ data: { email: `h-${randomUUID()}@example.test`, displayName: "H", account: { create: { cash: "1000" } } } });
  userIds.push(user.id);
  return user.id;
}

// Three orders a second apart, each with one trade; returns them oldest first.
async function seedHistory(userId: string) {
  const rows = [];
  for (const [i, symbol] of [A, B, A].entries()) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
    const order = await db.order.create({
      data: { userId, symbol, side: "BUY", type: "MARKET", quantity: 1, status: "FILLED", tradingDay: 1, createdAt: at },
    });
    const trade = await db.trade.create({
      data: { id: randomUUID(), matchId: randomUUID(), orderId: order.id, userId, symbol, side: "BUY", quantity: 1, price: "100", tradingDay: 1, executedAt: at },
    });
    rows.push({ order, trade });
  }
  return rows;
}

test("orders page by cursor", { skip }, async () => {
  const u = await newUser();
  const [o1, o2, o3] = (await seedHistory(u)).map((r) => r.order);
  const page1 = await listOrders(db, u, false, { limit: 2 });
  assert.deepEqual(page1.map((o) => o.id), [o3!.id, o2!.id]);
  const page2 = await listOrders(db, u, false, { before: page1[1]!.id, limit: 2 });
  assert.deepEqual(page2.map((o) => o.id), [o1!.id]);
});

test("foreign cursor returns empty page", { skip }, async () => {
  const [a, b] = [await newUser(), await newUser()];
  const [{ order, trade }] = await seedHistory(a);
  await seedHistory(b);
  assert.deepEqual(await listOrders(db, b, false, { before: order.id }), []);
  assert.deepEqual(await listTrades(db, b, { before: trade.id }), []);
});

test("trades page by cursor and filter by symbol", { skip }, async () => {
  const u = await newUser();
  const [t1, t2, t3] = (await seedHistory(u)).map((r) => r.trade);
  const page1 = await listTrades(db, u, { limit: 2 });
  assert.deepEqual(page1.map((t) => t.id), [t3!.id, t2!.id]);
  assert.deepEqual((await listTrades(db, u, { before: page1[1]!.id })).map((t) => t.id), [t1!.id]);
  assert.deepEqual((await listTrades(db, u, { symbol: B })).map((t) => t.id), [t2!.id]);
});

test("lastPrices falls back to DailyBar close then initialPrice", { skip }, async () => {
  await redis.hset(RedisKeys.prices, A, JSON.stringify({ symbol: A, price: "101.5" }));
  await db.dailyBar.createMany({
    data: [
      { symbol: B, tradingDay: 1, open: "90", high: "99", low: "89", close: "94" },
      { symbol: B, tradingDay: 2, open: "94", high: "96", low: "93", close: "95" },
    ],
  });
  const initialPrice = new Prisma.Decimal("100");
  const prices = await lastPrices(db, redis, [A, B, C].map((symbol) => ({ symbol, initialPrice })));
  assert.deepEqual(
    [A, B, C].map((s) => prices.get(s)?.toString()),
    ["101.5", "95", "100"],
  );
});

test("HTTP: GET /trades needs a session; limit is validated", { skip }, async () => {
  const u = await newUser();
  await seedHistory(u);
  const app = buildApp({ logLevel: "silent", checks: {}, orders: { db, redis } });
  const sid = await createSession(redis, { userId: u, role: "USER", otpVerified: true });
  const get = (url: string, cookies: Record<string, string> = { [SESSION_COOKIE]: sid }) => app.inject({ method: "GET", url, cookies });

  assert.equal((await get("/trades", {})).statusCode, 401);
  assert.equal((await get("/trades?limit=0")).statusCode, 400);
  assert.equal((await get("/trades?limit=101")).statusCode, 400);
  assert.equal((await get("/trades?before=nope")).statusCode, 400);
  const res = await get("/trades?limit=2");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().trades.length, 2);
  assert.equal((await get("/orders?limit=101")).statusCode, 400);
  await app.close();
});
