import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import { RedisKeys, RedisTtlSeconds } from "../../shared/redisKeys.js";
import type { OAuthIdentity } from "./oauth.js";

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: "USER" | "ADMIN";
  createdAt: string;
}

// Login = find by OAuth identity, else link to the user with the same (provider-verified) email,
// else sign up: user + identity + paper-cash account + INITIAL_GRANT ledger entry in one transaction.
export async function findOrCreateUser(db: Db, identity: OAuthIdentity, startingCash: string) {
  const { provider, providerAccountId, email, displayName, avatarUrl } = identity;
  const attempt = () =>
    db.$transaction(async (tx) => {
      const linked = await tx.oAuthAccount.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        include: { user: true },
      });
      if (linked) return linked.user;

      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) {
        await tx.oAuthAccount.create({ data: { userId: existing.id, provider, providerAccountId } });
        return existing;
      }

      return tx.user.create({
        data: {
          email,
          displayName,
          avatarUrl,
          oauthAccounts: { create: { provider, providerAccountId } },
          account: { create: { cash: startingCash } },
          ledger: { create: { type: "INITIAL_GRANT", amount: startingCash, balanceAfter: startingCash } },
        },
      });
    });
  try {
    return await attempt();
  } catch (err) {
    // Two first-time logins racing: the loser hits a unique constraint; on retry it finds the winner's row.
    if ((err as { code?: string }).code === "P2002") return attempt();
    throw err;
  }
}

// Cache-aside: Redis first, Postgres on a miss.
export async function getProfile(db: Db, redis: Redis, userId: string): Promise<Profile | null> {
  const key = RedisKeys.userProfile(userId);
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as Profile;

  const u = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, avatarUrl: true, role: true, createdAt: true },
  });
  if (!u) return null;
  const profile: Profile = { ...u, createdAt: u.createdAt.toISOString() };
  await redis.set(key, JSON.stringify(profile), "EX", RedisTtlSeconds.userProfile);
  return profile;
}
