import { setTimeout as sleep } from "node:timers/promises";
import type { Db } from "../../infra/db.js";
import type { Producer } from "../../infra/kafka.js";

// Transactional outbox relay: publishes rows written in the same DB transaction as the state change,
// then marks them published. A crash between the two re-sends; consumers dedupe on the event id.
// shortcut: one relay per deployment (no row locking); run a second worker and events go out twice (still deduped).

const BATCH = 500;
const IDLE_MS = 100;

export async function relayOnce(db: Db, producer: Producer): Promise<number> {
  const rows = await db.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { createdAt: "asc" }, take: BATCH });
  if (!rows.length) return 0;

  const byTopic = new Map<string, { key: string; value: string; headers: Record<string, string> }[]>();
  for (const r of rows) {
    const messages = byTopic.get(r.topic) ?? byTopic.set(r.topic, []).get(r.topic)!;
    messages.push({ key: r.key, value: JSON.stringify(r.payload), headers: { "event-id": r.id } });
  }
  await producer.sendBatch({ topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })) });
  await db.outboxEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { publishedAt: new Date() } });
  return rows.length;
}

// Space: published outbox rows are useless after an hour, and dedupe rows only need to outlive Kafka retention
// (1h, see shared/events.ts): an event deleted from Kafka can never be redelivered.
export async function pruneEventTables(db: Db, now = Date.now()): Promise<void> {
  const hour = 60 * 60 * 1000;
  await db.outboxEvent.deleteMany({ where: { publishedAt: { lt: new Date(now - hour) } } });
  await db.processedEvent.deleteMany({ where: { processedAt: { lt: new Date(now - 2 * hour) } } });
}

export function startRelay(db: Db, producer: Producer): () => Promise<void> {
  let running = true;
  let lastPrune = 0;
  const loop = (async () => {
    while (running) {
      try {
        const sent = await relayOnce(db, producer);
        if (Date.now() - lastPrune > 60_000) {
          lastPrune = Date.now();
          await pruneEventTables(db);
        }
        if (sent < BATCH) await sleep(IDLE_MS);
      } catch (err) {
        console.error("outbox relay failed, retrying", err);
        await sleep(1000);
      }
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}
