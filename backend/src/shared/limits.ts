// Trading rules agreed for P3. Decimal values are strings: they feed Prisma.Decimal, never float math.

export const FEE_RATE = "0.0003"; // 0.03% of trade value, charged to both sides
export const MARKET_PROTECTION = "0.05"; // MARKET orders fill at most 5% away from the last price; the rest is cancelled

export const OrderLimits = {
  perDay: 100, // orders per user per trading day
  open: 20, // OPEN + PARTIALLY_FILLED orders per user
  perSecond: 5,
  maxQuantity: 10_000,
  maxValue: "1000000", // ₹10,00,000 per order
  priceBand: "0.10", // LIMIT price within ±10% of the previous close
} as const;

export const LOGIN_PER_MINUTE_PER_IP = 20;
