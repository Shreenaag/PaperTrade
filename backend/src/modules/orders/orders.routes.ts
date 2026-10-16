import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import { requireAuth } from "../auth/session.js";
import { cancelOrder, listOrders, OrderError, placeOrder, type PlaceOrderInput } from "./orders.service.js";

export interface OrdersDeps {
  db: Db;
  redis: Redis;
}

//   POST   /orders      {symbol, side, type, quantity, limitPrice?, clientOrderId?} -> 201 order (OPEN, funds reserved)
//   GET    /orders?open=true                                                      -> latest 50
//   DELETE /orders/:id                                                            -> 202, the engine decides
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
        try {
          const order = await placeOrder(db, redis, { userId: req.user!.userId, isBot: false }, req.body);
          return reply.code(201).send(order);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    app.get<{ Querystring: { open?: boolean } }>(
      "/orders",
      { schema: { querystring: { type: "object", properties: { open: { type: "boolean" } } } } },
      async (req) => ({ orders: await listOrders(db, req.user!.userId, req.query.open ?? false) }),
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
