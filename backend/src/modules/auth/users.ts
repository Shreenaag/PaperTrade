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
  handle: string | null;
  profileComplete: boolean; // P5: false until PUT /me/profile; the UI asks for it first, trading needs it
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
    select: { id: true, email: true, displayName: true, avatarUrl: true, role: true, createdAt: true, handle: true, profileCompletedAt: true },
  });
  if (!u) return null;
  const { profileCompletedAt, ...rest } = u;
  const profile: Profile = { ...rest, createdAt: u.createdAt.toISOString(), profileComplete: profileCompletedAt !== null };
  await redis.set(key, JSON.stringify(profile), "EX", RedisTtlSeconds.userProfile);
  return profile;
}

export class HandleTakenError extends Error {}

// Completes (or edits) the public profile. The handle is unique; the cached profile is dropped so /me shows the change.
export async function updateProfile(db: Db, redis: Redis, userId: string, displayName: string, handle: string): Promise<Profile | null> {
  try {
    await db.user.update({ where: { id: userId }, data: { displayName, handle, profileCompletedAt: new Date() } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new HandleTakenError();
    throw err;
  }
  await redis.del(RedisKeys.userProfile(userId));
  return getProfile(db, redis, userId);
}
