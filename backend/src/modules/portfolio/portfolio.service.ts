import { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../../infra/db.js";
import type { Redis } from "../../infra/redis.js";
import { lastPrices } from "../orders/orders.service.js";

// Live portfolio of one user, read-only: settlement already keeps avgCost (fees included) and realizedPnl,
// so P&L here is just "value at last price" arithmetic. Money as 4-dp strings, percentages as 2-dp strings.

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

const money = (d: Decimal) => d.toFixed(4);
const pct = (part: Decimal, whole: Decimal) => (whole.isZero() ? "0.00" : part.div(whole).mul(100).toFixed(2));

export type Portfolio = NonNullable<Awaited<ReturnType<typeof getPortfolio>>>;

export async function getPortfolio(db: Db, redis: Redis, userId: string) {
  // One snapshot: a fill settling between separate reads would show cash debited but shares not yet added.
  const [account, rows, grant] = await db.$transaction(
    [
      db.account.findUnique({ where: { userId } }),
      db.holding.findMany({ where: { userId }, include: { instrument: { select: { initialPrice: true } } }, orderBy: { symbol: "asc" } }),
      db.ledgerEntry.aggregate({ _sum: { amount: true }, where: { userId, type: "INITIAL_GRANT" } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (!account) return null;

  const open = rows.filter((h) => h.quantity > 0); // quantity-0 rows are closed positions: realized P&L only
  const prices = await lastPrices(db, redis, open.map((h) => ({ symbol: h.symbol, initialPrice: h.instrument.initialPrice })));

  let holdingsValue = new Decimal(0);
  let unrealized = new Decimal(0);
  const holdings = open.map((h) => {
    const price = prices.get(h.symbol)!;
    const value = price.mul(h.quantity);
    const pnl = price.sub(h.avgCost).mul(h.quantity);
    holdingsValue = holdingsValue.add(value);
    unrealized = unrealized.add(pnl);
    return {
      symbol: h.symbol,
      quantity: h.quantity,
      reservedQuantity: h.reservedQuantity,
      avgCost: money(h.avgCost),
      lastPrice: money(price),
      marketValue: money(value),
      unrealizedPnl: money(pnl),
      unrealizedPct: pct(price.sub(h.avgCost), h.avgCost),
      realizedPnl: money(h.realizedPnl),
    };
  });

  const realized = rows.reduce((sum, h) => sum.add(h.realizedPnl), new Decimal(0));
  const equity = account.cash.add(holdingsValue);
  const invested = grant._sum.amount ?? new Decimal(0); // shortcut: RESET entries ignored; nothing writes them yet
  return {
    cash: money(account.cash),
    reservedCash: money(account.reservedCash),
    availableCash: money(account.cash.sub(account.reservedCash)),
    holdings,
    totals: {
      holdingsValue: money(holdingsValue),
      equity: money(equity),
      realizedPnl: money(realized),
      unrealizedPnl: money(unrealized),
      totalPnl: money(realized.add(unrealized)),
      returnPct: pct(equity.sub(invested), invested),
      invested: money(invested), // lets the UI recompute returnPct live from price ticks
    },
  };
}
