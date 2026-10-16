import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../../app.js";
import { createDb } from "../../infra/db.js";
import { createRedis } from "../../infra/redis.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import type { AuthDeps } from "./auth.routes.js";
import type { OAuthIdentity, OAuthProvider, ProviderName } from "./oauth.js";

// Integration test: real Postgres + Redis from docker compose, fake OAuth provider and mailer.
// Skipped (not failed) when the containers aren't running.
const db = createDb(process.env["DATABASE_URL"] ?? "postgresql://localhost/none");
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await Promise.all([db.$queryRaw`SELECT 1`, redis.connect()])
  .then(() => false)
  .catch(() => (redis.disconnect(), "postgres/redis not reachable: docker compose up -d"));

const emails: string[] = [];
// inject() always comes from 127.0.0.1, so back-to-back runs would trip the real 20/min login limit.
before(async () => {
  if (!skip) await redis.del(RedisKeys.rateLimit("login", "127.0.0.1"));
});
after(async () => {
  if (!skip) await db.user.deleteMany({ where: { email: { in: emails } } });
  redis.disconnect();
  await db.$disconnect();
});

const sent: string[] = []; // OTP codes "emailed"

function newIdentity(provider: ProviderName = "github", email = `t-${randomUUID()}@example.test`): OAuthIdentity {
  emails.push(email);
  return { provider, providerAccountId: randomUUID(), email, displayName: "Test User", avatarUrl: null };
}

function fakeProvider(current: () => OAuthIdentity): OAuthProvider {
  return {
    authorizeUrl: ({ state }) => `https://provider.test/authorize?state=${state}`,
    fetchIdentity: async ({ code }) => {
      if (code === "bad") throw new Error("provider down");
      return current();
    },
  };
}

let identity = newIdentity();
let googleIdentity = newIdentity("google");

function makeApp(providers: AuthDeps["providers"] = { github: fakeProvider(() => identity), google: fakeProvider(() => googleIdentity) }) {
  return buildApp({
    logLevel: "silent",
    checks: {},
    auth: {
      db,
      redis,
      providers,
      sendOtp: async (_email, code) => void sent.push(code),
      config: {
        appBaseUrl: "http://api.test",
        webAppUrl: "http://web.test",
        authSecret: "x".repeat(32),
        startingCash: "1000000",
        secureCookies: false,
      },
    },
  });
}
const app = makeApp();

const cookie = (res: LightMyRequestResponse, name: string) =>
  (res.cookies as { name: string; value: string }[]).find((c) => c.name === name)?.value;

async function oauthLogin(provider: ProviderName = "github", code = "ok") {
  const start = await app.inject({ url: `/auth/${provider}/login` });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  const res = await app.inject({
    url: `/auth/${provider}/callback?code=${code}&state=${state}`,
    cookies: { oauth_state: cookie(start, "oauth_state")! },
  });
  return { res, sid: cookie(res, "sid")!, code: sent.at(-1)! };
}

const verify = (sid: string, code: string) =>
  app.inject({ method: "POST", url: "/auth/otp/verify", cookies: { sid }, payload: { code } });
const me = (sid: string) => app.inject({ url: "/me", cookies: { sid } });
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

test("full login: OAuth -> OTP -> session -> /me, and sign-up grants starting cash", { skip }, async () => {
  const { res, sid, code } = await oauthLogin();
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "http://web.test/verify-otp");

  assert.deepEqual((await me(sid)).json(), { error: "OTP_REQUIRED" });
  assert.deepEqual((await verify(sid, wrong(code))).json(), { error: "OTP_INVALID" });

  const ok = await verify(sid, code);
  assert.equal(ok.statusCode, 200);
  const fullSid = cookie(ok, "sid")!;
  assert.notEqual(fullSid, sid, "session id rotates after OTP");

  const profile = await me(fullSid);
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().email, identity.email);
  assert.equal((await me(sid)).statusCode, 401, "pending session is gone");

  const user = await db.user.findUniqueOrThrow({ where: { email: identity.email }, include: { account: true, ledger: true } });
  assert.equal(user.account!.cash.toString(), "1000000");
  assert.deepEqual(user.ledger.map((l) => [l.type, l.amount.toString()]), [["INITIAL_GRANT", "1000000"]]);
});

test("returning user is not re-created; same verified email on another provider links to the same user", { skip }, async () => {
  await oauthLogin();
  googleIdentity = { ...newIdentity("google"), email: identity.email };
  await oauthLogin("google");

  const user = await db.user.findUniqueOrThrow({ where: { email: identity.email }, include: { oauthAccounts: true, ledger: true } });
  assert.deepEqual(user.oauthAccounts.map((a) => a.provider).sort(), ["github", "google"]);
  assert.equal(user.ledger.length, 1, "cash granted once");
});

test("callback rejects a state that doesn't match this browser's cookie", { skip }, async () => {
  const start = await app.inject({ url: "/auth/github/login" });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  const res = await app.inject({ url: `/auth/github/callback?code=ok&state=${state}`, cookies: { oauth_state: "other" } });
  assert.equal(res.headers.location, "http://web.test/login?error=state_mismatch");
  assert.equal(cookie(res, "sid"), undefined);
});

test("provider failure and user denial redirect with an error", { skip }, async () => {
  assert.equal((await oauthLogin("github", "bad")).res.headers.location, "http://web.test/login?error=provider_error");
  const denied = await app.inject({ url: "/auth/github/callback?error=access_denied" });
  assert.equal(denied.headers.location, "http://web.test/login?error=oauth_denied");
});

test("OTP locks after 5 wrong attempts, even the right code then fails", { skip }, async () => {
  identity = newIdentity();
  const { sid, code } = await oauthLogin();
  for (let i = 1; i < 5; i++) assert.equal((await verify(sid, wrong(code))).json().error, "OTP_INVALID");
  assert.equal((await verify(sid, wrong(code))).json().error, "OTP_LOCKED");
  assert.equal((await verify(sid, code)).json().error, "OTP_EXPIRED");
});

test("resend has a cooldown", { skip }, async () => {
  const { sid } = await oauthLogin();
  const res = await app.inject({ method: "POST", url: "/auth/otp/resend", cookies: { sid } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, "OTP_COOLDOWN");
});

test("logout ends the session", { skip }, async () => {
  const { sid, code } = await oauthLogin();
  const fullSid = cookie(await verify(sid, code), "sid")!;
  assert.equal((await app.inject({ method: "POST", url: "/auth/logout", cookies: { sid: fullSid } })).statusCode, 204);
  assert.deepEqual((await me(fullSid)).json(), { error: "UNAUTHENTICATED" });
});

test("providers without credentials are disabled", { skip }, async () => {
  const bare = makeApp({});
  assert.deepEqual((await bare.inject({ url: "/auth/providers" })).json(), { providers: [] });
  assert.equal((await bare.inject({ url: "/auth/google/login" })).statusCode, 404);
  assert.equal((await bare.inject({ url: "/auth/twitter/login" })).statusCode, 400);
});
