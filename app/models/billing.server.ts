/**
 * Billing state per shop (ported from gift-app): trial, development-store
 * status and Shopify subscriptions, cached in the database.
 */

import { prisma } from "~/db.server";
import { adminGraphql } from "~/lib/admin-api.server";
import { PLAN_CURRENCY, getBillingAccess, nextTrialState } from "~/lib/billing.server";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

function getShopTrial(shopId: string) {
  return prisma.shopTrial.upsert({ where: { shopId }, create: { shopId }, update: {} });
}

export async function getShopBilling(shopId: string) {
  const existing = await prisma.shopBilling.findUnique({ where: { shopId } });
  if (existing) return existing;
  // A reinstalling shop keeps its original trial start.
  const trial = await getShopTrial(shopId);
  return prisma.shopBilling.upsert({
    where: { shopId },
    create: { shopId, trialStartedAt: trial.trialStartedAt, isDevStore: trial.devStore },
    update: {},
  });
}

/**
 * Cheap access check for storefront requests — reads only the cached
 * billing state, never the Admin API.
 */
export async function hasBillingAccess(shopId: string) {
  const billing = await prisma.shopBilling.findUnique({ where: { shopId } });
  // Never synced yet = the trial hasn't started counting — allow
  return billing ? getBillingAccess(billing).hasAccess : true;
}

const BILLING_STATE_QUERY = `
  query BillingState {
    shop {
      plan {
        partnerDevelopment
      }
    }
    currentAppInstallation {
      allSubscriptions(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          status
          test
          trialDays
          createdAt
          currentPeriodEnd
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Pull dev-store status and subscriptions from Shopify and store them.
 * Skips the API call when synced recently unless `force` is set.
 */
export async function syncBilling(shopId: string, { force = false } = {}) {
  const billing = await getShopBilling(shopId);
  if (
    !force &&
    billing.lastSyncedAt &&
    Date.now() - billing.lastSyncedAt.getTime() < SYNC_INTERVAL_MS
  ) {
    return billing;
  }

  let data: any;
  try {
    data = await adminGraphql(BILLING_STATE_QUERY, {}, shopId);
  } catch (error) {
    console.error("[billing] Failed to sync billing state:", error);
    return billing;
  }

  const isDevStore = Boolean(data?.data?.shop?.plan?.partnerDevelopment);
  const subscriptions: any[] = data?.data?.currentAppInstallation?.allSubscriptions?.nodes || [];
  const now = new Date();

  for (const sub of subscriptions) {
    const price = sub.lineItems?.[0]?.plan?.pricingDetails?.price;
    const amount = Math.round(Number.parseFloat(price?.amount ?? "0") * 100);
    const currencyCode = price?.currencyCode || PLAN_CURRENCY;
    const createdAt = new Date(sub.createdAt);
    const currentPeriodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;

    await prisma.billingSubscription.upsert({
      where: { id: sub.id },
      create: {
        id: sub.id,
        shopId,
        name: sub.name,
        status: sub.status,
        test: Boolean(sub.test),
        trialDays: sub.trialDays ?? 0,
        amount,
        currencyCode,
        createdAt,
        currentPeriodEnd,
      },
      update: { status: sub.status, currentPeriodEnd },
    });
  }

  const trial = nextTrialState(await getShopTrial(shopId), isDevStore, now);
  await prisma.shopTrial.update({ where: { shopId }, data: trial });

  const active = subscriptions.find((sub) => sub.status === "ACTIVE");
  return prisma.shopBilling.update({
    where: { shopId },
    data: {
      isDevStore,
      trialStartedAt: trial.trialStartedAt,
      subscriptionId: active?.id ?? null,
      subscriptionStatus: active?.status ?? subscriptions[0]?.status ?? null,
      currentPeriodEnd: active?.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
      lastSyncedAt: now,
    },
  });
}

/** Shopify cancels app subscriptions on uninstall. */
export async function clearSubscription(shopId: string) {
  await prisma.shopBilling.updateMany({
    where: { shopId },
    data: {
      subscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      lastSyncedAt: null,
      syncedAccess: null,
    },
  });
  await prisma.billingSubscription.updateMany({
    where: { shopId, status: { in: ["ACTIVE", "PENDING", "FROZEN"] } },
    data: { status: "CANCELLED" },
  });
}

export async function getSubscriptions(shopId: string) {
  return prisma.billingSubscription.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
  });
}
