import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import { PHASE_SECONDS, sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";

// Hidden "true value" of each instrument. Players never see it; bots (P3) quote and trade around it,
// and the traded price players see comes from the order book.
// Floats are fine here: this is a simulation input, not money. It becomes a decimal string at the edge.

const YEAR_IN_SIM_SECONDS = PHASE_SECONDS.OPEN * 252; // one OPEN phase = one real trading day

// Geometric Brownian motion step: annualised volatility sigma, dtSeconds of OPEN time.
export function stepFairValue(price: number, sigma: number, dtSeconds: number, rand: () => number = Math.random): number {
  const dt = dtSeconds / YEAR_IN_SIM_SECONDS;
  return price * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * gaussian(rand));
}

export function toTickString(price: number, tickSize: number): string {
  return (Math.max(1, Math.round(price / tickSize)) * tickSize).toFixed(4);
}

// Moves each instrument's fair value once a second during OPEN (frozen in PRE_OPEN / POST_CLOSE / CLOSED) and keeps it
// in Redis for the bots. Resumes from Redis; after a Redis wipe, from the last daily close, else the seeded price.
// nudge(symbol, fraction) moves one fair value at once (a player's order, see bots/strategies.ts impactOf).
export interface FairValue {
  stop(): void;
  nudge(symbol: string, fraction: number): Promise<void>;
}

export async function startFairValue(db: Db, redis: Redis, tickSeconds = 1): Promise<FairValue> {
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

  const timer = setInterval(() => {
    if (sessionAt().phase !== "OPEN") return;
    for (const s of state) s.price = stepFairValue(s.price, s.sigma, tickSeconds);
    save().catch((err) => console.error("fair-value save failed", err));
  }, tickSeconds * 1000);
  return {
    stop: () => clearInterval(timer),
    nudge: async (symbol, fraction) => {
      const s = state.find((x) => x.symbol === symbol);
      if (!s) return;
      s.price *= 1 + fraction;
      await redis.hset(RedisKeys.fairValue, symbol, toTickString(s.price, s.tick));
    },
  };
}

// Box-Muller; 1 - rand() keeps log() away from 0.
function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
