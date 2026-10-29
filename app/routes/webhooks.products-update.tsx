import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { authenticate } from "~/shopify.server";

/**
 * Webhook: products/update
 *
 * When a product is updated, we log the event. The Cart Transform
 * Function reads product tags and collection membership at runtime,
 * so no metafield sync is needed for product updates.
 *
 * This webhook is primarily for audit logging and future use
 * (e.g., syncing bottle count metafields).
 */
export async function action({ request }: ActionFunctionArgs) {
  // Verifies the HMAC signature; throws 401 for forged requests
  const { shop, topic } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_UPDATE") {
    return json({ error: "Invalid webhook" }, { status: 400 });
  }

  try {
    // Quick log — no heavy processing to stay within 5s timeout
    await prisma.syncLog.create({
      data: {
        shopId: shop,
        operation: "product_update",
        status: "success",
        message: "Product updated (no action needed — Function reads tags at runtime)",
      },
    }).catch(() => {});

    return json({ success: true });
  } catch (e) {
    console.error("[webhook products/update] Error:", e);
    return json({ error: "Internal error" }, { status: 500 });
  }
}
