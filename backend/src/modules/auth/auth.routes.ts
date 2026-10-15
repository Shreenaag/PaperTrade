import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import { RedisKeys, RedisTtlSeconds } from "../../shared/redisKeys.js";
import type { SendOtp } from "./mailer.js";
import { pkcePair, type OAuthProviders, type ProviderName } from "./oauth.js";
import { createOtpChallenge, deleteOtpChallenge, takeResendSlot, verifyOtp } from "./otp.js";
import {
  createSession,
  deleteSession,
  getSession,
  requireAuth,
  SESSION_COOKIE,
  setSessionCookie,
  updateSession,
} from "./session.js";
import { findOrCreateUser, getProfile } from "./users.js";

export interface AuthDeps {
  db: Db;
  redis: Redis;
  providers: OAuthProviders;
  sendOtp: SendOtp;
  config: {
    appBaseUrl: string;
    webAppUrl: string;
    authSecret: string;
    startingCash: string;
    secureCookies: boolean;
  };
}

const STATE_COOKIE = "oauth_state";

// Login flow:
//   GET  /auth/:provider/login     -> redirect to provider (state + PKCE)
//   GET  /auth/:provider/callback  -> user found/created, OTP emailed, pending session cookie,
//                                     redirect to WEB_APP_URL/verify-otp (or /login?error=...)
//   POST /auth/otp/verify {code}   -> pending session swapped for a full one
// Errors are { error: "CODE" }; the frontend switches on the code.
export const authRoutes =
  ({ db, redis, providers, sendOtp, config }: AuthDeps): FastifyPluginAsync =>
  async (app) => {
    const providerParam = {
      type: "object",
      required: ["provider"],
      properties: { provider: { type: "string", enum: ["google", "github"] } },
    } as const;
    const callbackUrl = (p: ProviderName) => `${config.appBaseUrl}/auth/${p}/callback`;

    const issueOtp = async (userId: string, email: string, log: FastifyBaseLogger) => {
      const { challengeId, code } = await createOtpChallenge(redis, config.authSecret, userId);
      await takeResendSlot(redis, userId); // starts the resend cooldown
      try {
        await sendOtp(email, code, log);
      } catch (err) {
        log.error({ err, userId }, "failed to send OTP"); // user can hit resend; don't fail the login
      }
      return challengeId;
    };

    app.get("/auth/providers", async () => ({ providers: Object.keys(providers) }));

    app.get<{ Params: { provider: ProviderName } }>(
      "/auth/:provider/login",
      { schema: { params: providerParam } },
      async (req, reply) => {
        const provider = providers[req.params.provider];
        if (!provider) return reply.code(404).send({ error: "PROVIDER_DISABLED" });

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
        const otpChallengeId = await issueOtp(user.id, user.email, req.log);
        const sid = await createSession(redis, { userId: user.id, role: user.role, otpVerified: false, otpChallengeId });
        setSessionCookie(reply, sid, config.secureCookies, RedisTtlSeconds.pendingSession);
        return reply.redirect(`${config.webAppUrl}/verify-otp`);
      },
    );

    app.post<{ Body: { code: string } }>(
      "/auth/otp/verify",
      {
        schema: {
          body: { type: "object", required: ["code"], properties: { code: { type: "string", maxLength: 6 } } },
        },
      },
      async (req, reply) => {
        const sid = req.cookies[SESSION_COOKIE];
        const session = await getSession(redis, sid);
        if (!session || !sid) return reply.code(401).send({ error: "UNAUTHENTICATED" });
        if (session.otpVerified) return { status: "authenticated" };
        if (!session.otpChallengeId) return reply.code(400).send({ error: "OTP_EXPIRED" });

        const result = await verifyOtp(redis, config.authSecret, session.otpChallengeId, session.userId, req.body.code);
        if (result === "invalid") return reply.code(400).send({ error: "OTP_INVALID" });
        if (result !== "ok") {
          const { otpChallengeId: _, ...rest } = session;
          await updateSession(redis, sid, rest); // challenge is gone; user must resend
          return reply.code(400).send({ error: result === "locked" ? "OTP_LOCKED" : "OTP_EXPIRED" });
        }

        // New id on privilege change (session fixation defence).
        await deleteSession(redis, sid);
        const fullSid = await createSession(redis, { userId: session.userId, role: session.role, otpVerified: true });
        setSessionCookie(reply, fullSid, config.secureCookies, RedisTtlSeconds.session);
        return { status: "authenticated" };
      },
    );

    app.post("/auth/otp/resend", async (req, reply) => {
      const sid = req.cookies[SESSION_COOKIE];
      const session = await getSession(redis, sid);
      if (!session || !sid) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      if (session.otpVerified) return reply.code(409).send({ error: "ALREADY_VERIFIED" });
      if (!(await takeResendSlot(redis, session.userId))) {
        return reply.code(429).send({ error: "OTP_COOLDOWN", retryAfterSeconds: RedisTtlSeconds.otpResendCooldown });
      }
      const profile = await getProfile(db, redis, session.userId);
      if (!profile) return reply.code(401).send({ error: "UNAUTHENTICATED" });

      await deleteOtpChallenge(redis, session.otpChallengeId);
      const { challengeId, code } = await createOtpChallenge(redis, config.authSecret, session.userId);
      await updateSession(redis, sid, { ...session, otpChallengeId: challengeId });
      await sendOtp(profile.email, code, req.log);
      return reply.code(204).send();
    });

    app.post("/auth/logout", async (req, reply) => {
      const sid = req.cookies[SESSION_COOKIE];
      const session = await getSession(redis, sid);
      await Promise.all([deleteSession(redis, sid), deleteOtpChallenge(redis, session?.otpChallengeId)]);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get("/me", { preHandler: requireAuth(redis) }, async (req, reply) => {
      const profile = await getProfile(db, redis, req.user!.userId);
      if (!profile) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return profile;
    });
  };
