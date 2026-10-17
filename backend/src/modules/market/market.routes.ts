import type { FastifyPluginAsync } from "fastify";
import { sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { lastPrices } from "../orders/orders.service.js";
import type { OrdersDeps } from "../orders/orders.routes.js";

// Public market data. The frontend shows the phase + countdown from /market/session and the
// market table from /market/instruments (live prices then arrive over /ws).
//   GET /market/session      -> {tradingDay, phase, phaseStartsAt, phaseEndsAt, serverTime, secondsLeft, engine?}
//                               engine: "running" | "stopped" (is a worker running matching + bots?), when db/redis are given
//   GET /market/instruments  -> {instruments: [{symbol, name, lastPrice, prevClose, changePct}]}  (needs db/redis)
export const marketRoutes =
  (deps?: OrdersDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/market/session", async () => {
      const now = new Date();
      const s = sessionAt(now);
      const engine = deps && ((await deps.redis.exists(RedisKeys.workerLock)) ? "running" : "stopped");
      return { ...s, serverTime: now, secondsLeft: Math.ceil((s.phaseEndsAt.getTime() - now.getTime()) / 1000), ...(engine && { engine }) };
    });

    if (!deps) return;
    const { db, redis } = deps;
    app.get("/market/instruments", async () => {
      const instruments = await db.instrument.findMany({ where: { isActive: true }, orderBy: { symbol: "asc" } });
      const bars = await db.dailyBar.findMany({
        where: { symbol: { in: instruments.map((i) => i.symbol) }, tradingDay: { lt: sessionAt().tradingDay } },
        orderBy: [{ symbol: "asc" }, { tradingDay: "desc" }],
        distinct: ["symbol"],
      });
      const prevCloses = new Map(bars.map((b) => [b.symbol, b.close]));
      const prices = await lastPrices(db, redis, instruments);
      return {
        instruments: instruments.map((i) => {
          const last = prices.get(i.symbol)!;
          const prev = prevCloses.get(i.symbol) ?? i.initialPrice;
          return {
            symbol: i.symbol,
            name: i.name,
            lastPrice: last.toFixed(4),
            prevClose: prev.toFixed(4),
            changePct: prev.isZero() ? "0.00" : last.sub(prev).div(prev).mul(100).toFixed(2),
          };
        }),
      };
    });
  };
