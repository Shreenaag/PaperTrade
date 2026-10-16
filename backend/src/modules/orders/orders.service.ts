import { Prisma, type Order, type OrderSide, type OrderType, type Trade } from "../../generated/prisma/client.js";
import type { Db } from "../../infra/db.js";
import { countHit, type Redis } from "../../infra/redis.js";
import { makeEvent, type Payload } from "../../shared/events.js";
import { FEE_RATE, MARKET_PROTECTION, OrderLimits } from "../../shared/limits.js";
import { DAY_SECONDS, sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";

// Placing and cancelling orders. Used by the HTTP API (players) and directly by the bot worker (P3c),
// so both go through the same checks, reservations and outbox -> orders.commands.v1.

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export class OrderError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

export interface Trader {
  userId: string;
  isBot: boolean;
}

export interface PlaceOrderInput {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice?: string;
  clientOrderId?: string;
}

const OPEN_STATUSES = ["OPEN", "PARTIALLY_FILLED"] as const;

export async function placeOrder(db: Db, redis: Redis, trader: Trader, input: PlaceOrderInput, now = new Date()): Promise<Order> {
  const { userId } = trader;
  const { symbol, side, type, quantity, clientOrderId } = input;
  const { tradingDay } = sessionAt(now);

  if (clientOrderId) {
    const existing = await db.order.findUnique({ where: { userId_clientOrderId: { userId, clientOrderId } } });
    if (existing) return existing; // double-click / retry
  }

  const instrument = await db.instrument.findUnique({ where: { symbol } });
  if (!instrument?.isActive) throw new OrderError("UNKNOWN_SYMBOL");
  if (quantity > OrderLimits.maxQuantity) throw new OrderError("QUANTITY_TOO_LARGE");
  if (quantity % instrument.lotSize !== 0) throw new OrderError("BAD_LOT_SIZE");
  if ((type === "LIMIT") !== (input.limitPrice !== undefined)) throw new OrderError("BAD_LIMIT_PRICE");

  const { prevClose, last } = await referencePrices(db, redis, symbol, tradingDay, instrument.initialPrice);
  const tick = instrument.tickSize;
  let limitPrice: Decimal | null = null;
  let protectionPrice: Decimal | null = null;
  if (type === "LIMIT") {
    limitPrice = new Decimal(input.limitPrice!);
    if (limitPrice.lte(0) || !limitPrice.mod(tick).isZero()) throw new OrderError("BAD_TICK_SIZE");
    const band = prevClose.mul(OrderLimits.priceBand);
    if (limitPrice.lt(prevClose.sub(band)) || limitPrice.gt(prevClose.add(band))) throw new OrderError("PRICE_OUT_OF_BAND");
  } else {
    const away = last.mul(MARKET_PROTECTION);
    protectionPrice =
      side === "BUY"
        ? last.add(away).div(tick).floor().mul(tick)
        : Decimal.max(tick, last.sub(away).div(tick).ceil().mul(tick));
  }
  const worstPrice = (limitPrice ?? protectionPrice)!;
  if (worstPrice.mul(quantity).gt(OrderLimits.maxValue)) throw new OrderError("ORDER_VALUE_TOO_LARGE");
  // BUY holds the most it can cost; FILL releases a share of it (settlement).
  const reserve = side === "BUY" ? worstPrice.mul(quantity).mul(new Decimal(1).add(FEE_RATE)).toDecimalPlaces(4, Decimal.ROUND_UP) : new Decimal(0);

  if (!trader.isBot) await checkTraderLimits(db, redis, userId, tradingDay);

  try {
    return await db.$transaction(async (tx) => {
      const held =
        side === "BUY"
          ? await tx.$executeRaw`UPDATE accounts SET "reservedCash" = "reservedCash" + ${reserve.toFixed(4)}::numeric, "updatedAt" = now()
              WHERE "userId" = ${userId}::uuid AND cash - "reservedCash" >= ${reserve.toFixed(4)}::numeric`
          : await tx.$executeRaw`UPDATE holdings SET "reservedQuantity" = "reservedQuantity" + ${quantity}, "updatedAt" = now()
              WHERE "userId" = ${userId}::uuid AND symbol = ${symbol} AND quantity - "reservedQuantity" >= ${quantity}`;
      if (held !== 1) throw new OrderError(side === "BUY" ? "INSUFFICIENT_CASH" : "INSUFFICIENT_SHARES");

      const order = await tx.order.create({
        data: { userId, symbol, side, type, quantity, limitPrice, reservedCash: reserve, clientOrderId, status: "OPEN", tradingDay },
      });
      await enqueueCommand(tx, symbol, {
        kind: "PLACE",
        orderId: order.id,
        userId,
        symbol,
        side,
        type,
        quantity,
        limitPrice: limitPrice?.toFixed(4) ?? null,
        protectionPrice: protectionPrice?.toFixed(4) ?? null,
        tradingDay,
      });
      return order;
    });
  } catch (err) {
    // Same clientOrderId raced in from two requests: the loser returns the winner's order.
    if (clientOrderId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return db.order.findUniqueOrThrow({ where: { userId_clientOrderId: { userId, clientOrderId } } });
    }
    throw err;
  }
}

// The engine decides whether the cancel wins (the order may fill first); settlement applies the result.
export async function cancelOrder(db: Db, userId: string, orderId: string): Promise<void> {
  const order = await db.order.findFirst({ where: { id: orderId, userId } });
  if (!order) throw new OrderError("ORDER_NOT_FOUND", 404);
  if (!(OPEN_STATUSES as readonly string[]).includes(order.status)) throw new OrderError("ORDER_CLOSED", 409);
  await enqueueCommand(db, order.symbol, { kind: "CANCEL", orderId, userId, symbol: order.symbol });
}

export interface Page {
  before?: string; // id of the last row of the previous page
  limit?: number;
}
const pageSize = (limit = 50) => Math.min(limit, 100);

// Keyset paging, newest first. The cursor row is looked up within the user's own rows,
// so a foreign or unknown id gives an empty page instead of leaking another user's neighbours.
export async function listOrders(db: Db, userId: string, openOnly: boolean, { before, limit }: Page = {}): Promise<Order[]> {
  const cursor = before ? await db.order.findFirst({ where: { id: before, userId } }) : null;
  if (before && !cursor) return [];
  return db.order.findMany({
    where: {
      userId,
      ...(openOnly && { status: { in: [...OPEN_STATUSES] } }),
      ...(cursor && { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pageSize(limit),
  });
}

export async function listTrades(db: Db, userId: string, { before, limit, symbol }: Page & { symbol?: string } = {}): Promise<Trade[]> {
  const cursor = before ? await db.trade.findFirst({ where: { id: before, userId } }) : null;
  if (before && !cursor) return [];
  return db.trade.findMany({
    where: {
      userId,
      ...(symbol && { symbol }),
      ...(cursor && { OR: [{ executedAt: { lt: cursor.executedAt } }, { executedAt: cursor.executedAt, id: { lt: cursor.id } }] }),
    },
    orderBy: [{ executedAt: "desc" }, { id: "desc" }],
    take: pageSize(limit),
  });
}

// Price to value a position at: last traded price (Redis, written by the matcher), else the latest daily close,
// else the instrument's initial price. One HGETALL plus at most one query for the symbols with no tick.
export async function lastPrices(db: Db, redis: Redis, instruments: { symbol: string; initialPrice: Decimal }[]): Promise<Map<string, Decimal>> {
  const ticks = await redis.hgetall(RedisKeys.prices);
  const prices = new Map<string, Decimal>();
  for (const { symbol } of instruments) {
    const tick = ticks[symbol];
    if (tick) prices.set(symbol, new Decimal((JSON.parse(tick) as Payload<"prices">).price));
  }
  const misses = instruments.filter((i) => !prices.has(i.symbol));
  if (misses.length) {
    const bars = await db.dailyBar.findMany({
      where: { symbol: { in: misses.map((i) => i.symbol) } },
      orderBy: [{ symbol: "asc" }, { tradingDay: "desc" }],
      distinct: ["symbol"],
    });
    const closes = new Map(bars.map((b) => [b.symbol, b.close]));
    for (const i of misses) prices.set(i.symbol, closes.get(i.symbol) ?? i.initialPrice);
  }
  return prices;
}

// Previous close anchors the LIMIT band; last traded price (Redis, written by the matcher) anchors MARKET orders.
async function referencePrices(db: Db, redis: Redis, symbol: string, tradingDay: number, initialPrice: Decimal) {
  const bar = await db.dailyBar.findFirst({ where: { symbol, tradingDay: { lt: tradingDay } }, orderBy: { tradingDay: "desc" } });
  const prevClose = bar?.close ?? initialPrice;
  const tick = await redis.hget(RedisKeys.prices, symbol);
  const last = tick ? new Decimal((JSON.parse(tick) as Payload<"prices">).price) : prevClose;
  return { prevClose, last };
}

async function checkTraderLimits(db: Db, redis: Redis, userId: string, tradingDay: number) {
  if ((await countHit(redis, RedisKeys.rateLimit("orders-1s", userId), 1)) > OrderLimits.perSecond) {
    throw new OrderError("RATE_LIMITED", 429);
  }
  if ((await countHit(redis, RedisKeys.rateLimit(`orders-day${tradingDay}`, userId), DAY_SECONDS)) > OrderLimits.perDay) {
    throw new OrderError("DAILY_ORDER_LIMIT", 429);
  }
  const open = await db.order.count({ where: { userId, status: { in: [...OPEN_STATUSES] } } });
  if (open >= OrderLimits.open) throw new OrderError("TOO_MANY_OPEN_ORDERS", 429);
}

type Tx = Pick<Db, "outboxEvent">;
async function enqueueCommand(tx: Tx, symbol: string, payload: Payload<"orderCommands">) {
  const event = makeEvent("orderCommands", payload);
  await tx.outboxEvent.create({ data: { id: event.id, topic: event.topic, key: symbol, payload: event as object } });
}
