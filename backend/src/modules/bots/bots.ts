import { Prisma, type Instrument } from "../../generated/prisma/client.js";
import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import type { Payload } from "../../shared/events.js";
import { sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { cancelOrder, OrderError, placeOrder } from "../orders/orders.service.js";
import { BotKinds, BotRules, decide, impactOf, type BotKind } from "./strategies.js";

// Dummy traders (P3c). One User (isBot) per kind per instrument, created on worker start. They trade through
// placeOrder/cancelOrder exactly like players (same checks, reservations, outbox, matching, settlement);
// only the per-user rate limits are skipped. Each tick every bot acts with probability 1/ACT_EVERY_TICKS.
// When a player places an order, its stock's fair value is nudged at once and that stock's bots act every tick,
// following the player, for BotRules.flowSeconds (the market reacts visibly to the player).
// Every PRE_OPEN, a bot cancels its quotes left from earlier days (orders carry over), then tops back up to the
// starting cash and shares, so bots never run dry.

const Decimal = Prisma.Decimal;

export const BOT_CASH = "2000000"; // ₹20,00,000 per bot
const BOT_SHARES_VALUE = 1_000_000; // plus ₹10,00,000 of its instrument at the seeded price
const ACT_EVERY_TICKS = 5; // 30 bots, 1s tick -> about 6 actions/s in total
const OPEN_STATUSES = ["OPEN", "PARTIALLY_FILLED"] as const;

export interface Bot {
  userId: string;
  kind: BotKind;
  symbol: string;
  tick: number;
  lot: number;
  shares: number; // top-up target
  initialPrice: Prisma.Decimal;
  ref: number | null; // MOMENTUM memory
  toppedDay: number;
}

export const botEmail = (kind: BotKind, symbol: string) => `bot.${kind.toLowerCase()}.${symbol.toLowerCase()}@bots.papertrade.local`;

// Re-runnable: existing bots are left as they are; a new instrument gets its bots on the next start.
export async function ensureBots(db: Db): Promise<Bot[]> {
  const instruments = await db.instrument.findMany({ where: { isActive: true } });
  const bots: Bot[] = [];
  for (const i of instruments) {
    const shares = Math.floor(BOT_SHARES_VALUE / i.initialPrice.toNumber() / i.lotSize) * i.lotSize;
    try {
      bots.push(...(await botsFor(db, i, shares)));
    } catch (err) {
      // The instrument was deleted after we listed it (the integration tests add and remove throwaway ones).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        console.warn(`bots: ${i.symbol} no longer exists, skipped`);
        continue;
      }
      throw err;
    }
  }
  return bots;
}

async function botsFor(db: Db, i: Instrument, shares: number): Promise<Bot[]> {
  const bots: Bot[] = [];
  for (const kind of BotKinds) {
    const user = await db.user.upsert({
      where: { email: botEmail(kind, i.symbol) },
      update: {},
      create: {
        email: botEmail(kind, i.symbol),
        displayName: `${kind.replace("_", " ").toLowerCase()} bot · ${i.symbol}`,
        isBot: true,
        account: { create: { cash: BOT_CASH } },
        ledger: { create: { type: "INITIAL_GRANT", amount: BOT_CASH, balanceAfter: BOT_CASH } },
        holdings: { create: { symbol: i.symbol, quantity: shares, avgCost: i.initialPrice } },
      },
    });
    bots.push({ userId: user.id, kind, symbol: i.symbol, tick: i.tickSize.toNumber(), lot: i.lotSize, shares, initialPrice: i.initialPrice, ref: null, toppedDay: -1 });
  }
  return bots;
}

// Back up to BOT_CASH and the starting shares. Only called when the bot has no orders left from earlier days,
// so no fill for it can be in flight and settlement is not writing these rows at the same time.
// shortcut: added shares keep the old avgCost, so bot P&L is meaningless; bots are left out of P4 P&L/leaderboard.
export async function topUp(db: Db, bot: Pick<Bot, "userId" | "symbol" | "shares" | "initialPrice">): Promise<void> {
  const { userId, symbol, shares } = bot;
  await db.$transaction(async (tx) => {
    const account = await tx.account.findUniqueOrThrow({ where: { userId } });
    if (account.cash.lt(BOT_CASH)) {
      await tx.account.update({ where: { userId }, data: { cash: BOT_CASH } });
      await tx.ledgerEntry.create({ data: { userId, type: "RESET", amount: new Decimal(BOT_CASH).sub(account.cash), balanceAfter: BOT_CASH } });
    }
    const held = await tx.holding.updateMany({ where: { userId, symbol, quantity: { lt: shares } }, data: { quantity: shares } });
    if (held.count === 0 && !(await tx.holding.findUnique({ where: { userId_symbol: { userId, symbol } } }))) {
      await tx.holding.create({ data: { userId, symbol, quantity: shares, avgCost: bot.initialPrice } });
    }
  });
}

