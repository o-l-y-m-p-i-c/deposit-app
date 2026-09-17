-- AlterTable
ALTER TABLE "DepositSettings" ADD COLUMN     "depositMode" TEXT NOT NULL DEFAULT 'line',
ADD COLUMN     "validationId" TEXT;
