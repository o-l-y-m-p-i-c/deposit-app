/**
 * "Bundling" deposit method — every deposit drink becomes a native
 * Shopify bundle, so Shopify itself keeps the deposit with the drink (no
 * storefront script, no Functions — works on every plan).
 *
 * Per drink:
 *   - a hidden copy "<title> [bundle component]" (unpublished, tagged
 *     bottle-deposit-component) takes over the drink's variants and stock
 *   - each visible drink variant becomes a bundle of copy variant × 1 +
 *     shared deposit variant × bottles, priced base + deposit, requiring
 *     its components and no longer tracking its own stock
 * Unbundling (method switched back, drink lost its deposit) reverses it:
 * bundle link removed, price and stock restored, copy archived.
 *
 * Merchants keep editing the visible drink's price as the price customers
 * pay (incl. deposit); the base price on the copy follows. Stock lives on
 * the hidden copy while bundled.
 */

import { prisma } from "~/db.server";
import { adminGraphql } from "~/lib/admin-api.server";

export const BUNDLE_COMPONENT_TAG = "bottle-deposit-component";
const MAX_VARIANTS = 20;

const productGid = (id: string) => `gid://shopify/Product/${id}`;
const variantGid = (id: string) => `gid://shopify/ProductVariant/${id}`;
const numericId = (gid: string) => gid.split("/").pop() || gid;
const toMinor = (amount: string | number) => Math.round(Number(amount) * 100);
const toAmount = (minor: number) => (minor / 100).toFixed(2);

type Level = { locationId: string; available: number };
type DrinkVariant = {
  id: string;
  price: number;
  sku: string | null;
  options: { name: string; value: string }[];
  inventoryItemId: string;
  tracked: boolean;
  levels: Level[];
};
type Drink = {
  id: string;
  title: string;
  variantsCount: number;
  options: { name: string; values: string[] }[];
  variants: DrinkVariant[];
};

const DRINK_DETAILS = /* GraphQL */ `#graphql
  query DepositBundleDrinks($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        variantsCount { count }
        options { name optionValues { name } }
        variants(first: 20) {
          nodes {
            id
            price
            sku
            selectedOptions { name value }
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 5) {
                nodes { location { id } quantities(names: ["available"]) { quantity } }
              }
            }
          }
        }
      }
    }
  }
`;

const VARIANT_STOCK = /* GraphQL */ `#graphql
  query DepositBundleStock($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        inventoryItem {
          id
          inventoryLevels(first: 5) {
            nodes { location { id } quantities(names: ["available"]) { quantity } }
          }
        }
      }
    }
  }
`;

const CREATE_COPY = /* GraphQL */ `#graphql
  mutation DepositBundleCopy($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product {
        id
        variants(first: 20) { nodes { id selectedOptions { name value } inventoryItem { id } } }
      }
      userErrors { field message code }
    }
  }
`;

const ACTIVATE_STOCK = /* GraphQL */ `#graphql
  mutation DepositBundleActivate($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      userErrors { field message }
    }
  }
`;

const SET_STOCK = /* GraphQL */ `#graphql
  mutation DepositBundleSetStock($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { field message code }
    }
  }
`;

const RELATIONSHIPS = /* GraphQL */ `#graphql
  mutation DepositBundleLink($input: [ProductVariantRelationshipUpdateInput!]!) {
    productVariantRelationshipBulkUpdate(input: $input) {
      userErrors { field message code }
    }
  }
`;

const UPDATE_VARIANTS = /* GraphQL */ `#graphql
  mutation DepositBundleVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

const SET_STATUS = /* GraphQL */ `#graphql
  mutation DepositBundleCopyStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      userErrors { field message }
    }
  }
`;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function assertNoErrors(errors: unknown, what: string) {
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Failed to ${what}: ${JSON.stringify(errors)}`);
  }
}

