import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../../app.js";

test("ready is 200 when every dependency is up", async () => {
  const app = buildApp({ logLevel: "silent", checks: { a: async () => 1, b: async () => 1 } });
  const res = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", deps: { a: "up", b: "up" } });
});

test("ready is 503 and names the failing dependency", async () => {
  const app = buildApp({
    logLevel: "silent",
    checks: { a: async () => 1, b: async () => { throw new Error("boom"); } },
  });
  const res = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json().deps, { a: "up", b: "down: boom" });
});

test("live is always 200", async () => {
  const app = buildApp({ logLevel: "silent", checks: {} });
  const res = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(res.statusCode, 200);
});
