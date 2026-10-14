import { z } from "zod";

// Validated once at startup: a bad/missing variable crashes immediately with a clear message
// instead of failing later inside a request. Add new variables here (e.g. OAuth secrets in P1).
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  KAFKA_BROKERS: z.string().min(1).transform((s) => s.split(",").map((b) => b.trim())),
  KAFKA_CLIENT_ID: z.string().default("papertrade"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
