// Thin client for the backend. Every error the API sends is { error: CODE }; the UI shows errorText(CODE).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    const code = data.code === "FST_ERR_VALIDATION" ? "INVALID_INPUT" : (data.error ?? `HTTP_${res.status}`);
    throw new ApiError(res.status, code);
  }
  return data as T;
}

const messages: Record<string, string> = {
  // sign-in
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
  PROVIDER_DISABLED: "This sign-in option is turned off.",
  oauth_denied: "Sign-in was cancelled.",
  state_mismatch: "Sign-in was started in another tab or browser. Try again here.",
  state_expired: "Sign-in took too long. Try again.",
  provider_error: "Google or GitHub did not respond. Try again.",
  // orders
  RATE_LIMITED: "Too many requests at once. Wait a moment and try again.",
  UNKNOWN_SYMBOL: "This stock is not traded here.",
  QUANTITY_TOO_LARGE: "The most you can trade in one order is 10,000 shares.",
  BAD_LOT_SIZE: "Quantity must be a whole number of lots for this stock.",
  BAD_LIMIT_PRICE: "Set a limit price for a limit order.",
  BAD_TICK_SIZE: "Prices move in steps of ₹0.05. Round the limit price.",
  PRICE_OUT_OF_BAND: "Limit price must be within 10% of the previous close.",
  ORDER_VALUE_TOO_LARGE: "One order can be worth at most ₹10,00,000.",
  INSUFFICIENT_CASH: "Not enough available cash for this order.",
  INSUFFICIENT_SHARES: "You don't hold enough free shares to sell this many.",
  DAILY_ORDER_LIMIT: "You've placed 100 orders today. Trading reopens with the next day.",
  TOO_MANY_OPEN_ORDERS: "You have 20 open orders. Cancel one to place another.",
  ORDER_NOT_FOUND: "That order no longer exists.",
  ORDER_CLOSED: "That order has already been filled or closed.",
  NOT_MODIFIABLE: "Only limit orders can be modified.",
  MARKET_CLOSED: "The market is closed. Orders open again at the next pre-open.",
  NO_ACCOUNT: "Your trading account was not found.",
  PROFILE_INCOMPLETE: "Finish your profile before you place an order.",
  HANDLE_TAKEN: "That handle is taken. Try another one.",
  INVALID_INPUT: "Check the values you entered.",
};

export function errorText(code: string): string {
  return messages[code] ?? `Something went wrong (${code}).`;
}

export const errorOf = (err: unknown) => errorText(err instanceof ApiError ? err.code : "NETWORK");

// Response shapes (see the backend route comments).
export type Side = "BUY" | "SELL";
export interface Me {
  id: string;
  email: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  createdAt: string;
  profileComplete: boolean;
}
export interface Session {
  tradingDay: number;
  phase: Phase;
  phaseEndsAt: string;
  serverTime: string;
  engine?: "running" | "stopped";
}
export type Phase = "PRE_OPEN" | "OPEN" | "POST_CLOSE" | "CLOSED";
export interface Instrument {
  symbol: string;
  name: string;
  lastPrice: string;
  prevClose: string;
  changePct: string;
}
export interface Holding {
  symbol: string;
  quantity: number;
  reservedQuantity: number;
  avgCost: string;
  lastPrice: string;
  marketValue: string;
  unrealizedPnl: string;
  unrealizedPct: string;
  realizedPnl: string;
}
export interface Portfolio {
  cash: string;
  reservedCash: string;
  availableCash: string;
  holdings: Holding[];
  totals: { holdingsValue: string; equity: string; realizedPnl: string; unrealizedPnl: string; totalPnl: string; returnPct: string; invested: string };
}
export interface Order {
  id: string;
  symbol: string;
  side: Side;
  type: "MARKET" | "LIMIT";
  quantity: number;
  filledQuantity: number;
  limitPrice: string | null;
  avgFillPrice: string | null;
  status: string;
  rejectReason: string | null;
  createdAt: string;
}
