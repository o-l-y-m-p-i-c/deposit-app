/**
 * Per-drink deposits — the "per_product" deposit style.
 *
 * One "Bottle Deposit" product holds a variant per eligible drink (option
 * "Drink" = the drink's title), priced at the deposit amount × the
 * drink's bottles. The catalog gets a single product, and the cart shows
 * "Bottle Deposit — Drink: <title>" for each drink's deposit line.
 *
 * It is a separate product from the shared deposit (style "shared"), so
 * switching styles never changes the shared deposit variant. The drink
 * stores its deposit variant in the $app:deposit.deposit_variant
 * metafield, read by the checkout Function, Liquid and the storefront
 * script (via the app proxy).
 *
 * Earlier versions created a "Deposit – <drink>" product per drink. Those
 * are left untouched; drinks are simply re-linked to variants here.
 */

import { prisma } from "~/db.server";
import {
  adminGraphql,
  GET_PUBLICATIONS,
  PUBLISH_PRODUCT,
  SET_METAFIELDS,
} from "~/lib/admin-api.server";
import { DEPOSIT_NAMESPACE } from "~/lib/eligibility.server";

/**
 * Tag on the per-drink deposit product (and the retired per-drink
 * products) — the checkout Function reads it to recognise deposit lines.
 */
export const DEPOSIT_ITEM_TAG = "bottle-deposit-item";
/** Tag identifying the one product that holds the per-drink variants. */
const DEPOSIT_VARIANTS_TAG = "bottle-deposit-variants";
export const DEPOSIT_VARIANT_KEY = "deposit_variant";
const OPTION_NAME = "Drink";
const PRODUCT_TITLE = "Bottle Deposit";

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

const FIND_VARIANTS_PRODUCT = /* GraphQL */ `#graphql
  query DepositVariantsProduct($query: String!) {
    products(first: 1, query: $query) {
      nodes { id status variants(first: 250) { nodes { id } } }
    }
  }
`;

const CREATE_VARIANTS_PRODUCT = /* GraphQL */ `#graphql
  mutation DepositVariantsProductCreate($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product { id variants(first: 1) { nodes { id } } }
      userErrors { field message code }
    }
  }
`;

const SET_PRODUCT_STATUS = /* GraphQL */ `#graphql
  mutation DepositVariantsProductStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      userErrors { field message }
    }
  }
`;

const BULK_CREATE = /* GraphQL */ `#graphql
  mutation DepositVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id selectedOptions { name value } }
      userErrors { field message }
    }
  }
`;

const BULK_UPDATE = /* GraphQL */ `#graphql
  mutation DepositVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

const BULK_DELETE = /* GraphQL */ `#graphql
  mutation DepositVariantsDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      userErrors { field message }
    }
  }
`;

const CREATE_LINK_DEFINITION = /* GraphQL */ `#graphql
  mutation DepositVariantLinkDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
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

