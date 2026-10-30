import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { syncDepositAccess } from "~/lib/deposit.server";
import { authenticate } from "~/shopify.server";

/**
 * Webhook: app_subscriptions/update
 *
 * Fires when a subscription is activated, cancelled, declined, frozen, etc.
 * Re-syncs the shop's billing state, and the deposit config if access
 * changed, so the storefront and Cart Transform follow it.
 *
 * Work runs after the response to stay within the 5s webhook timeout.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Verifies the HMAC signature; throws 401 for forged requests
  const { shop, topic } = await authenticate.webhook(request);

  if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
    return json({ error: "Invalid webhook" }, { status: 400 });
  }

  void syncDepositAccess(shop, { force: true }).catch((e) => {
    console.error(`[webhook app_subscriptions/update] ${shop}:`, e);
  });

  return json({ success: true });
}
