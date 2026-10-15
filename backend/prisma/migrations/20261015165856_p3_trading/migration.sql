/*
  Warnings:

  - Added the required column `matchId` to the `trades` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "reservedCash" DECIMAL(20,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "matchId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "trades_matchId_idx" ON "trades"("matchId");

-- Integrity guard Prisma cannot express (same convention as init).
ALTER TABLE "orders" ADD CONSTRAINT "orders_reserved_nonneg" CHECK ("reservedCash" >= 0);
