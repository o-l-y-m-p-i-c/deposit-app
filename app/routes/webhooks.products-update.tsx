import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { getRulesGrouped } from "~/lib/deposit.server";
import { recomputeProduct } from "~/lib/eligibility.server";
import { authenticate } from "~/shopify.server";

/**
 * Webhook: products/update and products/delete
 *
 * Re-evaluates the deposit rules for the changed product and updates its
 * $app:deposit.bottles metafield (tags or collections may have changed).
 * Deleted products drop out of the DepositProduct mirror.
 *
 * Work runs after the response so the webhook stays within Shopify's
 * 5s timeout. Our own metafield writes fire products/update too;
 * recomputeProduct is a no-op when nothing changed, so no loop.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Verifies the HMAC signature; throws 401 for forged requests
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_UPDATE" && topic !== "PRODUCTS_DELETE") {
    return json({ error: "Invalid webhook" }, { status: 400 });
  }

  const productGid =
    (payload as { admin_graphql_api_id?: string })?.admin_graphql_api_id ??
    `gid://shopify/Product/${(payload as { id?: number })?.id}`;

  void (async () => {
    const settings = await prisma.depositSettings.findUnique({ where: { shopId: shop } });
    // Not set up yet, or the deposit product itself — nothing to evaluate
    if (!settings || settings.depositProductId === productGid) return;

    const rules = await getRulesGrouped(shop);
    const before = await prisma.depositProduct.count({ where: { shopId: shop } });
    await recomputeProduct(shop, productGid, rules);
    const after = await prisma.depositProduct.count({ where: { shopId: shop } });
    if (before !== after) {
      await prisma.syncLog.create({
        data: {
          shopId: shop,
          operation: "product_eligibility",
          status: "success",
          message: `${productGid} ${after > before ? "now has" : "no longer has"} a deposit`,
        },
      });
    }
  })().catch((e) => {
    console.error(`[webhook ${topic}] ${shop} ${productGid}:`, e);
  });

  return json({ success: true });
}