const optionsKey = (options: { name: string; value: string }[]) =>
  options.map((o) => `${o.name}=${o.value}`).sort().join("|");

const readLevels = (item: any): Level[] =>
  (item?.inventoryLevels?.nodes ?? []).map((l: any) => ({
    locationId: l.location.id,
    available: l.quantities?.[0]?.quantity ?? 0,
  }));

async function fetchDrinks(shop: string, productIds: string[]) {
  const drinks = new Map<string, Drink>();
  for (const ids of chunk(productIds, 5)) {
    const result = await adminGraphql(DRINK_DETAILS, { ids: ids.map(productGid) }, shop);
    for (const node of result?.data?.nodes ?? []) {
      if (!node?.id) continue;
      drinks.set(numericId(node.id), {
        id: numericId(node.id),
        title: node.title,
        variantsCount: node.variantsCount?.count ?? 0,
        options: (node.options ?? []).map((o: any) => ({
          name: o.name,
          values: (o.optionValues ?? []).map((v: any) => v.name),
        })),
        variants: (node.variants?.nodes ?? []).map((v: any) => ({
          id: numericId(v.id),
          price: toMinor(v.price),
          sku: v.sku || null,
          options: v.selectedOptions ?? [],
          inventoryItemId: v.inventoryItem.id,
          tracked: Boolean(v.inventoryItem.tracked),
          levels: readLevels(v.inventoryItem),
        })),
      });
    }
  }
  return drinks;
}

/** Set "available" stock for inventory items (compare-and-set). */
async function setStock(
  shop: string,
  quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number }[],
) {
  for (const batch of chunk(quantities, 50)) {
    if (batch.length === 0) continue;
    const res = await adminGraphql(SET_STOCK, {
      input: { name: "available", reason: "correction", quantities: batch },
    }, shop);
    assertNoErrors(res?.data?.inventorySetQuantities?.userErrors, "move stock");
  }
}

