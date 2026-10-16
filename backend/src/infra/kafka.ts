import { Kafka, logLevel, Partitioners, type Producer } from "kafkajs";
import { Topics, type EventEnvelope, type TopicKey } from "../shared/events.js";

export function createKafka(brokers: string[], clientId: string): Kafka {
  return new Kafka({ clientId, brokers, logLevel: logLevel.WARN });
}

// Idempotent producer: broker drops duplicates caused by producer retries.
// DefaultPartitioner = murmur2, same key->partition mapping as the Java client.
export function createProducer(kafka: Kafka): Producer {
  return kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    allowAutoTopicCreation: false,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
}

// Creates any missing topics from the contract in shared/events.ts. Safe to run on every startup.
export async function ensureTopics(kafka: Kafka, replicationFactor = 1): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = Object.values(Topics).filter((t) => !existing.has(t.name));
    if (missing.length) {
      await admin.createTopics({
        waitForLeaders: true,
        topics: missing.map((t) => ({
          topic: t.name,
          numPartitions: t.partitions,
          replicationFactor,
          // small segments so old data is actually deleted soon after retention (default segment is 1 GB)
          configEntries: [
            { name: "retention.ms", value: String(t.retentionMs) },
            { name: "segment.ms", value: String(Math.min(t.retentionMs, 10 * 60 * 1000)) },
          ],
        })),
      });
    }
  } finally {
    await admin.disconnect();
  }
}

export async function publish<T extends TopicKey>(producer: Producer, key: string, event: EventEnvelope<T>): Promise<void> {
  await producer.send({
    topic: event.topic,
    messages: [{ key, value: JSON.stringify(event), headers: { "event-id": event.id } }],
  });
}

export type { Kafka, Producer };
