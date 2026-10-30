-- AlterTable
ALTER TABLE "DepositSettings" ADD COLUMN "depositMethod" TEXT NOT NULL DEFAULT 'linking';

-- CreateTable
CREATE TABLE "BundleItem" (
    "shopId" TEXT NOT NULL,
    "parentVariantId" TEXT NOT NULL,
    "parentProductId" TEXT NOT NULL,
    "copyProductId" TEXT NOT NULL,
    "copyVariantId" TEXT NOT NULL,
    "basePriceMinor" INTEGER NOT NULL,
    "depositUnits" INTEGER NOT NULL,
    "parentTracked" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BundleItem_pkey" PRIMARY KEY ("shopId","parentVariantId")
);

-- CreateIndex
CREATE INDEX "BundleItem_shopId_parentProductId_idx" ON "BundleItem"("shopId", "parentProductId");