/** Turn one drink into bundles (all its variants). */
async function bundleDrink(shop: string, drink: Drink, units: number, amountMinor: number, depositVariantId: string) {
  if (drink.variantsCount > MAX_VARIANTS) {
    throw new Error(`"${drink.title}" has more than ${MAX_VARIANTS} variants — not bundled`);
  }

  // 1. Hidden copy with the same options/variants, holding the base price
  const created = await adminGraphql(CREATE_COPY, {
    input: {
      title: `${drink.title} [bundle component]`,
      status: "ACTIVE",
      productType: "Bundle component",
      tags: [BUNDLE_COMPONENT_TAG],
      productOptions: drink.options.map((o) => ({ name: o.name, values: o.values.map((name) => ({ name })) })),
      variants: drink.variants.map((v) => ({
        optionValues: v.options.map((o) => ({ optionName: o.name, name: o.value })),
        price: toAmount(v.price),
        ...(v.sku ? { sku: v.sku } : {}),
        inventoryItem: { tracked: v.tracked },
      })),
    },
  }, shop);
  const payload = created?.data?.productSet;
  assertNoErrors(payload?.userErrors, `create the bundle component for "${drink.title}"`);
  const copyProductId = numericId(payload.product.id);
  const copyByOptions = new Map<string, { id: string; inventoryItemId: string }>(
    payload.product.variants.nodes.map((n: any) => [
      optionsKey(n.selectedOptions),
      { id: numericId(n.id), inventoryItemId: n.inventoryItem.id },
    ]),
  );

  // 2. Move stock to the copy (same locations, same quantities)
  const stock: Parameters<typeof setStock>[1] = [];
  for (const v of drink.variants) {
    const copy = copyByOptions.get(optionsKey(v.options));
    if (!copy || !v.tracked) continue;
    for (const level of v.levels) {
      await adminGraphql(ACTIVATE_STOCK, { inventoryItemId: copy.inventoryItemId, locationId: level.locationId }, shop);
      stock.push({ inventoryItemId: copy.inventoryItemId, locationId: level.locationId, quantity: level.available, changeFromQuantity: 0 });
    }
  }
  await setStock(shop, stock);

  // 3. Each visible variant = copy × 1 + deposit × bottles, priced base + deposit
  const links = drink.variants.map((v) => {
    const copy = copyByOptions.get(optionsKey(v.options));
    if (!copy) throw new Error(`No bundle component variant for "${drink.title}"`);
    return { v, copy };
  });
  for (const batch of chunk(links, 10)) {
    const res = await adminGraphql(RELATIONSHIPS, {
      input: batch.map(({ v, copy }) => ({
        parentProductVariantId: variantGid(v.id),
        productVariantRelationshipsToCreate: [
          { id: variantGid(copy.id), quantity: 1 },
          { id: depositVariantId, quantity: units },
        ],
        priceInput: { calculation: "FIXED", price: toAmount(v.price + amountMinor * units) },
      })),
    }, shop);
    assertNoErrors(res?.data?.productVariantRelationshipBulkUpdate?.userErrors, `bundle "${drink.title}"`);
  }
  const res = await adminGraphql(UPDATE_VARIANTS, {
    productId: productGid(drink.id),
    variants: drink.variants.map((v) => ({
      id: variantGid(v.id),
      requiresComponents: true,
      inventoryItem: { tracked: false },
    })),
  }, shop);
  assertNoErrors(res?.data?.productVariantsBulkUpdate?.userErrors, `finish bundling "${drink.title}"`);

  for (const { v, copy } of links) {
    await prisma.bundleItem.upsert({
      where: { shopId_parentVariantId: { shopId: shop, parentVariantId: v.id } },
      create: {
        shopId: shop,
        parentVariantId: v.id,
        parentProductId: drink.id,
        copyProductId,
        copyVariantId: copy.id,
        basePriceMinor: v.price,
        depositUnits: units,
        parentTracked: v.tracked,
      },
      update: { copyProductId, copyVariantId: copy.id, basePriceMinor: v.price, depositUnits: units, parentTracked: v.tracked },
    });
  }
}

/** Reverse bundling for these rows (one drink): link, price, stock, copy. */
async function unbundleDrink(shop: string, rows: Awaited<ReturnType<typeof prisma.bundleItem.findMany>>) {
  if (rows.length === 0) return;
  const parentProductId = rows[0].parentProductId;

  // Current stock of copies (sold while bundled) and parents (frozen)
  const stockResult = await adminGraphql(VARIANT_STOCK, {
    ids: rows.flatMap((r) => [variantGid(r.copyVariantId), variantGid(r.parentVariantId)]),
  }, shop);
  const byId = new Map<string, any>(
    (stockResult?.data?.nodes ?? []).filter(Boolean).map((n: any) => [numericId(n.id), n]),
  );
  const parentExists = rows.some((r) => byId.has(r.parentVariantId));

  if (parentExists) {
    for (const batch of chunk(rows, 10)) {
      const res = await adminGraphql(RELATIONSHIPS, {
        input: batch.map((r) => ({
          parentProductVariantId: variantGid(r.parentVariantId),
          removeAllProductVariantRelationships: true,
          priceInput: { calculation: "FIXED", price: toAmount(r.basePriceMinor) },
        })),
      }, shop);
      assertNoErrors(res?.data?.productVariantRelationshipBulkUpdate?.userErrors, "remove bundle");
    }
    const res = await adminGraphql(UPDATE_VARIANTS, {
      productId: productGid(parentProductId),
      variants: rows.map((r) => ({
        id: variantGid(r.parentVariantId),
        requiresComponents: false,
        inventoryItem: { tracked: r.parentTracked },
      })),
    }, shop);
    assertNoErrors(res?.data?.productVariantsBulkUpdate?.userErrors, "restore drink");

    // Stock back: parent "available" = copy's current "available"
    const stock: Parameters<typeof setStock>[1] = [];
    for (const r of rows) {
      const copy = byId.get(r.copyVariantId);
      const parent = byId.get(r.parentVariantId);
      if (!copy || !parent || !r.parentTracked) continue;
      const parentLevels = new Map(readLevels(parent.inventoryItem).map((l) => [l.locationId, l.available]));
      for (const level of readLevels(copy.inventoryItem)) {
        if (!parentLevels.has(level.locationId)) {
          await adminGraphql(ACTIVATE_STOCK, { inventoryItemId: parent.inventoryItem.id, locationId: level.locationId }, shop);
        }
        stock.push({
          inventoryItemId: parent.inventoryItem.id,
          locationId: level.locationId,
          quantity: level.available,
          changeFromQuantity: parentLevels.get(level.locationId) ?? 0,
        });
      }
    }
    await setStock(shop, stock);
  }

  // The hidden copy is no longer needed — archive (kept for past orders)
  for (const copyProductId of new Set(rows.map((r) => r.copyProductId))) {
    await adminGraphql(SET_STATUS, { product: { id: productGid(copyProductId), status: "ARCHIVED" } }, shop);
  }
  await prisma.bundleItem.deleteMany({
    where: { shopId: shop, parentVariantId: { in: rows.map((r) => r.parentVariantId) } },
  });
}

