import { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { lastPrices } from "../orders/orders.service.js";

// Leaderboard: equity (cash + positions at last price) of every human player, in the Redis sorted set
// leaderboard:equity. Rebuilt by the worker every few seconds. Only players who finished their profile are ranked:
// bots (their topped-up shares keep an old avgCost), half-signed-up users and test users never appear.
// shortcut: recomputes everyone each refresh (2 queries); fine for a demo, switch to per-user updates on fills if users grow.

const Decimal = Prisma.Decimal;
const ranked = { isBot: false, profileCompletedAt: { not: null } } satisfies Prisma.UserWhereInput;

// Returns how many players were ranked.
export async function refreshLeaderboard(db: Db, redis: Redis): Promise<number> {
  const [accounts, holdings] = await Promise.all([
    db.account.findMany({ where: { user: ranked }, select: { userId: true, cash: true } }),
    db.holding.findMany({
      where: { quantity: { gt: 0 }, user: ranked },
      select: { userId: true, symbol: true, quantity: true, instrument: { select: { initialPrice: true } } },
    }),
  ]);
  const instruments = [...new Map(holdings.map((h) => [h.symbol, { symbol: h.symbol, initialPrice: h.instrument.initialPrice }])).values()];
  const prices = await lastPrices(db, redis, instruments);

  const equity = new Map(accounts.map((a) => [a.userId, a.cash]));
  for (const h of holdings) {
    const cash = equity.get(h.userId);
    if (cash) equity.set(h.userId, cash.add(prices.get(h.symbol)!.mul(h.quantity)));
  }

  const tx = redis.multi().del(RedisKeys.leaderboard);
  if (equity.size) tx.zadd(RedisKeys.leaderboard, ...[...equity].flatMap(([userId, e]) => [e.toNumber(), userId]));
  await tx.exec();
  return equity.size;
}

export function startLeaderboard(db: Db, redis: Redis, everyMs = 5000): () => void {
  const timer = setInterval(() => refreshLeaderboard(db, redis).catch((err) => console.error("leaderboard refresh failed", err)), everyMs);
  return () => clearInterval(timer);
}

export interface Rank {
  rank: number;
  equity: string;
  returnPct: string;
}

// Top `limit` players plus the caller's own rank (null until a refresh has included them).
export async function getLeaderboard(db: Db, redis: Redis, userId: string, limit = 20) {
  const [flat, myRank, myScore] = await Promise.all([
    redis.zrevrange(RedisKeys.leaderboard, 0, limit - 1, "WITHSCORES"),
    redis.zrevrank(RedisKeys.leaderboard, userId),
    redis.zscore(RedisKeys.leaderboard, userId),
  ]);
  const rows = [];
  for (let i = 0; i < flat.length; i += 2) rows.push({ userId: flat[i]!, equity: new Decimal(flat[i + 1]!) });

  const ids = [...new Set([...rows.map((r) => r.userId), userId])];
  const [users, grants] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, handle: true } }),
    db.ledgerEntry.groupBy({ by: ["userId"], where: { userId: { in: ids }, type: "INITIAL_GRANT" }, _sum: { amount: true } }),
  ]);
  const names = new Map(users.map((u) => [u.id, u]));
  const grantOf = new Map(grants.map((g) => [g.userId, g._sum.amount ?? new Decimal(0)]));
  const rank = (position: number, equity: Prisma.Decimal, id: string): Rank => {
    const grant = grantOf.get(id) ?? new Decimal(0);
    return { rank: position + 1, equity: equity.toFixed(4), returnPct: grant.isZero() ? "0.00" : equity.sub(grant).div(grant).mul(100).toFixed(2) };
  };

  return {
    // A player deleted since the last refresh is still in the set for up to one refresh: leave them out.
    top: rows
      .filter((r) => names.has(r.userId))
      .map((r, i) => ({ ...rank(i, r.equity, r.userId), displayName: names.get(r.userId)!.displayName, handle: names.get(r.userId)!.handle, isMe: r.userId === userId })),
    me: myRank === null || myScore === null ? null : rank(myRank, new Decimal(myScore), userId),
  };
}
