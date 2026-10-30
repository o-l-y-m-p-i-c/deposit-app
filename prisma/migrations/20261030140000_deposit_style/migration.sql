-- AlterTable
ALTER TABLE "DepositSettings" ADD COLUMN "depositStyle" TEXT NOT NULL DEFAULT 'shared';

-- CreateTable
CREATE TABLE "DepositItem" (
    "shopId" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositItem_pkey" PRIMARY KEY ("shopId","sourceProductId")
);
