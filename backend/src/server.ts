import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb } from "./infra/db.js";
import { createKafka, createProducer, ensureTopics } from "./infra/kafka.js";
import { createRedis } from "./infra/redis.js";
import { createOtpSender } from "./modules/auth/mailer.js";
import { createProviders } from "./modules/auth/oauth.js";

const env = loadEnv();

const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const kafka = createKafka(env.KAFKA_BROKERS, env.KAFKA_CLIENT_ID);
const producer = createProducer(kafka);
const providers = createProviders(env);

let kafkaUp = false;
producer.on(producer.events.CONNECT, () => (kafkaUp = true));
producer.on(producer.events.DISCONNECT, () => (kafkaUp = false));

const app = buildApp({
  logLevel: env.LOG_LEVEL,
  prettyLogs: env.NODE_ENV === "development",
  checks: {
    postgres: () => db.$queryRaw`SELECT 1`,
    redis: () => redis.ping(),
    kafka: async () => {
      if (!kafkaUp) throw new Error("producer disconnected");
    },
  },
  auth: {
    db,
    redis,
    providers,
    sendOtp: createOtpSender(env.SMTP_URL, env.MAIL_FROM),
    config: {
      appBaseUrl: env.APP_BASE_URL,
      webAppUrl: env.WEB_APP_URL,
      authSecret: env.AUTH_SECRET,
      startingCash: env.STARTING_CASH,
      secureCookies: env.APP_BASE_URL.startsWith("https://"),
    },
  },
});

// Fail fast: refuse to serve traffic until every dependency is reachable.
await Promise.all([db.$connect(), redis.connect()]);
await ensureTopics(kafka);
await producer.connect();
await app.listen({ host: env.HOST, port: env.PORT });
app.log.info({ oauthProviders: Object.keys(providers) }, "auth ready");

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close(); // stop accepting requests, finish in-flight ones
  await Promise.allSettled([producer.disconnect(), redis.quit(), db.$disconnect()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
