/*
  Warnings:

  - Added the required column `tradingDay` to the `orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tradingDay` to the `trades` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "tradingDay" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "tradingDay" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "daily_bars" (
    "symbol" VARCHAR(16) NOT NULL,
    "tradingDay" INTEGER NOT NULL,
    "open" DECIMAL(20,4) NOT NULL,
    "high" DECIMAL(20,4) NOT NULL,
    "low" DECIMAL(20,4) NOT NULL,
    "close" DECIMAL(20,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_bars_pkey" PRIMARY KEY ("symbol","tradingDay")
);

-- CreateIndex
CREATE INDEX "orders_tradingDay_status_idx" ON "orders"("tradingDay", "status");

-- AddForeignKey
ALTER TABLE "daily_bars" ADD CONSTRAINT "daily_bars_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "instruments"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity guard Prisma cannot express (same convention as init).
ALTER TABLE "daily_bars" ADD CONSTRAINT "daily_bars_ohlc_valid" CHECK ("low" > 0 AND "low" <= LEAST("open", "close") AND "high" >= GREATEST("open", "close"));
