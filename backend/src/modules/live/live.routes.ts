import type { FastifyPluginAsync } from "fastify";
import type { Redis } from "../../infra/redis.js";
import { getSession, SESSION_COOKIE } from "../auth/session.js";
import type { LiveHub } from "./hub.js";

export interface LiveDeps {
  redis: Redis;
  hub: LiveHub;
}

//   GET /ws (WebSocket) -> server pushes {type:"price",...} to everyone and {type:"order",...} to the order's owner.
//   No session -> closed with code 4401 (same rule as requireAuth).
export const liveRoutes =
  ({ redis, hub }: LiveDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/ws", { websocket: true }, async (socket, req) => {
      const session = await getSession(redis, req.cookies[SESSION_COOKIE]);
      if (!session) return socket.close(4401, "UNAUTHENTICATED");
      hub.add(session.userId, socket);
    });
  };
