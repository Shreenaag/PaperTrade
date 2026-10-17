import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  KAFKA_BROKERS: "localhost:9092",
};

test("minimal env loads with defaults; empty values count as unset", () => {
  const env = loadEnv({ ...base, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
  assert.equal(env.GOOGLE_CLIENT_ID, undefined);
  assert.equal(env.STARTING_CASH, "1000000");
});

test("half-configured OAuth provider is rejected", () => {
  assert.throws(() => loadEnv({ ...base, GITHUB_CLIENT_ID: "id" }), /GITHUB_CLIENT_SECRET/);
});

test("old email/OTP settings left in .env are ignored, not required", () => {
  const env = loadEnv({ ...base, NODE_ENV: "production", SMTP_URL: "", AUTH_SECRET: "short" }) as Record<string, unknown>;
  assert.equal(env["SMTP_URL"], undefined);
  assert.equal(env["AUTH_SECRET"], undefined);
});
