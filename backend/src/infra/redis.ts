import { Redis } from "ioredis";

// lazyConnect so startup can `await redis.connect()` and fail fast if Redis is down.
export function createRedis(url: string): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
}

export type { Redis };
