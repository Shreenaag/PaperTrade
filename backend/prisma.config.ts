import { defineConfig } from "prisma/config";

// Single .env lives at the repo root (shared with docker compose). Missing file is fine in containers.
try { process.loadEnvFile("../.env"); } catch {}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
