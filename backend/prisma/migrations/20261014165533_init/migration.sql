-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('INITIAL_GRANT', 'TRADE_BUY', 'TRADE_SELL', 'FEE', 'RESET');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "userId" UUID NOT NULL,
    "cash" DECIMAL(20,4) NOT NULL,
    "reservedCash" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "balanceAfter" DECIMAL(20,4) NOT NULL,
    "tradeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruments" (
    "symbol" VARCHAR(16) NOT NULL,
    "name" TEXT NOT NULL,
    "exchange" VARCHAR(8) NOT NULL DEFAULT 'NSE',
    "tickSize" DECIMAL(10,4) NOT NULL DEFAULT 0.05,
    "lotSize" INTEGER NOT NULL DEFAULT 1,
    "initialPrice" DECIMAL(20,4) NOT NULL,
    "volatility" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "symbol" VARCHAR(16) NOT NULL,
    "clientOrderId" VARCHAR(64),
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "limitPrice" DECIMAL(20,4),
    "filledQuantity" INTEGER NOT NULL DEFAULT 0,
    "avgFillPrice" DECIMAL(20,4),
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "symbol" VARCHAR(16) NOT NULL,
    "side" "OrderSide" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(20,4) NOT NULL,
    "fee" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "executedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holdings" (
    "userId" UUID NOT NULL,
    "symbol" VARCHAR(16) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
    "avgCost" DECIMAL(20,4) NOT NULL,
    "realizedPnl" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("userId","symbol")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer" VARCHAR(64) NOT NULL,
    "eventId" UUID NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "oauth_accounts_userId_idx" ON "oauth_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_providerAccountId_key" ON "oauth_accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "ledger_entries_userId_createdAt_idx" ON "ledger_entries"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_tradeId_idx" ON "ledger_entries"("tradeId");

-- CreateIndex
CREATE INDEX "orders_userId_createdAt_idx" ON "orders"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_symbol_status_idx" ON "orders"("symbol", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_userId_clientOrderId_key" ON "orders"("userId", "clientOrderId");

-- CreateIndex
CREATE INDEX "trades_userId_executedAt_idx" ON "trades"("userId", "executedAt" DESC);

-- CreateIndex
CREATE INDEX "trades_orderId_idx" ON "trades"("orderId");

-- CreateIndex
CREATE INDEX "holdings_symbol_idx" ON "holdings"("symbol");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "instruments"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "instruments"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "instruments"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity guards Prisma cannot express. A settlement/reservation bug fails loudly here
-- instead of silently creating money or shares.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_cash_nonneg" CHECK ("cash" >= 0);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_reserved_valid" CHECK ("reservedCash" >= 0 AND "reservedCash" <= "cash");
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_qty_nonneg" CHECK ("quantity" >= 0);
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_reserved_valid" CHECK ("reservedQuantity" >= 0 AND "reservedQuantity" <= "quantity");
ALTER TABLE "orders" ADD CONSTRAINT "orders_qty_positive" CHECK ("quantity" > 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_filled_valid" CHECK ("filledQuantity" >= 0 AND "filledQuantity" <= "quantity");
ALTER TABLE "orders" ADD CONSTRAINT "orders_limit_price" CHECK (("type" = 'LIMIT') = ("limitPrice" IS NOT NULL));
ALTER TABLE "trades" ADD CONSTRAINT "trades_qty_positive" CHECK ("quantity" > 0 AND "price" > 0);
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_price_positive" CHECK ("initialPrice" > 0 AND "lotSize" > 0);
