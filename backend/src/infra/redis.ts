import { Redis } from "ioredis";

// lazyConnect so startup can `await redis.connect()` and fail fast if Redis is down.
export function createRedis(url: string): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
}

// Fixed-window counter: returns how many hits this key has had in the current window.
export async function countHit(redis: Redis, key: string, windowSeconds: number): Promise<number> {
  const [[, n] = []] = (await redis.multi().incr(key).expire(key, windowSeconds, "NX").exec()) ?? [];
  return Number(n);
}

export type { Redis };
