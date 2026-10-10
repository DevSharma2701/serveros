-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE 'QR';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "guestName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "guestTableId" UUID,
ADD COLUMN     "guestToken" TEXT,
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OrderItem" ALTER COLUMN "addedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "qrOrderingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "receivedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RestaurantTable" ADD COLUMN     "qrToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_guestToken_key" ON "Order"("guestToken");

-- CreateIndex
CREATE INDEX "Order_guestTableId_status_idx" ON "Order"("guestTableId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_qrToken_key" ON "RestaurantTable"("qrToken");

