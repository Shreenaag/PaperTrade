import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb } from "./infra/db.js";
import { createKafka, createProducer, ensureTopics } from "./infra/kafka.js";
import { createRedis } from "./infra/redis.js";

const env = loadEnv();

const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const kafka = createKafka(env.KAFKA_BROKERS, env.KAFKA_CLIENT_ID);
const producer = createProducer(kafka);

let kafkaUp = false;
producer.on(producer.events.CONNECT, () => (kafkaUp = true));
producer.on(producer.events.DISCONNECT, () => (kafkaUp = false));

const app = buildApp({
  logLevel: env.LOG_LEVEL,
  prettyLogs: env.NODE_ENV === "development",
  checks: {
    postgres: () => db.$queryRaw`SELECT 1`,
    redis: () => redis.ping(),
    kafka: async () => {
      if (!kafkaUp) throw new Error("producer disconnected");
    },
  },
});

// Fail fast: refuse to serve traffic until every dependency is reachable.
await Promise.all([db.$connect(), redis.connect()]);
await ensureTopics(kafka);
await producer.connect();
await app.listen({ host: env.HOST, port: env.PORT });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close(); // stop accepting requests, finish in-flight ones
  await Promise.allSettled([producer.disconnect(), redis.quit(), db.$disconnect()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
