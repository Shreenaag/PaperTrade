import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "./app.js";

const webRoot = mkdtempSync(join(tmpdir(), "papertrade-ui-"));
writeFileSync(join(webRoot, "index.html"), "<p>ui</p>");

test("serves the UI for browser navigation; API misses stay JSON", async () => {
  const app = buildApp({ logLevel: "silent", checks: {}, webRoot });
  const page = await app.inject({ url: "/ranking", headers: { accept: "text/html,application/xhtml+xml" } });
  assert.deepEqual([page.statusCode, page.body], [200, "<p>ui</p>"]);

  const miss = await app.inject({ url: "/nope", headers: { accept: "application/json" } });
  assert.deepEqual([miss.statusCode, miss.json()], [404, { error: "NOT_FOUND" }]);

  const health = await app.inject({ url: "/health/live", headers: { accept: "text/html" } });
  assert.deepEqual(health.json(), { status: "ok" }, "real routes win over the UI fallback");
  await app.close();
});

test("without a web root, unknown paths are plain 404s", async () => {
  const app = buildApp({ logLevel: "silent", checks: {} });
  assert.equal((await app.inject({ url: "/ranking", headers: { accept: "text/html" } })).statusCode, 404);
  await app.close();
});
