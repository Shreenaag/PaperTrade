import { z } from "zod";

// Validated once at startup: a bad/missing variable crashes immediately with a clear message
// instead of failing later inside a request. Add new variables here.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  KAFKA_BROKERS: z.string().min(1).transform((s) => s.split(",").map((b) => b.trim())),
  KAFKA_CLIENT_ID: z.string().default("papertrade"),

  // --- Auth (P1) ---
  APP_BASE_URL: z.url().default("http://localhost:3000"), // public URL of this API; OAuth callbacks hang off it
  WEB_APP_URL: z.url().default("http://localhost:3000"), // where the browser lands after OAuth (frontend in P5)
  AUTH_SECRET: z.string().min(32), // HMAC key for OTP hashes
  STARTING_CASH: z.string().regex(/^\d+(\.\d{1,4})?$/).default("1000000"), // paper INR granted on sign-up
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  SMTP_URL: z.url().optional(), // e.g. smtps://user:app-password@smtp.gmail.com:465; unset = OTPs go to the log
  MAIL_FROM: z.string().default("PaperTrade <no-reply@papertrade.local>"),
})
  .refine((e) => !e.GOOGLE_CLIENT_ID === !e.GOOGLE_CLIENT_SECRET, "set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither")
  .refine((e) => !e.GITHUB_CLIENT_ID === !e.GITHUB_CLIENT_SECRET, "set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither")
  .refine((e) => e.NODE_ENV !== "production" || e.SMTP_URL, "SMTP_URL is required in production (OTPs must not be logged)");

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // `FOO=` in .env means "not set", so optional/defaulted variables behave as if absent.
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