/**
 * Keep bundles of an already bundled drink right: bottles or deposit
 * amount changed → deposit quantity and price; the merchant changed the
 * visible price → it is the new price incl. deposit, so the base (copy)
 * price follows.
 */
async function reconcileDrink(
  shop: string,
  rows: Awaited<ReturnType<typeof prisma.bundleItem.findMany>>,
  units: number,
  amountMinor: number,
  depositVariantId: string,
) {
  const result = await adminGraphql(VARIANT_STOCK, { ids: rows.map((r) => variantGid(r.parentVariantId)) }, shop);
  const price = new Map<string, number>(
    (result?.data?.nodes ?? []).filter(Boolean).map((n: any) => [numericId(n.id), toMinor(n.price)]),
  );
  let changed = 0;
  for (const r of rows) {
    const current = price.get(r.parentVariantId);
    if (current === undefined) continue;
    const expectedBefore = r.basePriceMinor + amountMinor * r.depositUnits;
    // Visible price edited by the merchant → new total; derive the base
    const base = current !== expectedBefore && r.depositUnits === units
      ? current - amountMinor * r.depositUnits
      : r.basePriceMinor;
    const total = base + amountMinor * units;
    if (base === r.basePriceMinor && units === r.depositUnits && current === total) continue;

    const res = await adminGraphql(RELATIONSHIPS, {
      input: [{
        parentProductVariantId: variantGid(r.parentVariantId),
        productVariantRelationshipsToUpdate: [{ id: depositVariantId, quantity: units }],
        priceInput: { calculation: "FIXED", price: toAmount(total) },
      }],
    }, shop);
    assertNoErrors(res?.data?.productVariantRelationshipBulkUpdate?.userErrors, "update bundle");
    if (base !== r.basePriceMinor) {
      const upd = await adminGraphql(UPDATE_VARIANTS, {
        productId: productGid(r.copyProductId),
        variants: [{ id: variantGid(r.copyVariantId), price: toAmount(base) }],
      }, shop);
      assertNoErrors(upd?.data?.productVariantsBulkUpdate?.userErrors, "update bundle component price");
    }
    await prisma.bundleItem.update({
      where: { shopId_parentVariantId: { shopId: shop, parentVariantId: r.parentVariantId } },
      data: { basePriceMinor: base, depositUnits: units },
    });
    changed++;
  }
  return changed;
}

/**
 * Bring bundles in line with the deposit method and flagged drinks.
 * `onlyProductIds` limits the work (products/update webhook).
 */
