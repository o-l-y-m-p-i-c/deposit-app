/**
 * Per-drink deposit products — the "per_product" deposit style.
 *
 * Instead of one shared "Bottle Deposit" product linked by a "Deposit
 * for" note, every eligible drink gets its own deposit product titled
 * "Deposit – <drink title>", priced at the deposit amount × the drink's
 * bottles. The cart line's own title shows what the deposit belongs to.
 *
 * The drink stores its deposit variant in the $app:deposit.deposit_variant
 * metafield, read by the checkout Function, Liquid and the storefront
 * script (via the app proxy). Deposit products that are no longer needed
 * are archived, never deleted, so past orders keep a valid product.
 */

import { prisma } from "~/db.server";
import {
  adminGraphql,
  GET_PUBLICATIONS,
  PUBLISH_PRODUCT,
  SET_METAFIELDS,
} from "~/lib/admin-api.server";
import { DEPOSIT_NAMESPACE } from "~/lib/eligibility.server";

/** Tag on every per-drink deposit product (the checkout Function reads it). */
export const DEPOSIT_ITEM_TAG = "bottle-deposit-item";
export const DEPOSIT_VARIANT_KEY = "deposit_variant";

export const depositItemTitle = (drinkTitle: string) => `Deposit – ${drinkTitle}`;

const productGid = (id: string) => `gid://shopify/Product/${id}`;
const variantGid = (id: string) => `gid://shopify/ProductVariant/${id}`;
const numericId = (gid: string) => gid.split("/").pop() || gid;

const PRODUCT_TITLES = /* GraphQL */ `#graphql
  query DepositDrinkTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title }
    }
  }
`;

const SET_DEPOSIT_ITEM = /* GraphQL */ `#graphql
  mutation DepositItemSet($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product { id variants(first: 1) { nodes { id } } }
      userErrors { field message code }
    }
  }
`;

const ARCHIVE_DEPOSIT_ITEM = /* GraphQL */ `#graphql
  mutation DepositItemArchive($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      userErrors { field message }
    }
  }
`;

