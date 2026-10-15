import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MarketPhases } from "./marketClock.js";

// Kafka contract for the whole system. Topic names carry a version suffix: a breaking payload
// change means a new topic (".v2"), never an in-place edit.
//
// Partition key decides ordering: Kafka only guarantees order within a partition.
//   market.prices / orders.placed -> key = symbol  (one instrument handled in order by one matcher)
//   orders.updates / trades.executed -> key = userId (one user's balance updated serially)
//
// Every event carries its tradingDay (src/shared/marketClock.ts). Price ticks also carry the phase:
// the first OPEN tick of a day is the opening-auction price, POST_CLOSE ticks carry the closing price.
// (tradingDay/phase/EXPIRED were added to .v1 before any producer or consumer existed.)

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, "decimal string"); // money never travels as a float
const side = z.enum(["BUY", "SELL"]);
const tradingDay = z.number().int().nonnegative();

export const Topics = {
  prices: {
    name: "market.prices.v1",
    partitions: 3,
    payload: z.object({ symbol: z.string(), price: decimal, tradingDay, phase: z.enum(MarketPhases), ts: z.iso.datetime() }),
  },
  ordersPlaced: {
    name: "orders.placed.v1",
    partitions: 3,
    payload: z.object({
      orderId: z.uuid(),
      userId: z.uuid(),
      symbol: z.string(),
      side,
      type: z.enum(["MARKET", "LIMIT"]),
      quantity: z.number().int().positive(),
      limitPrice: decimal.nullable(),
      tradingDay,
    }),
  },
  ordersUpdates: {
    name: "orders.updates.v1",
    partitions: 3,
    payload: z.object({
      orderId: z.uuid(),
      userId: z.uuid(),
      status: z.enum(["OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"]),
      filledQuantity: z.number().int().nonnegative(),
      avgFillPrice: decimal.nullable(),
      rejectReason: z.string().nullable(),
    }),
  },
  tradesExecuted: {
    name: "trades.executed.v1",
    partitions: 3,
    payload: z.object({
      tradeId: z.uuid(),
      orderId: z.uuid(),
      userId: z.uuid(),
      symbol: z.string(),
      side,
      quantity: z.number().int().positive(),
      price: decimal,
      fee: decimal,
      tradingDay,
      executedAt: z.iso.datetime(),
    }),
  },
} as const;

export type TopicKey = keyof typeof Topics;
export type Payload<T extends TopicKey> = z.infer<(typeof Topics)[T]["payload"]>;

// Every message value is this envelope. id doubles as the dedupe key (ProcessedEvent / OutboxEvent).
export interface EventEnvelope<T extends TopicKey = TopicKey> {
  id: string;
  topic: (typeof Topics)[T]["name"];
  occurredAt: string;
  payload: Payload<T>;
}

export function makeEvent<T extends TopicKey>(topic: T, payload: Payload<T>): EventEnvelope<T> {
  return {
    id: randomUUID(),
    topic: Topics[topic].name,
    occurredAt: new Date().toISOString(),
    payload: Topics[topic].payload.parse(payload) as Payload<T>,
  };
}

// Consumers call this on raw message values: rejects malformed events instead of trusting the wire.
export function parseEvent<T extends TopicKey>(topic: T, raw: Buffer | string | null): EventEnvelope<T> {
  const json = JSON.parse(String(raw ?? "null"));
  const envelope = z
    .object({ id: z.uuid(), topic: z.literal(Topics[topic].name), occurredAt: z.iso.datetime(), payload: Topics[topic].payload })
    .parse(json);
  return envelope as EventEnvelope<T>;
}