function assertNoErrors(errors: unknown, what: string) {
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Failed to ${what}: ${JSON.stringify(errors)}`);
  }
}

/**
 * Storefront read access for the drink → deposit variant link, so the
 * theme (Liquid) can pass it to the storefront script. Without it the
 * script can't tell which deposit variant belongs to a drink.
 */
async function ensureLinkDefinition(shop: string) {
  const result = await adminGraphql(CREATE_LINK_DEFINITION, {
    definition: {
      name: "Deposit product variant",
      description: "This drink's own deposit variant (managed by the Bottle Deposit app)",
      namespace: DEPOSIT_NAMESPACE,
      key: DEPOSIT_VARIANT_KEY,
      type: "number_integer",
      ownerType: "PRODUCT",
      access: { storefront: "PUBLIC_READ" },
    },
  }, shop);
  const errors: { code?: string; message: string }[] =
    result?.data?.metafieldDefinitionCreate?.userErrors ?? [];
  assertNoErrors(errors.filter((e) => e.code !== "TAKEN"), "create deposit link definition");
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

/** Option values must be unique — number repeated drink titles. */
function uniqueOptionNames(drinks: { productId: string; title: string }[]) {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const d of drinks) {
    const count = (seen.get(d.title) ?? 0) + 1;
    seen.set(d.title, count);
    names.set(d.productId, count === 1 ? d.title : `${d.title} (${count})`);
  }
  return names;
}

const variantInput = (name: string, priceMinor: number, drinkId: string) => ({
  optionValues: [{ optionName: OPTION_NAME, name }],
  price: (priceMinor / 100).toFixed(2),
  taxable: false,
  inventoryItem: { sku: `DEPOSIT-${drinkId}`, tracked: false, requiresShipping: false },
});

async function publish(shop: string, productId: string) {
  const result = await adminGraphql(GET_PUBLICATIONS, {}, shop);
  const pub = (result?.data?.publications?.nodes ?? []).find(
    (p: { name?: string }) => p.name === "Online Store",
  );
  if (!pub?.id) throw new Error("Online Store publication not found");
  await adminGraphql(PUBLISH_PRODUCT, { id: productGid(productId), input: [{ publicationId: pub.id }] }, shop);
}

/**
 * The product holding the per-drink variants: found by tag, or created
 * with the first drink's variant. Returns its ID, its variant IDs, and
 * the variant created for `first` when it had to be created.
 */
async function getVariantsProduct(
  shop: string,
  first: { name: string; priceMinor: number; drinkId: string } | null,
) {
  const found = await adminGraphql(FIND_VARIANTS_PRODUCT, { query: `tag:${DEPOSIT_VARIANTS_TAG}` }, shop);
  const node = found?.data?.products?.nodes?.[0];
  if (node?.id) {
    if (node.status !== "ACTIVE") {
      await adminGraphql(SET_PRODUCT_STATUS, { product: { id: node.id, status: "ACTIVE" } }, shop);
    }
    return {
      productId: numericId(node.id),
      variantIds: new Set<string>((node.variants?.nodes ?? []).map((v: { id: string }) => numericId(v.id))),
      createdVariantId: null as string | null,
    };
  }
  if (!first) return null;

  const result = await adminGraphql(CREATE_VARIANTS_PRODUCT, {
    input: {
      title: PRODUCT_TITLE,
      productType: "Deposit",
      vendor: "Bottle Deposit App",
      status: "ACTIVE",
      tags: ["deposit", DEPOSIT_ITEM_TAG, DEPOSIT_VARIANTS_TAG],
      productOptions: [{ name: OPTION_NAME, values: [{ name: first.name }] }],
      // productSet takes sku on the variant (bulk mutations: inventoryItem)
      variants: [
        {
          optionValues: [{ optionName: OPTION_NAME, name: first.name }],
          price: (first.priceMinor / 100).toFixed(2),
          taxable: false,
          sku: `DEPOSIT-${first.drinkId}`,
          inventoryItem: { tracked: false, requiresShipping: false },
        },
      ],
    },
  }, shop);
  const payload = result?.data?.productSet;
  assertNoErrors(payload?.userErrors, "create deposit product");
  const productId = numericId(payload.product.id);
  const createdVariantId = numericId(payload.product.variants.nodes[0].id);
  await publish(shop, productId);
  return { productId, variantIds: new Set([createdVariantId]), createdVariantId };
}

/**
 * Bring the per-drink deposit variants in line with the deposit style
 * and the flagged drinks (DepositProduct):
 *   - a variant per flagged drink, named after it and priced for its
 *     bottles; renamed/repriced when the drink changes
 *   - variants of drinks that lost their deposit are deleted
 *   - in the "shared" style the product is archived (variants kept, so
 *     switching back reuses them) and the drink links are removed
 * `onlyProductIds` limits the work to some drinks (products/update
 * webhook); `force` rewrites every link.
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
  const result = { created: 0, updated: 0, archived: 0 };
  const scope = onlyProductIds ? { in: onlyProductIds } : undefined;
  const items = await prisma.depositItem.findMany({
    where: { shopId: shop, ...(scope ? { sourceProductId: scope } : {}) },
  });

  if (style !== "per_product") {
    const active = items.filter((i) => i.active);
    if (active.length === 0) return result;
    await removeLinks(shop, active.map((i) => i.sourceProductId));
    await prisma.depositItem.updateMany({
      where: { shopId: shop, sourceProductId: { in: active.map((i) => i.sourceProductId) } },
      data: { active: false },
    });
    if (!onlyProductIds) {
      const product = await getVariantsProduct(shop, null);
      if (product) {
        await adminGraphql(SET_PRODUCT_STATUS, {
          product: { id: productGid(product.productId), status: "ARCHIVED" },
        }, shop);
      }
    }
    result.archived = active.length;
    return result;
  }

  if (!onlyProductIds) await ensureLinkDefinition(shop);

  const flagged = await prisma.depositProduct.findMany({
    where: { shopId: shop, ...(scope ? { productId: scope } : {}) },
  });
  const titles = await fetchTitles(shop, flagged.map((f) => f.productId));
  const drinks = flagged
    .filter((f) => titles.has(f.productId))
    .map((f) => ({ productId: f.productId, title: titles.get(f.productId)!, bottles: f.bottles }));

  // Option names must be unique across the whole product
  const allTitled = onlyProductIds
    ? [
        ...(await prisma.depositItem.findMany({
          where: { shopId: shop, active: true, sourceProductId: { notIn: onlyProductIds } },
        })).map((i) => ({ productId: i.sourceProductId, title: i.title })),
        ...drinks,
      ]
    : drinks;
  // Nothing to create, update or remove (most product webhooks)
  if (drinks.length === 0 && items.length === 0) return result;
  const optionName = uniqueOptionNames(allTitled);
  const itemBySource = new Map(items.map((i) => [i.sourceProductId, i]));

  const first = drinks[0];
  const product = await getVariantsProduct(
    shop,
    first
      ? { name: optionName.get(first.productId)!, priceMinor: amountMinor * first.bottles, drinkId: first.productId }
      : null,
  );
  if (!product) return result;

  const toCreate: typeof drinks = [];
  const toUpdate: { drink: (typeof drinks)[number]; variantId: string }[] = [];
  const links: { drinkId: string; variantId: string }[] = [];
  const rows: { drinkId: string; variantId: string; title: string; priceMinor: number }[] = [];

  for (const drink of drinks) {
    const name = optionName.get(drink.productId)!;
    const priceMinor = amountMinor * drink.bottles;
    const existing = itemBySource.get(drink.productId);
    // Its variant on this product (not a retired per-drink product)
    const ownVariant =
      existing && existing.productId === product.productId && product.variantIds.has(existing.variantId)
        ? existing.variantId
        : null;

    if (first && drink.productId === first.productId && product.createdVariantId) {
      rows.push({ drinkId: drink.productId, variantId: product.createdVariantId, title: name, priceMinor });
      links.push({ drinkId: drink.productId, variantId: product.createdVariantId });
      result.created++;
    } else if (!ownVariant) {
      toCreate.push(drink);
    } else if (!existing!.active || existing!.title !== name || existing!.priceMinor !== priceMinor) {
      toUpdate.push({ drink, variantId: ownVariant });
    } else if (force) {
      links.push({ drinkId: drink.productId, variantId: ownVariant });
    }
  }

  for (const batch of chunk(toCreate, 50)) {
    const res = await adminGraphql(BULK_CREATE, {
      productId: productGid(product.productId),
      variants: batch.map((d) =>
        variantInput(optionName.get(d.productId)!, amountMinor * d.bottles, d.productId),
      ),
    }, shop);
    const payload = res?.data?.productVariantsBulkCreate;
    assertNoErrors(payload?.userErrors, "create deposit variants");
    const byName = new Map<string, string>(
      (payload?.productVariants ?? []).map((v: { id: string; selectedOptions: { name: string; value: string }[] }) => [
        v.selectedOptions.find((o) => o.name === OPTION_NAME)?.value ?? "",
        numericId(v.id),
      ]),
    );
    for (const d of batch) {
      const name = optionName.get(d.productId)!;
      const variantId = byName.get(name);
      if (!variantId) throw new Error(`Deposit variant for "${name}" was not created`);
      rows.push({ drinkId: d.productId, variantId, title: name, priceMinor: amountMinor * d.bottles });
      links.push({ drinkId: d.productId, variantId });
      result.created++;
    }
  }

  for (const batch of chunk(toUpdate, 50)) {
    const res = await adminGraphql(BULK_UPDATE, {
      productId: productGid(product.productId),
      variants: batch.map(({ drink, variantId }) => ({
        id: variantGid(variantId),
        ...variantInput(optionName.get(drink.productId)!, amountMinor * drink.bottles, drink.productId),
      })),
    }, shop);
    assertNoErrors(res?.data?.productVariantsBulkUpdate?.userErrors, "update deposit variants");
    for (const { drink, variantId } of batch) {
      rows.push({
        drinkId: drink.productId,
        variantId,
        title: optionName.get(drink.productId)!,
        priceMinor: amountMinor * drink.bottles,
      });
      links.push({ drinkId: drink.productId, variantId });
      result.updated++;
    }
  }

  for (const row of rows) {
    const data = {
      productId: product.productId,
      variantId: row.variantId,
      title: row.title,
      priceMinor: row.priceMinor,
      active: true,
    };
    await prisma.depositItem.upsert({
      where: { shopId_sourceProductId: { shopId: shop, sourceProductId: row.drinkId } },
      create: { shopId: shop, sourceProductId: row.drinkId, ...data },
      update: data,
    });
  }

  // Link each drink to its deposit variant (checkout Function, Liquid, proxy)
  for (const batch of chunk(links, 25)) {
    const res = await adminGraphql(SET_METAFIELDS, {
      metafields: batch.map((l) => ({
        ownerId: productGid(l.drinkId),
        namespace: DEPOSIT_NAMESPACE,
        key: DEPOSIT_VARIANT_KEY,
        type: "number_integer",
        value: l.variantId,
      })),
    }, shop);
    assertNoErrors(res?.data?.metafieldsSet?.userErrors, "link deposit variants");
  }

  // Drinks that lost their deposit: unlink and delete their variants
  // (past orders keep their line items)
  const wanted = new Set(drinks.map((d) => d.productId));
  const stale = items.filter((i) => i.active && !wanted.has(i.sourceProductId));
  if (stale.length > 0) {
    await removeLinks(shop, stale.map((i) => i.sourceProductId));
    const ownVariants = stale
      .filter((i) => i.productId === product.productId && product.variantIds.has(i.variantId))
      .map((i) => variantGid(i.variantId));
    // A product can't lose its last variant — keep one, unlinked
    const variantsAfter = product.variantIds.size + toCreate.length;
    const deletable = variantsAfter - ownVariants.length >= 1 ? ownVariants : ownVariants.slice(1);
    for (const batch of chunk(deletable, 50)) {
      const res = await adminGraphql(BULK_DELETE, {
        productId: productGid(product.productId),
        variantsIds: batch,
      }, shop);
      assertNoErrors(res?.data?.productVariantsBulkDelete?.userErrors, "delete deposit variants");
    }
    await prisma.depositItem.deleteMany({
      where: { shopId: shop, sourceProductId: { in: stale.map((i) => i.sourceProductId) } },
    });
    result.archived += stale.length;
  }

  return result;
}

/** Remove drink → deposit variant links (the drink may be gone already). */
async function removeLinks(shop: string, drinkIds: string[]) {
  for (const batch of chunk(drinkIds, 25)) {
    await adminGraphql(DELETE_DEPOSIT_VARIANT_LINK, {
      metafields: batch.map((id) => ({
        ownerId: productGid(id),
        namespace: DEPOSIT_NAMESPACE,
        key: DEPOSIT_VARIANT_KEY,
      })),
    }, shop).catch(() => {});
  }
}

const TAGGED_PRODUCT_IDS = /* GraphQL */ `#graphql
  query DepositTaggedProducts($query: String!, $after: String) {
    products(first: 250, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

/**
 * Numeric IDs of every deposit product — the per-drink variants product,
 * the retired "Deposit – <drink>" products (tag bottle-deposit-item) and
 * hidden bundle components (tag bottle-deposit-component). They never
 * carry a deposit themselves.
 */
export async function depositItemProductIds(shop: string) {
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const result = await adminGraphql(TAGGED_PRODUCT_IDS, {
      query: `tag:${DEPOSIT_ITEM_TAG} OR tag:bottle-deposit-component`,
      after,
    }, shop);
    const page = result?.data?.products;
    for (const node of page?.nodes ?? []) ids.add(numericId(node.id));
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return [...ids];
}
