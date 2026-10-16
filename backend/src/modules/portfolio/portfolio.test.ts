import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../../app.js";
import { Prisma } from "../../generated/prisma/client.js";
import { createDb } from "../../infra/db.js";
import { makeEvent } from "../../shared/events.js";
import { applyExecution } from "../settlement/settlement.js";
import { createRedis } from "../../infra/redis.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { getPortfolio } from "./portfolio.service.js";

// Integration test against compose Postgres/Redis. Skipped when they're down.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()])
  .then(() => false)
  .catch(() => (redis.disconnect(), "postgres/redis not reachable: docker compose up -d"));

const tag = randomUUID().slice(0, 6).toUpperCase();
const [A, B, C, D] = ["A", "B", "C", "D"].map((s) => `P${s}${tag}`) as [string, string, string, string];
const symbols = [A, B, C, D];
const userIds: string[] = [];

before(async () => {
  if (skip) return;
  await db.instrument.createMany({ data: symbols.map((symbol) => ({ symbol, name: "Test Co", initialPrice: "100" })) });
  await redis.hset(RedisKeys.prices, A, JSON.stringify({ symbol: A, price: "110" }));
  await db.dailyBar.create({ data: { symbol: B, tradingDay: 1, open: "190", high: "190", low: "190", close: "190" } });
});
after(async () => {
  if (!skip) {
    await db.outboxEvent.deleteMany({ where: { key: { in: userIds } } }); // settlement's order updates
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.dailyBar.deleteMany({ where: { symbol: { in: symbols } } });
    await db.instrument.deleteMany({ where: { symbol: { in: symbols } } });
    await redis.hdel(RedisKeys.prices, ...symbols);
  }
  redis.disconnect();
  await db.$disconnect();
});

async function newUser(cash: string | null = "990000", reservedCash = "0") {
  const user = await db.user.create({
    data: {
      email: `p-${randomUUID()}@example.test`,
      displayName: "P",
      ...(cash && {
        account: { create: { cash, reservedCash } },
        ledger: { create: { type: "INITIAL_GRANT", amount: "1000000", balanceAfter: "1000000" } },
      }),
    },
  });
  userIds.push(user.id);
  return user.id;
}

test("portfolio values positions at last price with fallbacks", { skip }, async () => {
  const u = await newUser("990000", "1000");
  await db.holding.createMany({
    data: [
      { userId: u, symbol: A, quantity: 10, avgCost: "100" },
      { userId: u, symbol: B, quantity: 5, avgCost: "200" },
      { userId: u, symbol: C, quantity: 0, avgCost: "100", realizedPnl: "25.5" },
    ],
  });
  const p = (await getPortfolio(db, redis, u))!;

  assert.deepEqual([p.cash, p.reservedCash, p.availableCash], ["990000.0000", "1000.0000", "989000.0000"]);
  assert.deepEqual(p.holdings.map((h) => h.symbol), [A, B], "closed position C is not listed");
  const [a, b] = p.holdings;
  assert.deepEqual([a!.lastPrice, a!.marketValue, a!.unrealizedPnl, a!.unrealizedPct], ["110.0000", "1100.0000", "100.0000", "10.00"]);
  assert.deepEqual([b!.lastPrice, b!.marketValue, b!.unrealizedPnl, b!.unrealizedPct], ["190.0000", "950.0000", "-50.0000", "-5.00"]);
  assert.deepEqual(p.totals, {
    holdingsValue: "2050.0000",
    equity: "992050.0000",
    realizedPnl: "25.5000",
    unrealizedPnl: "50.0000",
    totalPnl: "75.5000",
    returnPct: "-0.80",
  });
});

test("total P&L equals equity minus the grant after real fills through settlement", { skip }, async () => {
  const u = await newUser("1000000", "1546.0545");
  const fill = async (side: "BUY" | "SELL", quantity: number, price: string, fee: string, reservedCash = "0") => {
    const order = await db.order.create({ data: { userId: u, symbol: D, side, type: "LIMIT", quantity, limitPrice: price, reservedCash, status: "OPEN", tradingDay: 1 } });
    const ev = makeEvent("executions", {
      kind: "FILL", tradeId: randomUUID(), matchId: randomUUID(), orderId: order.id, userId: u, symbol: D, side, quantity, price, fee,
      tradingDay: 1, executedAt: new Date().toISOString(),
    });
    assert.equal(await applyExecution(db, ev), true);
  };
  await fill("BUY", 10, "100", "0.3", "1000.3");
  await fill("BUY", 5, "103", "0.1545", "515.1545");
  await db.holding.update({ where: { userId_symbol: { userId: u, symbol: D } }, data: { reservedQuantity: 7 } });
  await fill("SELL", 7, "105", "0.2205");
  await redis.hset(RedisKeys.prices, D, JSON.stringify({ symbol: D, price: "104" }));

  const { totals } = (await getPortfolio(db, redis, u))!;
  const drift = new Prisma.Decimal(totals.equity).sub("1000000").sub(totals.totalPnl).abs();
  assert.ok(drift.lte("0.0003"), `equity - grant and totalPnl differ by ${drift} (more than 4-dp rounding of 3 fills)`);
  await redis.hdel(RedisKeys.prices, D);
});

test("empty portfolio: no holdings, equity is cash", { skip }, async () => {
  const p = (await getPortfolio(db, redis, await newUser("1000000")))!;
  assert.deepEqual(p.holdings, []);
  assert.deepEqual([p.totals.equity, p.totals.totalPnl, p.totals.returnPct], ["1000000.0000", "0.0000", "0.00"]);
});

test("zero avgCost doesn't divide by zero", { skip }, async () => {
  const u = await newUser();
  await db.holding.create({ data: { userId: u, symbol: D, quantity: 3, avgCost: "0" } });
  const [d] = (await getPortfolio(db, redis, u))!.holdings;
  assert.deepEqual([d!.unrealizedPnl, d!.unrealizedPct], ["300.0000", "0.00"]);
});

test("HTTP: 401 without session, 404 NO_ACCOUNT, 200 with body", { skip }, async () => {
  const app = buildApp({ logLevel: "silent", checks: {}, orders: { db, redis } });
  const get = (sid?: string) => app.inject({ method: "GET", url: "/portfolio", cookies: sid ? { [SESSION_COOKIE]: sid } : {} });
  const session = async (userId: string) => createSession(redis, { userId, role: "USER", otpVerified: true });

  assert.equal((await get()).statusCode, 401);
  const noAccount = await get(await session(await newUser(null)));
  assert.deepEqual([noAccount.statusCode, noAccount.json()], [404, { error: "NO_ACCOUNT" }]);
  const ok = await get(await session(await newUser()));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().totals.equity, "990000.0000");
  await app.close();
});
