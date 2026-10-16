import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../../app.js";
import { createDb } from "../../infra/db.js";
import { createRedis } from "../../infra/redis.js";
import { makeEvent, type Payload } from "../../shared/events.js";
import { sessionAt } from "../../shared/marketClock.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { applyExecution } from "../settlement/settlement.js";
import { cancelOrder, OrderError, placeOrder } from "./orders.service.js";

// Integration test: real Postgres + Redis from docker compose, a throwaway instrument priced at 100.
// The matching engine is faked by hand-made execution events. Skipped when the containers aren't running.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()])
  .then(() => false)
  .catch(() => (redis.disconnect(), "postgres/redis not reachable: docker compose up -d"));

const symbol = `T${randomUUID().slice(0, 8).toUpperCase()}`;
const userIds: string[] = [];

before(async () => {
  if (!skip) await db.instrument.create({ data: { symbol, name: "Test Co", initialPrice: "100" } });
});
after(async () => {
  if (!skip) {
    await db.outboxEvent.deleteMany({ where: { key: { in: [symbol, ...userIds] } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.instrument.delete({ where: { symbol } });
  }
  redis.disconnect();
  await db.$disconnect();
});

async function newTrader(cash = "100000", shares = 0) {
  const user = await db.user.create({
    data: { email: `t-${randomUUID()}@example.test`, displayName: "Trader", account: { create: { cash } } },
  });
  userIds.push(user.id);
  if (shares) await db.holding.create({ data: { userId: user.id, symbol, quantity: shares, avgCost: "90" } });
  return { userId: user.id, isBot: false };
}

const fill = (orderId: string, userId: string, side: "BUY" | "SELL", quantity: number, price: string, fee: string) =>
  makeEvent("executions", {
    kind: "FILL",
    tradeId: randomUUID(),
    matchId: randomUUID(),
    orderId,
    userId,
    symbol,
    side,
    quantity,
    price,
    fee,
    tradingDay: sessionAt().tradingDay,
    executedAt: new Date().toISOString(),
  });

const account = (userId: string) => db.account.findUniqueOrThrow({ where: { userId } });
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof OrderError && e.code === code);

test("LIMIT buy reserves price x qty + fee and queues a PLACE command", { skip }, async () => {
  const t = await newTrader();
  const order = await placeOrder(db, redis, t, { symbol, side: "BUY", type: "LIMIT", quantity: 10, limitPrice: "100" });
  assert.equal(order.status, "OPEN");
  assert.equal(order.reservedCash.toString(), "1000.3");
  assert.equal((await account(t.userId)).reservedCash.toString(), "1000.3");

  const [cmd] = await db.outboxEvent.findMany({ where: { key: symbol, payload: { path: ["payload", "orderId"], equals: order.id } } });
  const payload = (cmd!.payload as { payload: Payload<"orderCommands"> }).payload;
  assert.equal(cmd!.topic, "orders.commands.v1");
  assert.deepEqual([payload.kind, payload.limitPrice], ["PLACE", "100.0000"]);
});

test("orders the account can't cover, or outside the rules, are rejected without reserving", { skip }, async () => {
  const t = await newTrader("500");
  await rejects(placeOrder(db, redis, t, { symbol, side: "BUY", type: "LIMIT", quantity: 10, limitPrice: "100" }), "INSUFFICIENT_CASH");
  await rejects(placeOrder(db, redis, t, { symbol, side: "SELL", type: "MARKET", quantity: 1 }), "INSUFFICIENT_SHARES");
  await rejects(placeOrder(db, redis, t, { symbol, side: "BUY", type: "LIMIT", quantity: 1, limitPrice: "111" }), "PRICE_OUT_OF_BAND");
  await rejects(placeOrder(db, redis, t, { symbol, side: "BUY", type: "LIMIT", quantity: 1, limitPrice: "100.03" }), "BAD_TICK_SIZE");
  await rejects(placeOrder(db, redis, t, { symbol, side: "BUY", type: "MARKET", quantity: 10_001 }), "QUANTITY_TOO_LARGE");
  await rejects(placeOrder(db, redis, t, { symbol: "NOPE", side: "BUY", type: "MARKET", quantity: 1 }), "UNKNOWN_SYMBOL");
  assert.equal((await account(t.userId)).reservedCash.toString(), "0");
});

test("same clientOrderId twice = one order", { skip }, async () => {
  const t = await newTrader();
  const input = { symbol, side: "BUY" as const, type: "MARKET" as const, quantity: 1, clientOrderId: "abc" };
  const [a, b] = await Promise.all([placeOrder(db, redis, t, input), placeOrder(db, redis, t, input)]);
  assert.equal(a.id, b.id);
  assert.equal(await db.order.count({ where: { userId: t.userId } }), 1);
});

test("partial fill, duplicate delivery, then cancel releases exactly the rest", { skip }, async () => {
  const t = await newTrader();
  const order = await placeOrder(db, redis, t, { symbol, side: "BUY", type: "LIMIT", quantity: 10, limitPrice: "100" });

  const ev = fill(order.id, t.userId, "BUY", 4, "99", "0.1188");
  assert.equal(await applyExecution(db, ev), true);
  assert.equal(await applyExecution(db, ev), false, "redelivery is a no-op");

  let acct = await account(t.userId);
  assert.equal(acct.cash.toString(), "99603.8812"); // 100000 - 396 - 0.1188
  assert.equal(acct.reservedCash.toString(), "600.18"); // 1000.3 - 4/10 of it
  const h = await db.holding.findUniqueOrThrow({ where: { userId_symbol: { userId: t.userId, symbol } } });
  assert.deepEqual([h.quantity, h.avgCost.toString()], [4, "99.0297"]);
  const mid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.deepEqual([mid.status, mid.filledQuantity, mid.avgFillPrice?.toString()], ["PARTIALLY_FILLED", 4, "99"]);
  const ledger = await db.ledgerEntry.findMany({ where: { userId: t.userId }, orderBy: { amount: "asc" } });
  assert.deepEqual(ledger.map((l) => [l.type, l.amount.toString()]), [["TRADE_BUY", "-396"], ["FEE", "-0.1188"]]);

  await cancelOrder(db, t.userId, order.id);
  await applyExecution(db, makeEvent("executions", { kind: "END", orderId: order.id, userId: t.userId, status: "CANCELLED", reason: "USER" }));
  acct = await account(t.userId);
  assert.equal(acct.reservedCash.toString(), "0");
  const done = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.deepEqual([done.status, done.reservedCash.toString()], ["CANCELLED", "0"]);
  await rejects(cancelOrder(db, t.userId, order.id), "ORDER_CLOSED");
});

test("sell fill credits proceeds minus fee and books realized P&L", { skip }, async () => {
  const t = await newTrader("0", 10);
  const order = await placeOrder(db, redis, t, { symbol, side: "SELL", type: "LIMIT", quantity: 5, limitPrice: "100" });
  assert.equal((await db.holding.findUniqueOrThrow({ where: { userId_symbol: { userId: t.userId, symbol } } })).reservedQuantity, 5);

  await applyExecution(db, fill(order.id, t.userId, "SELL", 5, "101", "0.1515"));
  assert.equal((await account(t.userId)).cash.toString(), "504.8485");
  const h = await db.holding.findUniqueOrThrow({ where: { userId_symbol: { userId: t.userId, symbol } } });
  assert.deepEqual([h.quantity, h.reservedQuantity, h.realizedPnl.toString()], [5, 0, "54.8485"]); // 504.8485 - 5 x 90
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "FILLED");
});

test("HTTP: orders need a verified session; bad bodies are rejected", { skip }, async () => {
  const t = await newTrader();
  const app = buildApp({ logLevel: "silent", checks: {}, orders: { db, redis } });
  const sid = await createSession(redis, { userId: t.userId, role: "USER", otpVerified: true });
  const post = (body: object, cookies: Record<string, string> = { [SESSION_COOKIE]: sid }) =>
    app.inject({ method: "POST", url: "/orders", cookies, payload: body });

  assert.equal((await post({ symbol, side: "BUY", type: "MARKET", quantity: 1 }, {})).statusCode, 401);
  assert.equal((await post({ symbol, side: "BUY", type: "MARKET", quantity: 0 })).statusCode, 400);
  const res = await post({ symbol, side: "BUY", type: "MARKET", quantity: 1 });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().protectionPrice, undefined, "protection price lives in the command, not the order row");

  const list = await app.inject({ method: "GET", url: "/orders?open=true", cookies: { [SESSION_COOKIE]: sid } });
  assert.equal(list.json().orders.length, 1);
  await app.close();
});

test("execution for an order that no longer exists is skipped, not retried forever", { skip }, async () => {
  const ev = makeEvent("executions", { kind: "END", orderId: randomUUID(), userId: randomUUID(), status: "EXPIRED", reason: "DAY_END" });
  assert.equal(await applyExecution(db, ev), false);
});
