import type { FastifyPluginAsync } from "fastify";
import { sessionAt } from "../../shared/marketClock.js";

// Public market status. The frontend shows the phase + countdown from this (and later from WebSockets).
export const marketRoutes = (): FastifyPluginAsync => async (app) => {
  app.get("/market/session", async () => {
    const now = new Date();
    const s = sessionAt(now);
    return { ...s, serverTime: now, secondsLeft: Math.ceil((s.phaseEndsAt.getTime() - now.getTime()) / 1000) };
  });
};
