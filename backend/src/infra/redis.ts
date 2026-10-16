import { randomUUID } from "node:crypto";
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

// Lock owned by one process: held while it keeps renewing, gone ttlSeconds after it dies.
// Returns null if someone else holds it. renew() is false once the lock was lost (e.g. a long pause let it expire).
export async function tryLock(redis: Redis, key: string, ttlSeconds: number) {
  const token = randomUUID();
  if ((await redis.set(key, token, "EX", ttlSeconds, "NX")) !== "OK") return null;
  const ifMine = (then: string) => `if redis.call("get", KEYS[1]) == ARGV[1] then return ${then} else return 0 end`;
  return {
    renew: async () => (await redis.eval(ifMine('redis.call("expire", KEYS[1], ARGV[2])'), 1, key, token, ttlSeconds)) === 1,
    release: () => redis.eval(ifMine('redis.call("del", KEYS[1])'), 1, key, token),
  };
}

export type { Redis };
