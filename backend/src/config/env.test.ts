import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  KAFKA_BROKERS: "localhost:9092",
  AUTH_SECRET: "x".repeat(32),
};

test("minimal env loads with defaults; empty values count as unset", () => {
  const env = loadEnv({ ...base, SMTP_URL: "", GOOGLE_CLIENT_ID: "" });
  assert.equal(env.SMTP_URL, undefined);
  assert.equal(env.STARTING_CASH, "1000000");
});

test("half-configured OAuth provider is rejected", () => {
  assert.throws(() => loadEnv({ ...base, GITHUB_CLIENT_ID: "id" }), /GITHUB_CLIENT_SECRET/);
});

test("production refuses to log OTPs", () => {
  assert.throws(() => loadEnv({ ...base, NODE_ENV: "production" }), /SMTP_URL is required/);
});
