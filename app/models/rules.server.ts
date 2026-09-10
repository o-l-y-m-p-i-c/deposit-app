/**
 * Rules model — CRUD for DepositRule (include/exclude tags and collections).
 */

import { prisma } from "~/db.server";

export async function getRules(shopId: string) {
  return prisma.depositRule.findMany({
    where: { shopId },
    orderBy: [{ effect: "asc" }, { resourceType: "asc" }, { createdAt: "asc" }],
  });
}

export async function addRule(shopId: string, data: {
  effect: string;
  resourceType: string;
  resourceId?: string | null;
  value: string;
  label: string;
}) {
  return prisma.depositRule.create({
    data: { shopId, ...data },
  }).catch((e: unknown) => {
    // Unique constraint violation — rule already exists
    if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
      throw new Error("Rule already exists");
    }
    throw e;
  });
}

export async function removeRule(shopId: string, ruleId: number) {
  return prisma.depositRule.deleteMany({
    where: { id: ruleId, shopId },
  });
}

export async function removeAllRules(shopId: string) {
  return prisma.depositRule.deleteMany({
    where: { shopId },
  });
}
