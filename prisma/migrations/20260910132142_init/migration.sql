-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN,
    "locale" TEXT,
    "collaborator" BOOLEAN,
    "emailVerified" BOOLEAN,
    "onlineAccessInfo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositSettings" (
    "id" SERIAL NOT NULL,
    "shopId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "amountMinor" INTEGER NOT NULL DEFAULT 10,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "depositProductId" TEXT,
    "depositVariantId" TEXT,
    "cartTransformId" TEXT,
    "bottleCountMode" TEXT NOT NULL DEFAULT 'single',
    "bottleCountKey" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositRule" (
    "id" SERIAL NOT NULL,
    "shopId" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" SERIAL NOT NULL,
    "shopId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "DepositSettings_shopId_key" ON "DepositSettings"("shopId");

-- CreateIndex
CREATE INDEX "DepositRule_shopId_idx" ON "DepositRule"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "DepositRule_shopId_effect_resourceType_value_key" ON "DepositRule"("shopId", "effect", "resourceType", "value");

-- CreateIndex
CREATE INDEX "SyncLog_shopId_idx" ON "SyncLog"("shopId");
