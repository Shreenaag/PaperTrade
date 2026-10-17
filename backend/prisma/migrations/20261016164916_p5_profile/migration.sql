-- AlterTable
ALTER TABLE "users" ADD COLUMN     "handle" VARCHAR(20),
ADD COLUMN     "profileCompletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

