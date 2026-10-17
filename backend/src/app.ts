import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes, type AuthDeps } from "./modules/auth/auth.routes.js";
import { healthRoutes, type HealthChecks } from "./modules/health/health.routes.js";
import { leaderboardRoutes } from "./modules/leaderboard/leaderboard.routes.js";
import { liveRoutes, type LiveDeps } from "./modules/live/live.routes.js";
import { marketRoutes } from "./modules/market/market.routes.js";
import { ordersRoutes, type OrdersDeps } from "./modules/orders/orders.routes.js";
import { portfolioRoutes } from "./modules/portfolio/portfolio.routes.js";

export interface AppOptions {
  logLevel?: string;
  prettyLogs?: boolean;
  checks: HealthChecks;
  auth?: AuthDeps; // omitted in tests that don't need auth
  orders?: OrdersDeps;
  live?: LiveDeps; // /ws; the Kafka feed that fills the hub is started by server.ts
  webRoot?: string; // built frontend (frontend/dist): served same-origin, so the session cookie just works
}

// Pure factory: no connections opened here, so tests can build the app with fake checks.
// Each feature module (auth, market, orders, portfolio, leaderboard, live) registers its routes below.
// Protected routes use `preHandler: requireAuth(redis)` from modules/auth/session.ts.
export function buildApp({ logLevel = "info", prettyLogs = false, checks, auth, orders, live, webRoot }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: logLevel,
      ...(prettyLogs && { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } }),
    },
  });

  app.register(cookie);
  app.decorateRequest("user", null);

  app.register(healthRoutes(checks));
  app.register(marketRoutes(orders)); // /market/instruments needs db/redis; /market/session doesn't
  if (auth) app.register(authRoutes(auth));
  if (live) {
    app.register(websocket);
    app.register(liveRoutes(live));
  }
  if (orders) {
    app.register(ordersRoutes(orders));
    app.register(portfolioRoutes(orders)); // same {db, redis} deps
    app.register(leaderboardRoutes(orders));
  }
  if (webRoot) {
    app.register(fastifyStatic, { root: webRoot, wildcard: false });
    // Page paths (/ranking, /profile, ...) belong to the single-page app; anything else that misses stays a JSON 404.
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && req.headers.accept?.includes("text/html")
        ? reply.sendFile("index.html")
        : reply.code(404).send({ error: "NOT_FOUND" }),
    );
  }

  return app;
}