const DELETE_DEPOSIT_VARIANT_LINK = /* GraphQL */ `#graphql
  mutation DepositVariantLinkDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Current titles of drinks (numeric IDs); deleted products are absent. */
async function fetchTitles(shop: string, productIds: string[]) {
  const titles = new Map<string, string>();
  for (const ids of chunk(productIds, 100)) {
    const result = await adminGraphql(PRODUCT_TITLES, { ids: ids.map(productGid) }, shop);
    for (const node of result?.data?.nodes ?? []) {
      if (node?.id && node?.title) titles.set(numericId(node.id), node.title);
    }
  }
  return titles;
}

function depositItemInput(title: string, priceMinor: number, sku: string, existingVariantId?: string) {
  return {
    title,
    productType: "Deposit",
    vendor: "Bottle Deposit App",
    status: "ACTIVE",
    tags: ["deposit", DEPOSIT_ITEM_TAG],
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [
      {
        ...(existingVariantId ? { id: variantGid(existingVariantId) } : {}),
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        price: (priceMinor / 100).toFixed(2),
        sku,
        taxable: false,
        inventoryItem: { tracked: false, requiresShipping: false },
      },
    ],
  };
}

/**
 * Create or update a deposit product. Falls back to creating a new one
 * when the stored product was deleted in the Shopify admin.
 */
async function upsertDepositItem(
  shop: string,
  input: ReturnType<typeof depositItemInput>,
  existingProductId?: string,
) {
  const run = async (identifier: { id: string } | null, body: typeof input) => {
    const result = await adminGraphql(SET_DEPOSIT_ITEM, { identifier, input: body }, shop);
    return result?.data?.productSet;
  };
  let payload = await run(existingProductId ? { id: productGid(existingProductId) } : null, input);
  if (existingProductId && (payload?.userErrors?.length ?? 0) > 0) {
    // Gone from the catalog — start over with a fresh product
    const fresh = { ...input, variants: input.variants.map(({ id: _id, ...v }: any) => v) };
    payload = await run(null, fresh);
  }
  if ((payload?.userErrors?.length ?? 0) > 0) {
    throw new Error(`Failed to set deposit product: ${JSON.stringify(payload.userErrors)}`);
  }
  const productId = payload?.product?.id;
  const variantId = payload?.product?.variants?.nodes?.[0]?.id;
  if (!productId || !variantId) throw new Error("Deposit product is missing a product or variant ID");
  return { productId: numericId(productId), variantId: numericId(variantId) };
}

async function onlineStorePublicationId(shop: string) {
  const result = await adminGraphql(GET_PUBLICATIONS, {}, shop);
  const pub = (result?.data?.publications?.nodes ?? []).find(
    (p: { name?: string }) => p.name === "Online Store",
  );
  if (!pub?.id) throw new Error("Online Store publication not found");
  return pub.id as string;
}

/**
 * Bring per-drink deposit products in line with the deposit style and
 * the flagged drinks (DepositProduct). In the "shared" style every
 * deposit item is archived. `onlyProductIds` limits the work to some
 * drinks (products/update webhook); `force` rewrites every link.
 */
export async function syncDepositItems(
  shop: string,
  {
    style,
    amountMinor,
    onlyProductIds,
    force = false,
  }: { style: string; amountMinor: number; onlyProductIds?: string[]; force?: boolean },
) {
  const scope = onlyProductIds ? { in: onlyProductIds } : undefined;
  const flagged =
    style === "per_product"
      ? await prisma.depositProduct.findMany({
          where: { shopId: shop, ...(scope ? { productId: scope } : {}) },
        })
      : [];
  const items = await prisma.depositItem.findMany({
    where: { shopId: shop, ...(scope ? { sourceProductId: scope } : {}) },
  });
  const itemBySource = new Map(items.map((i) => [i.sourceProductId, i]));
  const titles = await fetchTitles(shop, flagged.map((f) => f.productId));

  const result = { created: 0, updated: 0, archived: 0 };
  const links: { ownerId: string; variantId: string }[] = [];
  let publicationId: string | null = null;

  for (const drink of flagged) {
    const drinkTitle = titles.get(drink.productId);
    if (!drinkTitle) continue; // drink deleted — its webhook cleans up
    const title = depositItemTitle(drinkTitle);
    const priceMinor = amountMinor * drink.bottles;
    const existing = itemBySource.get(drink.productId);

    const unchanged =
      existing?.active && existing.title === title && existing.priceMinor === priceMinor;
    if (unchanged && !force) continue;

    let ids = existing && { productId: existing.productId, variantId: existing.variantId };
    if (!unchanged) {
      ids = await upsertDepositItem(
        shop,
        depositItemInput(title, priceMinor, `DEPOSIT-${drink.productId}`, existing?.variantId),
        existing?.productId,
      );
      // New, re-created or un-archived products must be sellable online
      if (!existing?.active || existing.productId !== ids.productId) {
        publicationId ??= await onlineStorePublicationId(shop);
        await adminGraphql(PUBLISH_PRODUCT, {
          id: productGid(ids.productId),
          input: [{ publicationId }],
        }, shop);
      }
      await prisma.depositItem.upsert({
        where: { shopId_sourceProductId: { shopId: shop, sourceProductId: drink.productId } },
        create: { shopId: shop, sourceProductId: drink.productId, ...ids!, title, priceMinor },
        update: { ...ids!, title, priceMinor, active: true },
      });
      existing ? result.updated++ : result.created++;
    }
    links.push({ ownerId: productGid(drink.productId), variantId: ids!.variantId });
  }

  // Link each drink to its deposit variant (checkout Function, Liquid, proxy)
  for (const batch of chunk(links, 25)) {
    const res = await adminGraphql(SET_METAFIELDS, {
      metafields: batch.map((l) => ({
        ownerId: l.ownerId,
        namespace: DEPOSIT_NAMESPACE,
        key: DEPOSIT_VARIANT_KEY,
        type: "number_integer",
        value: l.variantId,
      })),
    }, shop);
    const errors = res?.data?.metafieldsSet?.userErrors;
    if (errors?.length > 0) {
      throw new Error(`Failed to link deposit products: ${JSON.stringify(errors)}`);
    }
  }

  // Archive deposit products no drink needs any more
  const wanted = new Set(flagged.map((f) => f.productId));
  for (const item of items) {
    if (!item.active || wanted.has(item.sourceProductId)) continue;
    await adminGraphql(ARCHIVE_DEPOSIT_ITEM, {
      product: { id: productGid(item.productId), status: "ARCHIVED" },
    }, shop);
    // The drink may be gone already — errors here are harmless
    await adminGraphql(DELETE_DEPOSIT_VARIANT_LINK, {
      metafields: [{
        ownerId: productGid(item.sourceProductId),
        namespace: DEPOSIT_NAMESPACE,
        key: DEPOSIT_VARIANT_KEY,
      }],
    }, shop).catch(() => {});
    await prisma.depositItem.update({
      where: { shopId_sourceProductId: { shopId: shop, sourceProductId: item.sourceProductId } },
      data: { active: false },
    });
    result.archived++;
  }

  return result;
}

/** Numeric product IDs of this shop's deposit items (never deposit-eligible). */
export async function depositItemProductIds(shop: string) {
  const rows = await prisma.depositItem.findMany({
    where: { shopId: shop },
    select: { productId: true },
  });
  return rows.map((r) => r.productId);
}
