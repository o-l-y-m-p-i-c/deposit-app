/**
 * Settings model — CRUD for DepositSettings.
 */

import { prisma } from "~/db.server";

export async function getSettings(shopId: string) {
  let settings = await prisma.depositSettings.findUnique({
    where: { shopId },
  });

  if (!settings) {
    settings = await prisma.depositSettings.create({
      data: { shopId },
    });
  }

  return settings;
}

export async function updateSettings(shopId: string, data: {
  enabled?: boolean;
  amountMinor?: number;
  currencyCode?: string;
  bottleCountMode?: string;
  bottleCountKey?: string;
}) {
  return prisma.depositSettings.upsert({
    where: { shopId },
    update: data,
    create: { shopId, ...data },
  });
}
