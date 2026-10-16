import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createDb } from "../../infra/db.js";
import type { Producer } from "../../infra/kafka.js";
import { createRedis } from "../../infra/redis.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { relayOnce } from "./outbox.js";

// Real Postgres, fake producer. relayOnce marks EVERY pending row sent, so this only runs when the outbox is
// otherwise empty and no worker is relaying; otherwise real events would be marked sent without reaching Kafka.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()])
  .then(async () => {
    if (await redis.exists(RedisKeys.workerLock)) return "a worker is running (it would relay the test rows)";
    if (await db.outboxEvent.count({ where: { publishedAt: null } })) return "outbox has real pending events";
    return false;
  })
  .catch(() => (redis.disconnect(), "postgres/redis not reachable: docker compose up -d"));
const key = `outbox-test-${randomUUID()}`;

after(async () => {
  if (!skip) await db.outboxEvent.deleteMany({ where: { key } });
  redis.disconnect();
  await db.$disconnect();
});

test("relayOnce publishes unsent rows once, then marks them sent", { skip }, async () => {
  const ids = [randomUUID(), randomUUID()];
  await db.outboxEvent.createMany({ data: ids.map((id) => ({ id, topic: "market.prices.v1", key, payload: { id } })) });

  const sent: string[] = [];
  const producer = {
    sendBatch: async ({ topicMessages }: { topicMessages: { messages: { headers: Record<string, string> }[] }[] }) => {
      for (const t of topicMessages) for (const m of t.messages) sent.push(m.headers["event-id"]!);
    },
  } as unknown as Producer;

  assert.equal(await relayOnce(db, producer), 2);
  assert.deepEqual(sent.sort(), [...ids].sort());
  assert.ok((await db.outboxEvent.findMany({ where: { key } })).every((r) => r.publishedAt), "rows are marked sent");

  assert.equal(await relayOnce(db, producer), 0);
  assert.equal(sent.length, 2, "nothing is sent twice");
});
