import { loadEnv } from "./config/env.js";
import { createDb } from "./infra/db.js";
import { createKafka, createProducer, ensureTopics } from "./infra/kafka.js";
import { createRedis } from "./infra/redis.js";
import { startFairValue } from "./modules/market/fairValue.js";
import { startRelay } from "./modules/orders/outbox.js";
import { startSettlement } from "./modules/settlement/settlement.js";

// The one background process (npm run worker): every non-HTTP job runs here, still talking over Kafka,
// so there are only two processes to start (API + worker). Matching (P3b) and bots (P3c) plug in below.
const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const kafka = createKafka(env.KAFKA_BROKERS, `${env.KAFKA_CLIENT_ID}-worker`);
const producer = createProducer(kafka);

await Promise.all([db.$connect(), redis.connect()]);
await ensureTopics(kafka);
await producer.connect();

const stops = [await startFairValue(db, redis), startRelay(db, producer), await startSettlement(kafka, db)];
console.log("worker ready: fair-value, outbox relay, settlement");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const stop of stops.reverse()) await stop();
  await Promise.allSettled([producer.disconnect(), redis.quit(), db.$disconnect()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
