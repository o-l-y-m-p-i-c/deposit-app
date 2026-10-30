import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { fullSync } from "~/lib/deposit.server";
import { authenticate } from "~/shopify.server";

/**
 * Webhook: app_subscriptions/update
 *
 * Fires when a subscription is approved, cancelled, frozen, expires, etc.
 * Re-runs the full sync, which turns the deposit on or off on the
 * storefront and in the Cart Transform to match the subscription.
 *
 * Work runs after the response to stay within the 5s webhook timeout.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Verifies the HMAC signature; throws 401 for forged requests
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
    return json({ error: "Invalid webhook" }, { status: 400 });
  }

  const status =
    (payload as { app_subscription?: { status?: string } })?.app_subscription?.status ??
    "unknown";

  void (async () => {
    await prisma.syncLog.create({
      data: { shopId: shop, operation: "billing", status: "success", message: `Subscription ${status}` },
    });
    // Nothing set up yet (no settings row) — the first Save & Sync does it
    const settings = await prisma.depositSettings.findUnique({ where: { shopId: shop } });
    if (!settings) return;
    await fullSync(shop);
  })().catch((e) => {
    console.error(`[webhook app_subscriptions/update] ${shop}:`, e);
  });

  return json({ success: true });
}
