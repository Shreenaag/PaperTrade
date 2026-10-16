import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../auth/session.js";
import type { OrdersDeps } from "../orders/orders.routes.js";
import { getPortfolio } from "./portfolio.service.js";

//   GET /portfolio -> 200 {cash, reservedCash, availableCash, holdings[], totals} | 404 NO_ACCOUNT
export const portfolioRoutes =
  ({ db, redis }: OrdersDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", requireAuth(redis));

    app.get("/portfolio", async (req, reply) => {
      const portfolio = await getPortfolio(db, redis, req.user!.userId);
      return portfolio ?? reply.code(404).send({ error: "NO_ACCOUNT" });
    });
  };
