import { randomUUID } from "node:crypto";
import type { Kafka } from "../../infra/kafka.js";
import { parseEvent, Topics } from "../../shared/events.js";
import type { LiveHub, OrderMsg, PriceMsg } from "./hub.js";

// Kafka -> browser: the API process reads price ticks and order updates and pushes them to open sockets.
// Its own consumer group, from "now": a browser only needs what happens while it is connected
// (it loads the current state over HTTP first).

type HubMessage = { kind: "price"; msg: PriceMsg } | { kind: "order"; userId: string; msg: OrderMsg };

export function toHubMessage(topic: string, raw: Buffer | string | null): HubMessage | null {
  try {
    if (topic === Topics.prices.name) {
      const { symbol, price, phase, tradingDay } = parseEvent("prices", raw).payload;
      return { kind: "price", msg: { type: "price", symbol, price, phase, tradingDay } };
    }
    if (topic === Topics.ordersUpdates.name) {
      const { userId, ...rest } = parseEvent("ordersUpdates", raw).payload;
      return { kind: "order", userId, msg: { type: "order", ...rest } };
    }
  } catch (err) {
    console.error(`live feed: skipping malformed ${topic} message`, err);
  }
  return null;
}

export async function startLiveFeed(kafka: Kafka, hub: LiveHub): Promise<() => Promise<void>> {
  const consumer = kafka.consumer({ groupId: `papertrade-api-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.prices.name, Topics.ordersUpdates.name], fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const m = toHubMessage(topic, message.value);
      if (m?.kind === "price") hub.price(m.msg);
      else if (m?.kind === "order") hub.order(m.userId, m.msg);
    },
  });
  return () => consumer.disconnect();
}
