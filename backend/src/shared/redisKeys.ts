// Every Redis key in the system is built here, so naming and TTLs stay consistent.
// Redis is a cache/ephemeral store only: anything here must be rebuildable from Postgres or safe to lose.

export const RedisKeys = {
  session: (sessionId: string) => `sess:${sessionId}`, // JSON {userId, role, otpVerified}
  otpChallenge: (challengeId: string) => `otp:${challengeId}`, // hash {userId, codeHash, attempts}
  userProfile: (userId: string) => `user:profile:${userId}`, // JSON cache of users row
  prices: "market:prices", // hash symbol -> latest price JSON; one HGETALL = whole market
  portfolio: (userId: string) => `portfolio:${userId}`, // JSON snapshot
  leaderboard: "leaderboard:equity", // sorted set userId -> total equity
  rateLimit: (scope: string, id: string) => `rl:${scope}:${id}`,
} as const;

export const RedisTtlSeconds = {
  session: 60 * 60 * 24, // 24h
  otpChallenge: 5 * 60, // 5 min
  userProfile: 10 * 60,
  portfolio: 30,
} as const;
