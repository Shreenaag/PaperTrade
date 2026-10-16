import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createRedis, tryLock } from "./redis.js";

// Integration test: real Redis from docker compose. Skipped when it isn't running.
const redis = createRedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const skip = await redis.connect().then(() => false).catch(() => (redis.disconnect(), "redis not reachable: docker compose up -d"));
after(() => redis.disconnect());

test("only one holder; renew and release only work for the holder", { skip }, async () => {
  const key = `lock:test:${randomUUID()}`;
  const first = await tryLock(redis, key, 10);
  assert.ok(first);
  assert.equal(await tryLock(redis, key, 10), null);
  assert.equal(await first.renew(), true);

  await first.release();
  const second = await tryLock(redis, key, 10);
  assert.ok(second, "free again after release");
  await first.release(); // stale holder must not free the new holder's lock
  assert.equal(await second.renew(), true);
  assert.equal(await first.renew(), false);
  await second.release();
});
