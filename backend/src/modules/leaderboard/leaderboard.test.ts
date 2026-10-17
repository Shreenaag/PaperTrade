import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../../app.js";
import { createDb, type Db } from "../../infra/db.js";
import { createRedis } from "../../infra/redis.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { refreshLeaderboard } from "./leaderboard.js";

// Integration test against compose Postgres/Redis. Real users may exist too, so assertions look at the test users only.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()])
  .then(() => false)
  .catch(() => (redis.disconnect(), "postgres/redis not reachable: docker compose up -d"));

const symbol = `L${randomUUID().slice(0, 8).toUpperCase()}`;
const userIds: string[] = [];

before(async () => {
  if (skip) return;
  await db.instrument.create({ data: { symbol, name: "Test Co", initialPrice: "100" } });
  await redis.hset(RedisKeys.prices, symbol, JSON.stringify({ symbol, price: "100" }));
});
after(async () => {
  if (!skip) {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.instrument.delete({ where: { symbol } });
    await redis.hdel(RedisKeys.prices, symbol);
    await refreshLeaderboard(db, redis); // rebuild the real board without the test users
  }
  redis.disconnect();
  await db.$disconnect();
});

async function newUser(cash: string, opts: { isBot?: boolean; shares?: number; profile?: boolean } = {}) {
  const n = userIds.length;
  const user = await db.user.create({
    data: {
      email: `lb-${randomUUID()}@example.test`,
      displayName: `Player ${n}`,
      isBot: opts.isBot ?? false,
      ...((opts.profile ?? true) && { handle: `lb_${randomUUID().slice(0, 8)}_${n}`, profileCompletedAt: new Date() }),
      account: { create: { cash } },
      ledger: { create: { type: "INITIAL_GRANT", amount: "1000", balanceAfter: "1000" } },
      ...(opts.shares && { holdings: { create: { symbol, quantity: opts.shares, avgCost: "100" } } }),
    },
  });
  userIds.push(user.id);
  return user.id;
}

test("refresh ranks players by equity; skips bots and players without a profile", { skip }, async () => {
  const h1 = await newUser("1000");
  const h2 = await newUser("500", { shares: 10 }); // 500 + 10 x 100 = 1500
  const bot = await newUser("9000000000", { isBot: true });
  const newcomer = await newUser("8000000000", { profile: false });
  await refreshLeaderboard(db, redis);

  const ranked = await redis.zrevrange(RedisKeys.leaderboard, 0, -1, "WITHSCORES");
  const ids = ranked.filter((_, i) => i % 2 === 0);
  assert.ok(!ids.includes(bot), "bots are not ranked");
  assert.ok(!ids.includes(newcomer), "players who haven't finished their profile are not ranked");
  assert.ok(ids.indexOf(h2) < ids.indexOf(h1) && ids.indexOf(h1) >= 0, "higher equity ranks first");
  assert.equal(await redis.zscore(RedisKeys.leaderboard, h2), "1500");
});

test("refresh with no humans leaves an empty set", { skip }, async () => {
  const none = {
    account: { findMany: async () => [] },
    holding: { findMany: async () => [] },
  } as unknown as Db;
  assert.equal(await refreshLeaderboard(none, redis), 0);
  assert.equal(await redis.exists(RedisKeys.leaderboard), 0);
});

test("GET /leaderboard skips players deleted since the last refresh", { skip }, async () => {
  const sid = await createSession(redis, { userId: await newUser("1000"), role: "USER" });
  await refreshLeaderboard(db, redis);
  const ghost = randomUUID();
  await redis.zadd(RedisKeys.leaderboard, 9e15, ghost); // ranked, then the user row was deleted
  const app = buildApp({ logLevel: "silent", checks: {}, orders: { db, redis } });
  const { top } = (await app.inject({ url: "/leaderboard", cookies: { [SESSION_COOKIE]: sid } })).json();
  assert.ok(!top.some((r: { equity: string }) => r.equity === "9000000000000000.0000"), "the deleted player is not listed");
  assert.ok(top.every((r: { displayName?: string }) => typeof r.displayName === "string"), "every row names a real player");
  assert.equal(top[0]?.rank, 1, "ranks are counted among existing players");
  await redis.zrem(RedisKeys.leaderboard, ghost);
  await app.close();
});

test("GET /leaderboard: top 20, isMe, me outside the top 20; needs a session", { skip }, async () => {
  const leaders: string[] = [];
  for (let i = 0; i < 21; i++) leaders.push(await newUser(String(50_000_000 + i))); // above any real player
  const me = await newUser("1");
  await refreshLeaderboard(db, redis);

  const app = buildApp({ logLevel: "silent", checks: {}, orders: { db, redis } });
  const get = async (userId?: string) =>
    app.inject({ url: "/leaderboard", cookies: userId ? { [SESSION_COOKIE]: await createSession(redis, { userId, role: "USER" }) } : {} });

  assert.equal((await get()).statusCode, 401);

  const mine = (await get(me)).json();
  assert.equal(mine.top.length, 20);
  assert.deepEqual(mine.top.slice(0, 2).map((r: { rank: number; equity: string }) => [r.rank, r.equity]), [[1, "50000020.0000"], [2, "50000019.0000"]]);
  assert.ok(mine.me.rank > 20);
  assert.deepEqual([mine.me.equity, mine.me.returnPct], ["1.0000", "-99.90"]);
  assert.ok(mine.top.every((r: { isMe: boolean }) => !r.isMe));

  const leader = (await get(leaders[20])).json();
  assert.deepEqual([leader.top[0].isMe, leader.top[0].displayName, leader.top[0].returnPct], [true, "Player " + userIds.indexOf(leaders[20]!), "4999902.00"]);
  assert.match(leader.top[0].handle, /^lb_/);
  assert.equal(leader.me.rank, 1);
  await app.close();
});
