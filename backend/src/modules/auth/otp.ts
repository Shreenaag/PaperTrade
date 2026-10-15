import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Redis } from "../../infra/redis.js";
import { RedisKeys, RedisTtlSeconds } from "../../shared/redisKeys.js";

// 6-digit email OTP. Only an HMAC of the code is stored, so a Redis dump does not reveal live codes.
export const OTP_MAX_ATTEMPTS = 5;

export type OtpResult = "ok" | "invalid" | "expired" | "locked";

const hash = (secret: string, challengeId: string, code: string) =>
  createHmac("sha256", secret).update(`${challengeId}:${code}`).digest();

export async function createOtpChallenge(
  redis: Redis,
  secret: string,
  userId: string,
): Promise<{ challengeId: string; code: string }> {
  const challengeId = randomBytes(16).toString("base64url");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const key = RedisKeys.otpChallenge(challengeId);
  await redis
    .multi()
    .hset(key, { userId, codeHash: hash(secret, challengeId, code).toString("hex"), attempts: 0 })
    .expire(key, RedisTtlSeconds.otpChallenge)
    .exec();
  return { challengeId, code };
}

export async function verifyOtp(
  redis: Redis,
  secret: string,
  challengeId: string,
  userId: string,
  code: string,
): Promise<OtpResult> {
  const key = RedisKeys.otpChallenge(challengeId);
  // Count the attempt before checking it, atomically, so parallel guesses cannot beat the limit.
  const [[, attempts], [, c]] = (await redis.multi().hincrby(key, "attempts", 1).hgetall(key).exec()) as [
    [unknown, number],
    [unknown, Record<string, string>],
  ];
  if (!c["codeHash"] || c["userId"] !== userId) {
    await redis.del(key); // HINCRBY on an expired key recreated it without a TTL
    return "expired";
  }
  if (attempts > OTP_MAX_ATTEMPTS) {
    await redis.del(key);
    return "locked";
  }
  if (!/^\d{6}$/.test(code) || !timingSafeEqual(hash(secret, challengeId, code), Buffer.from(c["codeHash"], "hex"))) {
    return attempts === OTP_MAX_ATTEMPTS ? (await redis.del(key), "locked") : "invalid";
  }
  // DEL returns 1 for exactly one caller, so a code can be used once even under a race.
  return (await redis.del(key)) === 1 ? "ok" : "expired";
}

export async function deleteOtpChallenge(redis: Redis, challengeId: string | undefined): Promise<void> {
  if (challengeId) await redis.del(RedisKeys.otpChallenge(challengeId));
}

// true if the user may get another code now (SET NX = atomic cooldown).
export async function takeResendSlot(redis: Redis, userId: string): Promise<boolean> {
  const ok = await redis.set(RedisKeys.rateLimit("otp-resend", userId), "1", "EX", RedisTtlSeconds.otpResendCooldown, "NX");
  return ok === "OK";
}
