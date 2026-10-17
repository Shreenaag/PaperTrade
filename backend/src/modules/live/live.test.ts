import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { WebSocket } from "@fastify/websocket";
import { buildApp } from "../../app.js";
import { createRedis } from "../../infra/redis.js";
import { makeEvent } from "../../shared/events.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { toHubMessage } from "./feed.js";
import { createHub } from "./hub.js";

test("toHubMessage maps Kafka events to socket messages and skips malformed ones", () => {
  const price = makeEvent("prices", { symbol: "TCS", price: "101.5000", tradingDay: 7, phase: "OPEN", ts: new Date().toISOString() });
  assert.deepEqual(toHubMessage("market.prices.v1", JSON.stringify(price)), {
    kind: "price",
    msg: { type: "price", symbol: "TCS", price: "101.5000", phase: "OPEN", tradingDay: 7 },
  });
  const userId = randomUUID();
  const orderId = randomUUID();
  const update = makeEvent("ordersUpdates", { orderId, userId, status: "FILLED", filledQuantity: 3, avgFillPrice: "100.0000", rejectReason: null });
  assert.deepEqual(toHubMessage("orders.updates.v1", JSON.stringify(update)), {
    kind: "order",
    userId,
    msg: { type: "order", orderId, status: "FILLED", filledQuantity: 3, avgFillPrice: "100.0000", rejectReason: null },
  });
  assert.equal(toHubMessage("market.prices.v1", "not json"), null);
});

// Socket tests need Redis for sessions. Skipped when it's down.
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await redis.connect().then(() => false).catch(() => (redis.disconnect(), "redis not reachable: docker compose up -d"));
after(() => redis.disconnect());

const hub = createHub();
const app = buildApp({ logLevel: "silent", checks: {}, live: { redis, hub } });
await app.ready(); // injectWS exists once the websocket plugin has loaded
after(() => app.close());

const sessionFor = (userId: string) => createSession(redis, { userId, role: "USER" });
const connect = (sid?: string) => app.injectWS("/ws", { headers: sid ? { cookie: `${SESSION_COOKIE}=${sid}` } : {} });
const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
const inbox = (ws: WebSocket) => {
  const got: unknown[] = [];
  ws.on("message", (data) => got.push(JSON.parse(String(data))));
  return got;
};
const settle = () => new Promise((r) => setTimeout(r, 200));

test("ws: no session or an unknown one is closed with 4401", { skip }, async () => {
  assert.equal(await closeCode(await connect()), 4401);
  assert.equal(await closeCode(await connect("not-a-session")), 4401);
});

test("ws: order update reaches only its owner, on every open socket", { skip }, async () => {
  const [u, v] = [randomUUID(), randomUUID()];
  const [u1, u2, v1] = [await connect(await sessionFor(u)), await connect(await sessionFor(u)), await connect(await sessionFor(v))];
  const [g1, g2, gv] = [inbox(u1), inbox(u2), inbox(v1)];
  await settle(); // let the server register the sockets

  const msg = { type: "order" as const, orderId: randomUUID(), status: "FILLED", filledQuantity: 1, avgFillPrice: "100.0000", rejectReason: null };
  hub.order(u, msg);
  await settle();
  assert.deepEqual([g1, g2, gv], [[msg], [msg], []]);
  for (const ws of [u1, u2, v1]) ws.terminate();
});

test("ws: price goes to everyone; a closed socket is dropped", { skip }, async () => {
  const [a, b] = [await connect(await sessionFor(randomUUID())), await connect(await sessionFor(randomUUID()))];
  const gb = inbox(b);
  await settle();
  a.close();
  await settle();

  const msg = { type: "price" as const, symbol: "TCS", price: "100.0000", phase: "OPEN", tradingDay: 1 };
  hub.price(msg);
  await settle();
  assert.deepEqual(gb, [msg]);
  b.terminate();
});
