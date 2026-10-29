-- CreateTable
CREATE TABLE "DepositProduct" (
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "bottles" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositProduct_pkey" PRIMARY KEY ("shopId","productId")
);
