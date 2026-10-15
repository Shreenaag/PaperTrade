import { Prisma, type Order } from "../../generated/prisma/client.js";
import type { Db } from "../../infra/db.js";
import type { Kafka } from "../../infra/kafka.js";
import { makeEvent, parseEvent, Topics, type EventEnvelope, type Payload } from "../../shared/events.js";

// Settlement: the only writer of cash, holdings and order status after an order is placed.
// Consumes orders.executions.v1 (key = userId, so one user's events apply one at a time) and applies each
// event in ONE transaction together with its dedupe row, so redelivery is a no-op.

const Decimal = Prisma.Decimal;
type Tx = Prisma.TransactionClient;
type Fill = Extract<Payload<"executions">, { kind: "FILL" }>;
type End = Extract<Payload<"executions">, { kind: "END" }>;

export const SETTLEMENT_CONSUMER = "settlement";
const OPEN_STATUSES: Order["status"][] = ["OPEN", "PARTIALLY_FILLED"];

// Returns false when the event was already applied.
export function applyExecution(db: Db, event: EventEnvelope<"executions">): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.processedEvent.createMany({
      data: [{ consumer: SETTLEMENT_CONSUMER, eventId: event.id }],
      skipDuplicates: true,
    });
    if (count === 0) return false;

    const p = event.payload;
    const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
    if (order.userId !== p.userId) throw new Error(`execution ${event.id}: order ${order.id} belongs to another user`);
    const after = p.kind === "FILL" ? await fill(tx, order, p) : await end(tx, order, p);

    const update = makeEvent("ordersUpdates", {
      orderId: after.id,
      userId: after.userId,
      status: after.status as Payload<"ordersUpdates">["status"],
      filledQuantity: after.filledQuantity,
      avgFillPrice: after.avgFillPrice?.toFixed(4) ?? null,
      rejectReason: after.rejectReason,
    });
    await tx.outboxEvent.create({ data: { id: update.id, topic: update.topic, key: after.userId, payload: update as object } });
    return true;
  });
}

async function fill(tx: Tx, order: Order, p: Fill): Promise<Order> {
  const remaining = order.quantity - order.filledQuantity;
  // Engine bugs fail loudly: the transaction rolls back and the consumer retries instead of corrupting balances.
  if (!OPEN_STATUSES.includes(order.status) || p.quantity > remaining) throw new Error(`invalid fill ${p.tradeId} for order ${order.id}`);

  const { userId, symbol } = order;
  const q = p.quantity;
  const price = new Decimal(p.price);
  const fee = new Decimal(p.fee);
  const value = price.mul(q);
  const filled = order.filledQuantity + q;

  await tx.trade.create({
    data: { id: p.tradeId, matchId: p.matchId, orderId: order.id, userId, symbol, side: order.side, quantity: q, price, fee, tradingDay: p.tradingDay, executedAt: new Date(p.executedAt) },
  });

  // BUY: release this fill's share of the order's reservation (all of it on the last fill).
  const release =
    order.side === "BUY"
      ? q === remaining
        ? order.reservedCash
        : Decimal.min(order.reservedCash, order.reservedCash.mul(q).div(remaining).toDecimalPlaces(4, Decimal.ROUND_UP))
      : new Decimal(0);

  const holding = await tx.holding.findUnique({ where: { userId_symbol: { userId, symbol } } });
  let account;
  if (order.side === "BUY") {
    account = await tx.account.update({ where: { userId }, data: { cash: { decrement: value.add(fee) }, reservedCash: { decrement: release } } });
    const cost = value.add(fee); // fees are part of the cost basis
    if (holding) {
      const quantity = holding.quantity + q;
      await tx.holding.update({
        where: { userId_symbol: { userId, symbol } },
        data: { quantity, avgCost: holding.avgCost.mul(holding.quantity).add(cost).div(quantity).toDecimalPlaces(4) },
      });
    } else {
      await tx.holding.create({ data: { userId, symbol, quantity: q, avgCost: cost.div(q).toDecimalPlaces(4) } });
    }
  } else {
    if (!holding) throw new Error(`sell fill ${p.tradeId} without a holding`);
    account = await tx.account.update({ where: { userId }, data: { cash: { increment: value.sub(fee) } } });
    await tx.holding.update({
      where: { userId_symbol: { userId, symbol } },
      data: {
        quantity: { decrement: q },
        reservedQuantity: { decrement: q },
        realizedPnl: { increment: value.sub(fee).sub(holding.avgCost.mul(q)) },
      },
    });
  }

  await tx.ledgerEntry.createMany({
    data: [
      { userId, tradeId: p.tradeId, type: order.side === "BUY" ? "TRADE_BUY" : "TRADE_SELL", amount: order.side === "BUY" ? value.neg() : value, balanceAfter: account.cash.add(fee) },
      ...(fee.gt(0) ? [{ userId, tradeId: p.tradeId, type: "FEE" as const, amount: fee.neg(), balanceAfter: account.cash }] : []),
    ],
  });

  return tx.order.update({
    where: { id: order.id },
    data: {
      filledQuantity: filled,
      avgFillPrice: (order.avgFillPrice ?? new Decimal(0)).mul(order.filledQuantity).add(value).div(filled).toDecimalPlaces(4),
      status: filled === order.quantity ? "FILLED" : "PARTIALLY_FILLED",
      reservedCash: { decrement: release },
    },
  });
}

async function end(tx: Tx, order: Order, p: End): Promise<Order> {
  if (!OPEN_STATUSES.includes(order.status)) return order; // already filled/closed: nothing left to release
  const { userId, symbol } = order;
  if (order.side === "BUY") {
    await tx.account.update({ where: { userId }, data: { reservedCash: { decrement: order.reservedCash } } });
  } else {
    await tx.holding.update({
      where: { userId_symbol: { userId, symbol } },
      data: { reservedQuantity: { decrement: order.quantity - order.filledQuantity } },
    });
  }
  return tx.order.update({ where: { id: order.id }, data: { status: p.status, rejectReason: p.reason, reservedCash: 0 } });
}

export async function startSettlement(kafka: Kafka, db: Db): Promise<() => Promise<void>> {
  const consumer = kafka.consumer({ groupId: SETTLEMENT_CONSUMER });
  await consumer.connect();
  await consumer.subscribe({ topic: Topics.executions.name, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      let event;
      try {
        event = parseEvent("executions", message.value);
      } catch (err) {
        console.error("settlement: skipping malformed event", err); // poison pill must not block the partition
        return;
      }
      await applyExecution(db, event); // throws -> kafkajs retries the same message
    },
  });
  return () => consumer.disconnect();
}
