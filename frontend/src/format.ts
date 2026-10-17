import type { Portfolio } from "./api.js";

// Indian number formatting: ₹10,00,000.00. Values arrive as decimal strings and are only formatted here.

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const inr = (v: string | number) => rupees.format(Number(v));
export const price = (v: string | number) => plain.format(Number(v));
export const signedInr = (v: string | number) => (Number(v) > 0 ? "+" : "") + inr(v);
export const pct = (v: string | number) => `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}%`;
export const direction = (v: string | number) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "flat");
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
// Time of day; earlier days also get their date, so a list spanning days still reads in order.
export const time = (iso: string) => {
  const d = new Date(iso);
  const clock = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? clock : `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}, ${clock}`;
};

// The market clock, same rule as the backend's src/shared/marketClock.ts: 6 min 20 s days.
export const PHASES = [
  { phase: "PRE_OPEN", label: "Pre-open", seconds: 30 },
  { phase: "OPEN", label: "Open", seconds: 300 },
  { phase: "POST_CLOSE", label: "Closing", seconds: 30 },
  { phase: "CLOSED", label: "Closed", seconds: 20 },
] as const;
const DAY_MS = PHASES.reduce((ms, p) => ms + p.seconds * 1000, 0);
const EPOCH_MS = Date.UTC(2026, 9, 17, 17, 0); // same epoch as the backend; see marketClock.ts

export type Clock = ReturnType<typeof clock>;

export function clock(nowMs: number) {
  const sinceDayStart = (((nowMs - EPOCH_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  const day = Math.floor((nowMs - EPOCH_MS) / DAY_MS); // changes when the backend's tradingDay does
  let start = 0;
  for (const p of PHASES) {
    const end = start + p.seconds * 1000;
    if (sinceDayStart < end) {
      const secondsLeft = Math.ceil((end - sinceDayStart) / 1000);
      return { ...p, day, dayProgress: sinceDayStart / DAY_MS, secondsLeft };
    }
    start = end;
  }
  throw new Error("unreachable");
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Re-values holdings at the latest ticked prices, so P&L and return % move with every tick instead of every 5 s poll.
// Cash, avg cost and realised P&L only change on fills, which refetch the server's portfolio.
export function reprice(p: Portfolio, prices: Record<string, string>): Portfolio {
  let value = 0;
  let unrealized = 0;
  const holdings = p.holdings.map((h) => {
    const last = Number(prices[h.symbol] ?? h.lastPrice);
    const avg = Number(h.avgCost);
    const pnl = (last - avg) * h.quantity;
    value += last * h.quantity;
    unrealized += pnl;
    return { ...h, lastPrice: String(last), marketValue: String(last * h.quantity), unrealizedPnl: String(pnl), unrealizedPct: String(avg ? ((last - avg) / avg) * 100 : 0) };
  });
  const equity = Number(p.cash) + value;
  const invested = Number(p.totals.invested);
  return {
    ...p,
    holdings,
    totals: {
      ...p.totals,
      holdingsValue: String(value),
      equity: String(equity),
      unrealizedPnl: String(unrealized),
      totalPnl: String(Number(p.totals.realizedPnl) + unrealized),
      returnPct: String(invested ? ((equity - invested) / invested) * 100 : 0),
    },
  };
}
