import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { deleteSessionsForShop } from "~/lib/admin-api.server";
import { clearSubscription } from "~/models/billing.server";
import { authenticate } from "~/shopify.server";

/**
 * Webhook: app/uninstalled
 *
 * When a merchant uninstalls the app, Shopify revokes the OAuth
 * access token. We proactively delete all stored sessions for
 * that shop and disable deposit settings.
 *
 * authenticate.webhook verifies the HMAC signature and throws a
 * 401 response for unsigned or forged requests.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    return json({ error: "Invalid webhook" }, { status: 400 });
  }

  try {
    const deleted = await deleteSessionsForShop(shop);
    console.info(
      `[webhook app/uninstalled] Deleted ${deleted} session(s) for ${shop}`,
    );

    // Disable deposit settings for the uninstalled shop
    await prisma.depositSettings
      .updateMany({ where: { shopId: shop }, data: { enabled: false } })
      .catch(() => {});
    // Shopify cancels app subscriptions on uninstall (the trial is kept)
    await clearSubscription(shop).catch(() => {});

    return json({ success: true, deletedSessions: deleted });
  } catch (e) {
    console.error("[webhook app/uninstalled] Error:", e);
    return json({ error: "Internal error" }, { status: 500 });
  }
}
