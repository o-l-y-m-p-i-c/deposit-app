import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";

/**
 * Webhook: collections/update
 *
 * When a collection is updated, we log the event. The Cart Transform
 * Function reads collection membership at runtime via inAnyCollection,
 * so no metafield sync is needed for collection updates.
 */
export async function action({ request }: ActionFunctionArgs) {
  const topic = request.headers.get("X-Shopify-Topic");
  const shop = request.headers.get("X-Shopify-Shop-Domain");

  if (topic !== "collections/update" || !shop) {
    return json({ error: "Invalid webhook" }, { status: 400 });
  }

  try {
    await prisma.syncLog.create({
      data: {
        shopId: shop,
        operation: "collection_update",
        status: "success",
        message: "Collection updated (no action needed — Function checks membership at runtime)",
      },
    }).catch(() => {});

    return json({ success: true });
  } catch (e) {
    console.error("[webhook collections/update] Error:", e);
    return json({ error: "Internal error" }, { status: 500 });
  }
}
