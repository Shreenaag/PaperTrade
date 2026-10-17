// Every Redis key in the system is built here, so naming and TTLs stay consistent.
// Redis is a cache/ephemeral store only: anything here must be rebuildable from Postgres or safe to lose.

export const RedisKeys = {
  session: (sessionId: string) => `sess:${sessionId}`, // JSON {userId, role}
  oauthState: (state: string) => `oauth:${state}`, // JSON {provider, codeVerifier}
  userProfile: (userId: string) => `user:profile:v2:${userId}`, // JSON cache of users row (v2: + handle, profileComplete)
  prices: "market:prices", // hash symbol -> latest price JSON; one HGETALL = whole market
  fairValue: "market:fairvalue", // hash symbol -> hidden fair value (decimal string); bots only, never exposed by the API
  portfolio: (userId: string) => `portfolio:${userId}`, // JSON snapshot
  leaderboard: "leaderboard:equity", // sorted set userId -> total equity
  rateLimit: (scope: string, id: string) => `rl:${scope}:${id}`,
  workerLock: "lock:worker", // only one `npm run worker` at a time (src/worker.ts)
} as const;

export const RedisTtlSeconds = {
  session: 60 * 60 * 24, // 24h
  oauthState: 10 * 60, // time allowed on the provider's consent screen
  userProfile: 10 * 60,
  portfolio: 30,
  workerLock: 15, // a crashed worker frees the lock this long after its last renewal
} as const;
