import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { hasBillingAccess } from "~/models/billing.server";
import { authenticate } from "~/shopify.server";

const MAX_IDS = 250;

/**
 * App proxy: GET /apps/deposit/eligibility?ids=123,456
 *
 * Returns deposit units per product unit for the requested numeric
 * product IDs ({ products: { "123": 1, "456": 0 } }) — the same data as
 * the $app:deposit.bottles metafield the Functions read, so the
 * storefront script never disagrees with checkout.
 *
 * authenticate.public.appProxy verifies Shopify's proxy signature,
 * which also covers the `shop` query parameter.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const ids = [
    ...new Set(
      (url.searchParams.get("ids") || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s)),
    ),
  ].slice(0, MAX_IDS);

  const products: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  // After the trial without a subscription: no deposit, no labels — even
  // before the hourly sweep re-syncs the storefront config
  if (shop && ids.length > 0 && (await hasBillingAccess(shop))) {
    const rows = await prisma.depositProduct.findMany({
      where: { shopId: shop, productId: { in: ids } },
      select: { productId: true, bottles: true },
    });
    rows.forEach((r) => {
      products[r.productId] = r.bottles;
    });
  }

  return json(
    { products },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
