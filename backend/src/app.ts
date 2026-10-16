import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes, type AuthDeps } from "./modules/auth/auth.routes.js";
import { healthRoutes, type HealthChecks } from "./modules/health/health.routes.js";
import { marketRoutes } from "./modules/market/market.routes.js";
import { ordersRoutes, type OrdersDeps } from "./modules/orders/orders.routes.js";

export interface AppOptions {
  logLevel?: string;
  prettyLogs?: boolean;
  checks: HealthChecks;
  auth?: AuthDeps; // omitted in tests that don't need auth
  orders?: OrdersDeps;
}

// Pure factory: no connections opened here, so tests can build the app with fake checks.
// Each feature module (auth, market, orders, portfolio) registers its routes below.
// Protected routes use `preHandler: requireAuth(redis)` from modules/auth/session.ts.
export function buildApp({ logLevel = "info", prettyLogs = false, checks, auth, orders }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: logLevel,
      ...(prettyLogs && { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } }),
    },
  });

  app.register(cookie);
  app.decorateRequest("user", null);

  app.register(healthRoutes(checks));
  app.register(marketRoutes());
  if (auth) app.register(authRoutes(auth));
  if (orders) app.register(ordersRoutes(orders));

  return app;
}
