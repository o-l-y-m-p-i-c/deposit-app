/**
 * Subscription billing — one plan (MONTHLY_PLAN, €9.99 / 30 days,
 * 14-day trial).
 *
 * - Admin pages call requireSubscription(): without an active
 *   subscription the merchant is sent to Shopify's approval screen.
 * - fullSync calls getInstallation(): without an active subscription
 *   the deposit is synced as disabled (storefront labels, deposit line
 *   and Cart Transform all off) until the merchant subscribes.
 * - The app_subscriptions/update webhook re-syncs on every status change.
 */

import { adminGraphql } from "~/lib/admin-api.server";
import { authenticate, MONTHLY_PLAN } from "~/shopify.server";

const SHOP_IS_DEV = /* GraphQL */ `#graphql
  query DepositShopPlan {
    shop { plan { partnerDevelopment } }
  }
`;

const CURRENT_INSTALLATION = /* GraphQL */ `#graphql
  query DepositCurrentInstallation {
    currentAppInstallation {
      id
      activeSubscriptions { name status test }
    }
  }
`;

// Development stores can't be charged — they only accept test charges
const devStoreCache = new Map<string, boolean>();

export async function isTestBilling(shop: string) {
  if (process.env.BILLING_TEST === "true") return true;
  if (!devStoreCache.has(shop)) {
    const result = await adminGraphql(SHOP_IS_DEV, {}, shop);
    devStoreCache.set(shop, result?.data?.shop?.plan?.partnerDevelopment === true);
  }
  return devStoreCache.get(shop)!;
}

/**
 * Authenticate an admin request and require an active subscription.
 * Without one, redirects to Shopify's charge approval page (throws).
 */
export async function requireSubscription(request: Request) {
  const context = await authenticate.admin(request);
  const { billing, session } = context;
  const isTest = await isTestBilling(session.shop);
  const storeHandle = session.shop.replace(".myshopify.com", "");

  await billing.require({
    plans: [MONTHLY_PLAN],
    isTest,
    onFailure: async () =>
      billing.request({
        plan: MONTHLY_PLAN,
        isTest,
        // Back into the embedded app after approval
        returnUrl: `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/settings`,
      }),
  });
  return context;
}

/**
 * The app installation ID (owner of the storefront metafield) and
 * whether the shop currently has an active subscription to the plan.
 */
export async function getInstallation(shop: string) {
  const result = await adminGraphql(CURRENT_INSTALLATION, {}, shop);
  const installation = result?.data?.currentAppInstallation;
  if (!installation?.id) throw new Error("Current app installation ID is unavailable");
  const subscriptions: { name: string; status: string; test: boolean }[] =
    installation.activeSubscriptions ?? [];
  const subscription = subscriptions.find(
    (s) => s.name === MONTHLY_PLAN && s.status === "ACTIVE",
  );
  return {
    id: installation.id as string,
    subscribed: !!subscription,
    testSubscription: !!subscription?.test,
  };
}
