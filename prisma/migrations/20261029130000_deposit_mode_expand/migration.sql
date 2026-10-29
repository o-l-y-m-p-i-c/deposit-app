-- Expand mode (deposit bundled into the product line by the Cart
-- Transform) replaces the separate deposit line for all shops.
ALTER TABLE "DepositSettings" ALTER COLUMN "depositMode" SET DEFAULT 'expand';
UPDATE "DepositSettings" SET "depositMode" = 'expand';
