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

// Integration test: real Postgres + Redis from docker compose, fake OAuth provider.
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
      config: {
        appBaseUrl: "http://api.test",
        webAppUrl: "http://web.test",
        startingCash: "1000000",
        secureCookies: false,
      },
    },
  });
}
const app = makeApp();

const cookie = (res: LightMyRequestResponse, name: string) =>
  (res.cookies as { name: string; value: string }[]).find((c) => c.name === name)?.value;

async function oauthLogin(provider: ProviderName = "github", code = "ok", sid?: string) {
  const start = await app.inject({ url: `/auth/${provider}/login` });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  const res = await app.inject({
    url: `/auth/${provider}/callback?code=${code}&state=${state}`,
    cookies: { oauth_state: cookie(start, "oauth_state")!, ...(sid && { sid }) },
  });
  return { res, sid: cookie(res, "sid")! };
}

const me = (sid: string) => app.inject({ url: "/me", cookies: { sid } });
const putProfile = (sid: string | undefined, payload: object) =>
  app.inject({ method: "PUT", url: "/me/profile", cookies: sid ? { sid } : {}, payload });

async function loggedIn() {
  identity = newIdentity();
  return (await oauthLogin()).sid;
}

test("sign-up: GitHub alone signs you in, grants starting cash, and sends you to the profile page", { skip }, async () => {
  identity = newIdentity();
  const { res, sid } = await oauthLogin();
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "http://web.test/profile");

  const profile = await me(sid);
  assert.equal(profile.statusCode, 200);
  assert.deepEqual([profile.json().email, profile.json().profileComplete], [identity.email, false]);

  const user = await db.user.findUniqueOrThrow({ where: { email: identity.email }, include: { account: true, ledger: true } });
  assert.equal(user.account!.cash.toString(), "1000000");
  assert.deepEqual(user.ledger.map((l) => [l.type, l.amount.toString()]), [["INITIAL_GRANT", "1000000"]]);
});

test("a returning player with a finished profile goes straight to trading, with a fresh session id", { skip }, async () => {
  const first = await loggedIn();
  assert.equal((await putProfile(first, { displayName: "Back Again", handle: `b_${randomUUID().slice(0, 8)}` })).statusCode, 200);

  const again = await oauthLogin("github", "ok", first);
  assert.equal(again.res.headers.location, "http://web.test/");
  assert.notEqual(again.sid, first, "never reuse a session id across logins");
  assert.equal((await me(first)).statusCode, 401, "the old session is gone");
  assert.equal((await me(again.sid)).statusCode, 200);
});

test("returning user is not re-created; same verified email on another provider links to the same user", { skip }, async () => {
  identity = newIdentity();
  await oauthLogin();
  googleIdentity = { ...newIdentity("google"), email: identity.email };
  await oauthLogin("google");
  await oauthLogin();
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

test("logout ends the session", { skip }, async () => {
  const sid = await loggedIn();
  assert.equal((await app.inject({ method: "POST", url: "/auth/logout", cookies: { sid } })).statusCode, 204);
  assert.deepEqual((await me(sid)).json(), { error: "UNAUTHENTICATED" });
});

test("providers without credentials are disabled", { skip }, async () => {
  const bare = makeApp({});
  assert.deepEqual((await bare.inject({ url: "/auth/providers" })).json(), { providers: [] });
  assert.equal((await bare.inject({ url: "/auth/google/login" })).statusCode, 404);
  assert.equal((await bare.inject({ url: "/auth/twitter/login" })).statusCode, 400);
});

test("the email one-time-code endpoints are gone", { skip }, async () => {
  const sid = await loggedIn();
  for (const url of ["/auth/otp/verify", "/auth/otp/resend"]) {
    assert.equal((await app.inject({ method: "POST", url, cookies: { sid }, payload: { code: "123456" } })).statusCode, 404, url);
  }
});

test("profile: incomplete until PUT /me/profile; handle validated and unique; /me reflects it", { skip }, async () => {
  const sid = await loggedIn();
  const before = (await me(sid)).json();
  assert.deepEqual([before.handle, before.profileComplete], [null, false]);

  assert.equal((await putProfile(undefined, { displayName: "Jo", handle: "jo_123" })).statusCode, 401);
  for (const bad of [{ displayName: "Jo", handle: "JO" }, { displayName: "Jo", handle: "a!" }, { displayName: "", handle: "okay_1" }, { displayName: "Jo" }]) {
    assert.equal((await putProfile(sid, bad)).statusCode, 400, JSON.stringify(bad));
  }

  const handle = `t_${randomUUID().slice(0, 8)}`;
  const ok = await putProfile(sid, { displayName: "  Trader Jo ", handle });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual([ok.json().displayName, ok.json().handle, ok.json().profileComplete], ["Trader Jo", handle, true]);
  const after = (await me(sid)).json(); // the cached profile was refreshed
  assert.deepEqual([after.displayName, after.handle, after.profileComplete], ["Trader Jo", handle, true]);
  assert.equal((await putProfile(sid, { displayName: "Trader Jo", handle })).statusCode, 200, "saving your own handle again is fine");

  const other = await loggedIn();
  assert.deepEqual([(await putProfile(other, { displayName: "Copy", handle })).statusCode, (await putProfile(other, { displayName: "Copy", handle })).json()], [409, { error: "HANDLE_TAKEN" }]);
});
