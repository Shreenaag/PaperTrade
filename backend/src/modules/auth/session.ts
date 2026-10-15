import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Role } from "../../generated/prisma/client.js";
import type { Redis } from "../../infra/redis.js";
import { RedisKeys, RedisTtlSeconds } from "../../shared/redisKeys.js";

// Opaque random session id in an httpOnly cookie; the session itself lives in Redis.
// A session starts "pending" after OAuth (otpVerified=false) and is replaced by a full one after OTP.

export interface Session {
  userId: string;
  role: Role;
  otpVerified: boolean;
  otpChallengeId?: string;
}

export type AuthUser = Pick<Session, "userId" | "role">;

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null; // set by requireAuth
  }
}

export const SESSION_COOKIE = "sid";

export async function createSession(redis: Redis, session: Session): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  const ttl = session.otpVerified ? RedisTtlSeconds.session : RedisTtlSeconds.pendingSession;
  await redis.set(RedisKeys.session(id), JSON.stringify(session), "EX", ttl);
  return id;
}

export async function getSession(redis: Redis, id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  const raw = await redis.get(RedisKeys.session(id));
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function updateSession(redis: Redis, id: string, session: Session): Promise<void> {
  await redis.set(RedisKeys.session(id), JSON.stringify(session), "KEEPTTL");
}

export async function deleteSession(redis: Redis, id: string | undefined): Promise<void> {
  if (id) await redis.del(RedisKeys.session(id));
}

export function setSessionCookie(reply: FastifyReply, id: string, secure: boolean, maxAge: number): void {
  // SameSite=Lax + JSON-only POST bodies (Fastify rejects form posts) = no CSRF from other sites.
  reply.setCookie(SESSION_COOKIE, id, { path: "/", httpOnly: true, sameSite: "lax", secure, maxAge });
}

// preHandler for any route that needs a signed-in user. 401 code tells the frontend where to send them.
export function requireAuth(redis: Redis): preHandlerAsyncHookHandler {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await getSession(redis, req.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    if (!session.otpVerified) return reply.code(401).send({ error: "OTP_REQUIRED" });
    req.user = { userId: session.userId, role: session.role };
  };
}
