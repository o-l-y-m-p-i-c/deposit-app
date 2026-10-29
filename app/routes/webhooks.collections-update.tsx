import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { getRulesGrouped } from "~/lib/deposit.server";
import { syncEligibility } from "~/lib/eligibility.server";
import { authenticate } from "~/shopify.server";

/**
 * Webhook: collections/update
 *
 * When a collection used by a deposit rule changes (membership, smart
 * collection conditions), re-run the eligibility sync so product
 * metafields follow. Other collections are ignored.
 *
 * Work runs after the response to stay within the 5s webhook timeout.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Verifies the HMAC signature; throws 401 for forged requests
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (topic !== "COLLECTIONS_UPDATE") {
    return json({ error: "Invalid webhook" }, { status: 400 });
  }

  const collectionGid =
    (payload as { admin_graphql_api_id?: string })?.admin_graphql_api_id ??
    `gid://shopify/Collection/${(payload as { id?: number })?.id}`;

  void (async () => {
    const used = await prisma.depositRule.count({
      where: { shopId: shop, resourceType: "COLLECTION", resourceId: collectionGid },
    });
    if (used === 0) return;

    const settings = await prisma.depositSettings.findUnique({ where: { shopId: shop } });
    const result = await syncEligibility(shop, await getRulesGrouped(shop), {
      skipProductIds: settings?.depositProductId ? [settings.depositProductId] : [],
    });
    await prisma.syncLog.create({
      data: {
        shopId: shop,
        operation: "collection_eligibility",
        status: "success",
        message: `${collectionGid}: ${result.total} products with deposit (+${result.flagged} / -${result.unflagged})`,
      },
    });
  })().catch((e) => {
    console.error(`[webhook collections/update] ${shop} ${collectionGid}:`, e);
  });

  return json({ success: true });
}