// Players' orders (never bots') placed after `since`, oldest first.
export function newPlayerOrders(db: Db, since: Date) {
  return db.order.findMany({
    where: { createdAt: { gt: since }, user: { isBot: false } },
    select: { symbol: true, side: true, quantity: true, limitPrice: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

type Nudge = (symbol: string, fraction: number) => Promise<void>;

export async function startBots(db: Db, redis: Redis, nudge: Nudge, tickMs = 1000, rand: () => number = Math.random): Promise<() => Promise<void>> {
  const bots = await ensureBots(db);
  const cancelling = new Set<string>(); // cancel sent, engine hasn't answered yet: don't send it again
  const flow = new Map<string, { side: "BUY" | "SELL"; until: number }>(); // symbol -> the player's direction, while it lasts
  let since = new Date();

  const tick = async () => {
    const { tradingDay, phase } = sessionAt();
    const now = Date.now();
    for (const o of await newPlayerOrders(db, since)) {
      const quote = await redis.hget(RedisKeys.prices, o.symbol);
      const unit = o.limitPrice?.toNumber() ?? (quote ? Number((JSON.parse(quote) as Payload<"prices">).price) : 0);
      await nudge(o.symbol, impactOf(o.side, unit * o.quantity));
      flow.set(o.symbol, { side: o.side, until: now + BotRules.flowSeconds * 1000 });
      since = o.createdAt;
    }
    for (const [symbol, f] of flow) if (f.until <= now) flow.delete(symbol);

    const [fair, prices, open] = await Promise.all([
      redis.hgetall(RedisKeys.fairValue),
      redis.hgetall(RedisKeys.prices),
      db.order.findMany({
        where: { userId: { in: bots.map((b) => b.userId) }, status: { in: [...OPEN_STATUSES] } },
        select: { id: true, userId: true, side: true, limitPrice: true, tradingDay: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const stillOpen = new Set(open.map((o) => o.id));
    for (const id of cancelling) if (!stillOpen.has(id)) cancelling.delete(id);

    for (const bot of bots) {
      const mine = open.filter((o) => o.userId === bot.userId);
      if (bot.toppedDay !== tradingDay && phase === "PRE_OPEN") {
        const stale = mine.filter((o) => o.tradingDay < tradingDay);
        if (stale.length) {
          // Earlier-day quotes carried over: cancel them, top up once they are closed (no fill can then be in flight).
          for (const o of stale.filter((o) => !cancelling.has(o.id))) {
            cancelling.add(o.id);
            await quietly(cancelOrder(db, bot.userId, o.id));
          }
          continue;
        }
        await topUp(db, bot);
        bot.toppedDay = tradingDay;
      }
      const following = flow.get(bot.symbol)?.side ?? null;
      if ((!following && rand() * ACT_EVERY_TICKS >= 1) || !fair[bot.symbol]) continue;

      const quote = prices[bot.symbol];
      const fairValue = Number(fair[bot.symbol]);
      const last = quote ? Number((JSON.parse(quote) as Payload<"prices">).price) : fairValue;
      const plan = decide(
        {
          kind: bot.kind,
          symbol: bot.symbol,
          phase,
          fair: fairValue,
          last,
          ref: bot.ref,
          flow: following,
          tick: bot.tick,
          lot: bot.lot,
          open: mine.filter((o) => !cancelling.has(o.id)).map((o) => ({ id: o.id, side: o.side, limitPrice: o.limitPrice?.toFixed(4) ?? null })),
        },
        rand,
      );
      bot.ref = last;
      for (const id of plan.cancel) {
        cancelling.add(id);
        await quietly(cancelOrder(db, bot.userId, id));
      }
      for (const input of plan.place) await quietly(placeOrder(db, redis, { userId: bot.userId, isBot: true }, input));
    }
  };

  // Ticks never overlap; stop waits for the one in progress so shutdown doesn't cut a placeOrder in half.
  let current = Promise.resolve();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    current = tick()
      .catch((err) => console.error("bots: tick failed", err))
      .finally(() => (busy = false));
  }, tickMs);
  return async () => {
    clearInterval(timer);
    await current;
  };
}

// A rejected bot order (out of band, short of cash/shares, order already closed) is normal: skip it.
async function quietly(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof OrderError)) throw err;
  }
}
