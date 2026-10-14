import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes, type HealthChecks } from "./modules/health/health.routes.js";

export interface AppOptions {
  logLevel?: string;
  prettyLogs?: boolean;
  checks: HealthChecks;
}

// Pure factory: no connections opened here, so tests can build the app with fake checks.
// Each feature module (auth, market, orders, portfolio) registers its routes below.
export function buildApp({ logLevel = "info", prettyLogs = false, checks }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: logLevel,
      ...(prettyLogs && { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } }),
    },
  });

  app.register(healthRoutes(checks));

  return app;
}
