import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import { requireAuth } from "../auth/session.js";
import { cancelOrder, listOrders, listTrades, modifyOrder, OrderError, placeOrder, type Page, type PlaceOrderInput } from "./orders.service.js";

const pageQuery = {
  before: { type: "string", format: "uuid" },
  limit: { type: "integer", minimum: 1, maximum: 100 },
} as const;

export interface OrdersDeps {
  db: Db;
  redis: Redis;
}

//   POST   /orders      {symbol, side, type, quantity, limitPrice?, clientOrderId?} -> 201 order (OPEN, funds reserved)
//                        403 PROFILE_INCOMPLETE until PUT /me/profile
//   GET    /orders?open=true&before=<orderId>&limit=50                            -> newest first, limit ≤ 100
//   GET    /trades?symbol=&before=<tradeId>&limit=50                              -> your fills, newest first
//   DELETE /orders/:id                                                            -> 202, the engine decides
//   POST   /orders/:id/modify {quantity, limitPrice, clientOrderId?}              -> 201 replacement order (LIMIT only);
//                        the engine cancels the old one, or rejects the new one (ORDER_CHANGED) if the old one filled first
export const ordersRoutes =
  ({ db, redis }: OrdersDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", requireAuth(redis));

    const fail = (reply: FastifyReply, err: unknown) => {
      if (err instanceof OrderError) return reply.code(err.status).send({ error: err.code });
      throw err;
    };

    app.post<{ Body: PlaceOrderInput }>(
      "/orders",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["symbol", "side", "type", "quantity"],
            properties: {
              symbol: { type: "string", maxLength: 16 },
              side: { enum: ["BUY", "SELL"] },
              type: { enum: ["MARKET", "LIMIT"] },
              quantity: { type: "integer", minimum: 1 },
              limitPrice: { type: "string", pattern: "^\\d{1,12}(\\.\\d{1,4})?$" },
              clientOrderId: { type: "string", minLength: 1, maxLength: 64 },
            },
          },
        },
      },
      async (req, reply) => {
        const user = await db.user.findUnique({ where: { id: req.user!.userId }, select: { profileCompletedAt: true } });
        if (!user?.profileCompletedAt) return reply.code(403).send({ error: "PROFILE_INCOMPLETE" }); // P5: profile first
        try {
          const order = await placeOrder(db, redis, { userId: req.user!.userId, isBot: false }, req.body);
          return reply.code(201).send(order);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    app.get<{ Querystring: Page & { open?: boolean } }>(
      "/orders",
      { schema: { querystring: { type: "object", properties: { open: { type: "boolean" }, ...pageQuery } } } },
      async (req) => {
        const { open = false, ...page } = req.query;
        return { orders: await listOrders(db, req.user!.userId, open, page) };
      },
    );

    app.get<{ Querystring: Page & { symbol?: string } }>(
      "/trades",
      { schema: { querystring: { type: "object", properties: { symbol: { type: "string", maxLength: 16 }, ...pageQuery } } } },
      async (req) => ({ trades: await listTrades(db, req.user!.userId, req.query) }),
    );

    app.post<{ Params: { id: string }; Body: { quantity: number; limitPrice: string; clientOrderId?: string } }>(
      "/orders/:id/modify",
      {
        schema: {
          params: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
          body: {
            type: "object",
            additionalProperties: false,
            required: ["quantity", "limitPrice"],
            properties: {
              quantity: { type: "integer", minimum: 1 },
              limitPrice: { type: "string", pattern: "^\\d{1,12}(\\.\\d{1,4})?$" },
              clientOrderId: { type: "string", minLength: 1, maxLength: 64 },
            },
          },
        },
      },
      async (req, reply) => {
        try {
          return reply.code(201).send(await modifyOrder(db, redis, req.user!.userId, req.params.id, req.body));
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    app.delete<{ Params: { id: string } }>(
      "/orders/:id",
      { schema: { params: { type: "object", properties: { id: { type: "string", format: "uuid" } } } } },
      async (req, reply) => {
        try {
          await cancelOrder(db, req.user!.userId, req.params.id);
          return reply.code(202).send({ status: "CANCEL_REQUESTED" });
        } catch (err) {
          return fail(reply, err);
        }
      },
    );
  };
