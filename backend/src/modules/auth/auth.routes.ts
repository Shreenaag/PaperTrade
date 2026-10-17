import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../../infra/db.js";
import { countHit, type Redis } from "../../infra/redis.js";
import { LOGIN_PER_MINUTE_PER_IP } from "../../shared/limits.js";
import { RedisKeys, RedisTtlSeconds } from "../../shared/redisKeys.js";
import { pkcePair, type OAuthProviders, type ProviderName } from "./oauth.js";
import { createSession, deleteSession, requireAuth, SESSION_COOKIE, setSessionCookie } from "./session.js";
import { findOrCreateUser, getProfile, HandleTakenError, updateProfile } from "./users.js";

export interface AuthDeps {
  db: Db;
  redis: Redis;
  providers: OAuthProviders;
  config: {
    appBaseUrl: string;
    webAppUrl: string;
    startingCash: string;
    secureCookies: boolean;
  };
}

const STATE_COOKIE = "oauth_state";

// Login flow:
//   GET  /auth/:provider/login     -> redirect to provider (state + PKCE)
//   GET  /auth/:provider/callback  -> user found/created, session cookie, redirect to WEB_APP_URL/profile
//                                     (new player) or WEB_APP_URL/ (profile done); failures: /login?error=...
//   PUT  /me/profile {displayName, handle} -> profile complete (asked once, before the first trade)
// Errors are { error: "CODE" }; the frontend switches on the code.
export const authRoutes =
  ({ db, redis, providers, config }: AuthDeps): FastifyPluginAsync =>
  async (app) => {
    const providerParam = {
      type: "object",
      required: ["provider"],
      properties: { provider: { type: "string", enum: ["google", "github"] } },
    } as const;
    const callbackUrl = (p: ProviderName) => `${config.appBaseUrl}/auth/${p}/callback`;

    app.get("/auth/providers", async () => ({ providers: Object.keys(providers) }));

    app.get<{ Params: { provider: ProviderName } }>(
      "/auth/:provider/login",
      { schema: { params: providerParam } },
      async (req, reply) => {
        const provider = providers[req.params.provider];
        if (!provider) return reply.code(404).send({ error: "PROVIDER_DISABLED" });
        if ((await countHit(redis, RedisKeys.rateLimit("login", req.ip), 60)) > LOGIN_PER_MINUTE_PER_IP) {
          return reply.code(429).send({ error: "RATE_LIMITED" });
        }

        const state = randomBytes(16).toString("base64url");
        const { codeVerifier, codeChallenge } = pkcePair();
        await redis.set(
          RedisKeys.oauthState(state),
          JSON.stringify({ provider: req.params.provider, codeVerifier }),
          "EX",
          RedisTtlSeconds.oauthState,
        );
        // State is also pinned to this browser, so an attacker can't make a victim finish the attacker's login.
        reply.setCookie(STATE_COOKIE, state, {
          path: "/auth",
          httpOnly: true,
          sameSite: "lax",
          secure: config.secureCookies,
          maxAge: RedisTtlSeconds.oauthState,
        });
        return reply.redirect(provider.authorizeUrl({ state, codeChallenge, redirectUri: callbackUrl(req.params.provider) }));
      },
    );

    app.get<{ Params: { provider: ProviderName }; Querystring: { code?: string; state?: string; error?: string } }>(
      "/auth/:provider/callback",
      { schema: { params: providerParam } },
      async (req, reply) => {
        const name = req.params.provider;
        const provider = providers[name];
        if (!provider) return reply.code(404).send({ error: "PROVIDER_DISABLED" });

        reply.clearCookie(STATE_COOKIE, { path: "/auth" });
        const fail = (reason: string) => reply.redirect(`${config.webAppUrl}/login?error=${reason}`);

        const { code, state, error } = req.query;
        if (error || !code || !state) return fail("oauth_denied");
        if (req.cookies[STATE_COOKIE] !== state) return fail("state_mismatch");
        const saved = await redis.getdel(RedisKeys.oauthState(state)); // one-time use
        if (!saved) return fail("state_expired");
        const { provider: savedProvider, codeVerifier } = JSON.parse(saved) as { provider: string; codeVerifier: string };
        if (savedProvider !== name) return fail("state_mismatch");

        let identity;
        try {
          identity = await provider.fetchIdentity({ code, codeVerifier, redirectUri: callbackUrl(name) });
        } catch (err) {
          req.log.warn({ err, provider: name }, "oauth identity fetch failed");
          return fail("provider_error");
        }

        const user = await findOrCreateUser(db, identity, config.startingCash);
        await deleteSession(redis, req.cookies[SESSION_COOKIE]); // never reuse a session id across logins
        const sid = await createSession(redis, { userId: user.id, role: user.role });
        setSessionCookie(reply, sid, config.secureCookies, RedisTtlSeconds.session);
        // A new player sets up their profile first; a returning one goes straight to trading.
        return reply.redirect(`${config.webAppUrl}/${user.profileCompletedAt ? "" : "profile"}`);
      },
    );

    app.post("/auth/logout", async (req, reply) => {
      await deleteSession(redis, req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get("/me", { preHandler: requireAuth(redis) }, async (req, reply) => {
      const profile = await getProfile(db, redis, req.user!.userId);
      if (!profile) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return profile;
    });

    // PUT /me/profile {displayName, handle} -> 200 profile | 409 HANDLE_TAKEN. Required once before trading (P5).
    app.put<{ Body: { displayName: string; handle: string } }>(
      "/me/profile",
      {
        preHandler: requireAuth(redis),
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["displayName", "handle"],
            properties: {
              displayName: { type: "string", minLength: 1, maxLength: 40, pattern: "\\S" },
              handle: { type: "string", pattern: "^[a-z0-9_]{3,20}$" },
            },
          },
        },
      },
      async (req, reply) => {
        try {
          const profile = await updateProfile(db, redis, req.user!.userId, req.body.displayName.trim(), req.body.handle);
          return profile ?? reply.code(401).send({ error: "UNAUTHENTICATED" });
        } catch (err) {
          if (err instanceof HandleTakenError) return reply.code(409).send({ error: "HANDLE_TAKEN" });
          throw err;
        }
      },
    );
  };