export async function syncBundles(
  shop: string,
  {
    method,
    amountMinor,
    depositVariantId,
    onlyProductIds,
  }: { method: string; amountMinor: number; depositVariantId: string | null; onlyProductIds?: string[] },
) {
  const result = { bundled: 0, updated: 0, unbundled: 0, failed: [] as string[] };
  const scope = onlyProductIds ? { in: onlyProductIds } : undefined;
  const rows = await prisma.bundleItem.findMany({
    where: { shopId: shop, ...(scope ? { parentProductId: scope } : {}) },
  });
  const flagged =
    method === "bundling" && depositVariantId
      ? await prisma.depositProduct.findMany({ where: { shopId: shop, ...(scope ? { productId: scope } : {}) } })
      : [];
  if (rows.length === 0 && flagged.length === 0) return result;

  const unitsByDrink = new Map(flagged.map((f) => [f.productId, f.bottles]));
  const rowsByDrink = new Map<string, typeof rows>();
  for (const r of rows) rowsByDrink.set(r.parentProductId, [...(rowsByDrink.get(r.parentProductId) ?? []), r]);

  // Unbundle drinks that are no longer deposit drinks (or method changed)
  for (const [drinkId, drinkRows] of rowsByDrink) {
    if (unitsByDrink.has(drinkId)) continue;
    try {
      await unbundleDrink(shop, drinkRows);
      result.unbundled++;
    } catch (e) {
      result.failed.push(`${drinkId}: ${String(e)}`);
    }
  }

  // Bundle new deposit drinks, keep existing ones right
  const toBundle = flagged.filter((f) => !rowsByDrink.has(f.productId)).map((f) => f.productId);
  const drinks = await fetchDrinks(shop, toBundle);
  for (const drinkId of toBundle) {
    const drink = drinks.get(drinkId);
    if (!drink) continue;
    try {
      await bundleDrink(shop, drink, unitsByDrink.get(drinkId)!, amountMinor, depositVariantId!);
      result.bundled++;
    } catch (e) {
      result.failed.push(`${drink.title}: ${String(e)}`);
    }
  }
  for (const [drinkId, drinkRows] of rowsByDrink) {
    const units = unitsByDrink.get(drinkId);
    if (units === undefined) continue;
    try {
      result.updated += await reconcileDrink(shop, drinkRows, units, amountMinor, depositVariantId!);
    } catch (e) {
      result.failed.push(`${drinkId}: ${String(e)}`);
    }
  }
  return result;
}

// One bundle sync per shop at a time — a second request waits for the
// running one and then runs again with fresh data
const running = new Map<string, Promise<unknown>>();

/**
 * Run syncBundles in the background (bundling dozens of drinks takes a
 * few minutes) and record the outcome in the sync log.
 */
export function syncBundlesInBackground(shop: string, options: Parameters<typeof syncBundles>[1]) {
  const previous = running.get(shop) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const result = await syncBundles(shop, options);
      const total = result.bundled + result.updated + result.unbundled + result.failed.length;
      if (total === 0) return;
      await prisma.syncLog.create({
        data: {
          shopId: shop,
          operation: "sync_bundles",
          status: result.failed.length > 0 ? "error" : "success",
          message:
            `Bundles: ${result.bundled} bundled, ${result.updated} updated, ${result.unbundled} unbundled` +
            (result.failed.length > 0 ? `; failed: ${result.failed.join(" | ").slice(0, 900)}` : ""),
        },
      });
    })
    .catch((e) => {
      console.error(`[bundles] ${shop}:`, e);
      return prisma.syncLog.create({
        data: { shopId: shop, operation: "sync_bundles", status: "error", message: String(e).slice(0, 1000) },
      });
    })
    .finally(() => {
      if (running.get(shop) === next) running.delete(shop);
    });
  running.set(shop, next);
  return next;
}

/** Is a bundle sync running for this shop? (settings page notice) */
export const bundleSyncRunning = (shop: string) => running.has(shop);
