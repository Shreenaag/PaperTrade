import { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import type { Payload } from "../../shared/events.js";
import { sessionAt } from "../../shared/marketClock.js";
import { RedisKeys } from "../../shared/redisKeys.js";
import { cancelOrder, OrderError, placeOrder } from "../orders/orders.service.js";
import { BotKinds, decide, type BotKind } from "./strategies.js";

// Dummy traders (P3c). One User (isBot) per kind per instrument, created on worker start. They trade through
// placeOrder/cancelOrder exactly like players (same checks, reservations, outbox, matching, settlement);
// only the per-user rate limits are skipped. Each tick every bot acts with probability 1/ACT_EVERY_TICKS.
// Every PRE_OPEN, cash and shares are topped back up to the starting amounts, so bots never run dry.

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

export async function startBots(db: Db, redis: Redis, tickMs = 1000, rand: () => number = Math.random): Promise<() => Promise<void>> {
  const bots = await ensureBots(db);
  const cancelling = new Set<string>(); // cancel sent, engine hasn't answered yet: don't send it again

  const tick = async () => {
    const { tradingDay, phase } = sessionAt();
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
        if (mine.some((o) => o.tradingDay < tradingDay)) continue; // yesterday's orders still settling; retry next tick
        await topUp(db, bot);
        bot.toppedDay = tradingDay;
      }
      if (rand() * ACT_EVERY_TICKS >= 1 || !fair[bot.symbol]) continue;

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
