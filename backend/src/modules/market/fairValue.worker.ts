import { loadEnv } from "../../config/env.js";
import { createDb } from "../../infra/db.js";
import { createRedis } from "../../infra/redis.js";
import { sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { stepFairValue, toTickString } from "./fairValue.js";

// Worker process (npm run worker:fair-value): moves each instrument's hidden fair value once a second
// during OPEN and keeps it in Redis for the bots. Frozen in PRE_OPEN / POST_CLOSE.
const TICK_SECONDS = 1;

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
await Promise.all([db.$connect(), redis.connect()]);

// Resume from Redis; after a Redis wipe, from the last daily close, else the seeded price.
const saved = await redis.hgetall(RedisKeys.fairValue);
const instruments = await db.instrument.findMany({
  where: { isActive: true },
  include: { dailyBars: { orderBy: { tradingDay: "desc" }, take: 1 } },
});
const state = instruments.map((i) => ({
  symbol: i.symbol,
  sigma: i.volatility,
  tick: Number(i.tickSize),
  price: Number(saved[i.symbol] ?? i.dailyBars[0]?.close ?? i.initialPrice),
}));

const save = () => redis.hset(RedisKeys.fairValue, Object.fromEntries(state.map((s) => [s.symbol, toTickString(s.price, s.tick)])));
await save();
console.log(`fair-value worker: ${state.length} instruments`);

const timer = setInterval(() => {
  if (sessionAt().phase !== "OPEN") return;
  for (const s of state) s.price = stepFairValue(s.price, s.sigma, TICK_SECONDS);
  save().catch((err) => console.error("fair-value save failed", err));
}, TICK_SECONDS * 1000);

async function shutdown() {
  clearInterval(timer);
  await Promise.allSettled([redis.quit(), db.$disconnect()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
