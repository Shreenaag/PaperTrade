import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../auth/session.js";
import type { OrdersDeps } from "../orders/orders.routes.js";
import { getLeaderboard } from "./leaderboard.js";

//   GET /leaderboard -> {top: [{rank, displayName, handle, equity, returnPct, isMe}] (20), me: {rank, equity, returnPct} | null}
export const leaderboardRoutes =
  ({ db, redis }: OrdersDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", requireAuth(redis));
    app.get("/leaderboard", async (req) => getLeaderboard(db, redis, req.user!.userId));
  };
