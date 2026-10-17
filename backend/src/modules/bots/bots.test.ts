import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Prisma } from "../../generated/prisma/client.js";
import { createDb } from "../../infra/db.js";
import { BOT_CASH, newPlayerOrders, topUp } from "./bots.js";

// Integration test: real Postgres from docker compose, a throwaway instrument and bot. Skipped when it isn't running.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const skip = await db.$queryRaw`SELECT 1`.then(() => false).catch(() => "postgres not reachable: docker compose up -d");

const symbol = `B${randomUUID().slice(0, 8).toUpperCase()}`;
const userIds: string[] = [];

before(async () => {
  if (!skip) await db.instrument.create({ data: { symbol, name: "Bot Test Co", initialPrice: "100" } });
});
after(async () => {
  if (!skip) {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.instrument.delete({ where: { symbol } });
  }
  await db.$disconnect();
});

test("top-up restores cash and shares, logs the cash as RESET, and is a no-op when full", { skip }, async () => {
  const user = await db.user.create({
    data: { email: `bot-${randomUUID()}@example.test`, displayName: "Bot", isBot: true, account: { create: { cash: "1500000" } } },
  });
  userIds.push(user.id);
  await db.holding.create({ data: { userId: user.id, symbol, quantity: 4000, avgCost: "100" } });
  const bot = { userId: user.id, symbol, shares: 10_000, initialPrice: new Prisma.Decimal(100) };

  await topUp(db, bot);
  await topUp(db, bot);

  const account = await db.account.findUniqueOrThrow({ where: { userId: user.id } });
  const holding = await db.holding.findUniqueOrThrow({ where: { userId_symbol: { userId: user.id, symbol } } });
  const ledger = await db.ledgerEntry.findMany({ where: { userId: user.id } });
  assert.equal(account.cash.toString(), BOT_CASH);
  assert.equal(holding.quantity, 10_000);
  assert.deepEqual(ledger.map((l) => [l.type, l.amount.toString(), l.balanceAfter.toString()]), [["RESET", "500000", BOT_CASH]]);
});

test("top-up creates the holding if the bot has none", { skip }, async () => {
  const user = await db.user.create({
    data: { email: `bot-${randomUUID()}@example.test`, displayName: "Bot", isBot: true, account: { create: { cash: BOT_CASH } } },
  });
  userIds.push(user.id);
  await topUp(db, { userId: user.id, symbol, shares: 500, initialPrice: new Prisma.Decimal(100) });
  const holding = await db.holding.findUniqueOrThrow({ where: { userId_symbol: { userId: user.id, symbol } } });
  assert.deepEqual([holding.quantity, holding.avgCost.toString()], [500, "100"]);
});

test("newPlayerOrders returns players' orders placed after the cursor, never bots'", { skip }, async () => {
  const mk = async (isBot: boolean) => {
    const u = await db.user.create({ data: { email: `p-${randomUUID()}@example.test`, displayName: "P", isBot, account: { create: { cash: "1000" } } } });
    userIds.push(u.id);
    return u.id;
  };
  const [player, bot] = [await mk(false), await mk(true)];
  const order = (userId: string, createdAt: Date) =>
    db.order.create({ data: { userId, symbol, side: "BUY", type: "LIMIT", quantity: 2, limitPrice: "101", status: "OPEN", tradingDay: 1, createdAt } });
  const since = new Date(Date.now() - 60_000);
  await order(player, new Date(since.getTime() - 1000)); // before the cursor
  const fresh = await order(player, new Date());
  await order(bot, new Date());

  const found = (await newPlayerOrders(db, since)).filter((o) => o.symbol === symbol);
  assert.deepEqual(found.map((o) => [o.side, o.quantity, o.limitPrice?.toString(), o.createdAt.getTime()]), [["BUY", 2, "101", fresh.createdAt.getTime()]]);
});
