import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createDb } from "../../infra/db.js";
import type { Producer } from "../../infra/kafka.js";
import { parseEvent } from "../../shared/events.js";
import { expireStaleOrders, untilSent } from "./matching.js";

test("untilSent retries the same send until it succeeds, without redoing the work before it", async () => {
  let calls = 0;
  await untilSent(async () => {
    if (++calls < 3) throw new Error("broker down");
  }, 1);
  assert.equal(calls, 3);
});

// Integration part: real Postgres, fake producer. Skipped when compose is down.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const skip = await db.$queryRaw`SELECT 1`.then(() => false).catch(() => "postgres not reachable: docker compose up -d");
const symbol = `M${randomUUID().slice(0, 8).toUpperCase()}`;
let userId = "";

before(async () => {
  if (skip) return;
  await db.instrument.create({ data: { symbol, name: "Test Co", initialPrice: "100" } });
  userId = (await db.user.create({ data: { email: `m-${randomUUID()}@example.test`, displayName: "M", account: { create: { cash: "1000" } } } })).id;
});
after(async () => {
  if (!skip) {
    await db.user.deleteMany({ where: { id: userId } });
    await db.instrument.delete({ where: { symbol } });
  }
  await db.$disconnect();
});

test("expireStaleOrders ends open orders from before the given day only", { skip }, async () => {
  const order = (tradingDay: number) =>
    db.order.create({ data: { userId, symbol, side: "BUY", type: "LIMIT", quantity: 1, limitPrice: "100", status: "OPEN", tradingDay } });
  const [old, recent] = [await order(10), await order(11)];

  const sent: string[] = [];
  const producer = { send: async ({ messages }: { messages: { value: string }[] }) => void sent.push(...messages.map((m) => m.value)) };
  await expireStaleOrders(db, producer as unknown as Producer, 11);

  const ended = sent.map((v) => parseEvent("executions", v).payload.orderId);
  assert.ok(ended.includes(old.id), "order from day 10 is expired");
  assert.ok(!ended.includes(recent.id), "order from day 11 is left to the book");
});
