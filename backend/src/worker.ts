import { loadEnv } from "./config/env.js";
import { createDb } from "./infra/db.js";
import { createKafka, createProducer, ensureTopics } from "./infra/kafka.js";
import { createRedis, tryLock } from "./infra/redis.js";
import { startBots } from "./modules/bots/bots.js";
import { startFairValue } from "./modules/market/fairValue.js";
import { startMatching } from "./modules/matching/matching.js";
import { startRelay } from "./modules/orders/outbox.js";
import { startSettlement } from "./modules/settlement/settlement.js";
import { RedisKeys, RedisTtlSeconds } from "./shared/redisKeys.js";

// The one background process (npm run worker): every non-HTTP job runs here, still talking over Kafka,
// so there are only two processes to start (API + worker).
const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const kafka = createKafka(env.KAFKA_BROKERS, `${env.KAFKA_CLIENT_ID}-worker`);
const producer = createProducer(kafka);

await Promise.all([db.$connect(), redis.connect()]);

// Exactly one worker: two would double-publish the outbox, run two clocks and two sets of bots, and split the
// matching partitions. Waits one lock lifetime first, so a watch restart or a crashed worker doesn't block it.
const ttl = RedisTtlSeconds.workerLock;
let lock = await tryLock(redis, RedisKeys.workerLock, ttl);
for (let waited = 0; !lock && waited < ttl; waited++) {
  if (waited === 0) console.log("worker: another worker holds the lock, waiting...");
  await new Promise((r) => setTimeout(r, 1000));
  lock = await tryLock(redis, RedisKeys.workerLock, ttl);
}
if (!lock) {
  console.error("worker: another worker is already running (Redis lock:worker). Stop it first.");
  redis.disconnect();
  await db.$disconnect();
  process.exit(1);
}
const heldLock = lock;
const stops: Array<() => unknown> = [];
const renewal = setInterval(async () => {
  if (await heldLock.renew().catch(() => true)) return; // Redis blip: keep going, the next renewal retries
  console.error("worker: lost the worker lock, shutting down");
  void shutdown();
}, (ttl * 1000) / 3);

await ensureTopics(kafka);
await producer.connect();

stops.push(
  await startFairValue(db, redis),
  startRelay(db, producer),
  await startSettlement(kafka, db),
  await startMatching(kafka, producer, db, redis),
  await startBots(db, redis), // last: stopped first, so its in-flight orders still reach the outbox
);
console.log("worker ready: fair-value, outbox relay, settlement, matching, bots");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(renewal);
  for (const stop of stops.reverse()) await stop();
  await heldLock.release().catch(() => {});
  await Promise.allSettled([producer.disconnect(), redis.quit(), db.$disconnect()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
