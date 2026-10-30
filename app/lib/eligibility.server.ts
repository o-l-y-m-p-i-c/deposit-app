/**
 * Server-side deposit eligibility — the single source of truth.
 *
 * Rules (include/exclude by tag or collection) are evaluated here once
 * and written to each eligible product as the app-owned metafield
 * $app:deposit.bottles (deposit units per product unit). Functions,
 * Liquid and the storefront script all read that result instead of
 * re-evaluating the rules themselves.
 *
 * The DepositProduct table mirrors the metafield so syncs only write
 * the difference and the storefront app proxy can answer from the DB.
 */

import { prisma } from "~/db.server";
import { adminGraphql } from "~/lib/admin-api.server";

export const DEPOSIT_NAMESPACE = "$app:deposit";
export const BOTTLES_KEY = "bottles";

// metafieldsSet / metafieldsDelete accept up to 25 entries per call
const WRITE_BATCH = 25;

export type GroupedRules = {
  includeTags: { value: string }[];
  includeCollections: { resourceId: string | null }[];
  excludeTags: { value: string }[];
  excludeCollections: { resourceId: string | null }[];
};

const PRODUCT_IDS_BY_QUERY = /* GraphQL */ `#graphql
  query DepositProductIdsByQuery($query: String!, $after: String) {
    products(first: 250, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

const COLLECTION_PRODUCT_IDS = /* GraphQL */ `#graphql
  query DepositCollectionProductIds($id: ID!, $after: String) {
    collection(id: $id) {
      products(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const PRODUCT_RULE_FIELDS = /* GraphQL */ `#graphql
  query DepositProductRuleFields($id: ID!) {
    product(id: $id) {
      id
      tags
      collections(first: 250) { nodes { id } }
    }
  }
`;

const SET_BOTTLES = /* GraphQL */ `#graphql
  mutation DepositSetBottles($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

const DELETE_BOTTLES = /* GraphQL */ `#graphql
  mutation DepositDeleteBottles($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

const CREATE_BOTTLES_DEFINITION = /* GraphQL */ `#graphql
  mutation DepositBottlesDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const toNumericId = (gid: string) => gid.split("/").pop() || gid;
const toProductGid = (id: string) => `gid://shopify/Product/${id}`;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Create the metafield definition once per shop. Storefront read access
 * lets Liquid (theme app extension) render the deposit without JS.
 */
export async function ensureBottlesDefinition(shop: string) {
  const result = await adminGraphql(CREATE_BOTTLES_DEFINITION, {
    definition: {
      name: "Bottle deposit units",
      description: "Deposit units charged per unit of this product (managed by the Bottle Deposit app)",
      namespace: DEPOSIT_NAMESPACE,
      key: BOTTLES_KEY,
      type: "number_integer",
      ownerType: "PRODUCT",
      access: { storefront: "PUBLIC_READ" },
    },
  }, shop);
  const errors: { code?: string; message: string }[] =
    result?.data?.metafieldDefinitionCreate?.userErrors ?? [];
  const real = errors.filter((e) => e.code !== "TAKEN");
  if (real.length > 0) {
    throw new Error(`Failed to create metafield definition: ${JSON.stringify(real)}`);
  }
}

/** Paginate a products search and return numeric product IDs. */
async function productIdsForQuery(shop: string, query: string) {
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const result = await adminGraphql(PRODUCT_IDS_BY_QUERY, { query, after }, shop);
    const page = result?.data?.products;
    for (const node of page?.nodes ?? []) ids.add(toNumericId(node.id));
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

/** Paginate a collection's products and return numeric product IDs. */
async function productIdsInCollection(shop: string, collectionId: string) {
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const result = await adminGraphql(COLLECTION_PRODUCT_IDS, { id: collectionId, after }, shop);
    const page = result?.data?.collection?.products;
    for (const node of page?.nodes ?? []) ids.add(toNumericId(node.id));
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

/** Search-syntax tag filter; quotes and backslashes escaped. */
const tagQuery = (tag: string) => `tag:"${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function matchingIds(
  shop: string,
  tags: { value: string }[],
  collections: { resourceId: string | null }[],
) {
  const ids = new Set<string>();
  for (const { value } of tags) {
    (await productIdsForQuery(shop, tagQuery(value))).forEach((id) => ids.add(id));
  }
  for (const { resourceId } of collections) {
    if (!resourceId) continue;
    (await productIdsInCollection(shop, resourceId)).forEach((id) => ids.add(id));
  }
  return ids;
}

/**
 * Evaluate the rules against the catalog:
 *   eligible = (tag OR collection include) AND NOT (tag OR collection exclude)
 * Uses search/collection queries, so cost scales with matching products,
 * not with the whole catalog.
 */
export async function computeEligibleProductIds(shop: string, rules: GroupedRules) {
  const included = await matchingIds(shop, rules.includeTags, rules.includeCollections);
  if (included.size === 0) return included;
  const excluded = await matchingIds(shop, rules.excludeTags, rules.excludeCollections);
  excluded.forEach((id) => included.delete(id));
  return included;
}

/** Write the metafield (bottles = 1) and mirror rows for these products. */
async function flagProducts(shop: string, productIds: string[]) {
  for (const batch of chunk(productIds, WRITE_BATCH)) {
    const result = await adminGraphql(SET_BOTTLES, {
      metafields: batch.map((id) => ({
        ownerId: toProductGid(id),
        namespace: DEPOSIT_NAMESPACE,
        key: BOTTLES_KEY,
        type: "number_integer",
        value: "1",
      })),
    }, shop);
    const errors = result?.data?.metafieldsSet?.userErrors;
    if (errors?.length > 0) {
      throw new Error(`Failed to set deposit metafields: ${JSON.stringify(errors)}`);
    }
    await prisma.depositProduct.createMany({
      data: batch.map((productId) => ({ shopId: shop, productId, bottles: 1 })),
      skipDuplicates: true,
    });
  }
}

/** Delete the metafield and mirror rows for these products. */
async function unflagProducts(shop: string, productIds: string[]) {
  for (const batch of chunk(productIds, WRITE_BATCH)) {
    const result = await adminGraphql(DELETE_BOTTLES, {
      metafields: batch.map((id) => ({
        ownerId: toProductGid(id),
        namespace: DEPOSIT_NAMESPACE,
        key: BOTTLES_KEY,
      })),
    }, shop);
    const errors = result?.data?.metafieldsDelete?.userErrors;
    if (errors?.length > 0) {
      throw new Error(`Failed to delete deposit metafields: ${JSON.stringify(errors)}`);
    }
    await prisma.depositProduct.deleteMany({
      where: { shopId: shop, productId: { in: batch } },
    });
  }
}

/**
 * Bring every product's deposit metafield in line with the rules.
 * Writes only the difference against the DepositProduct mirror;
 * `force` rewrites all eligible products (repairs manual edits).
 */
export async function syncEligibility(
  shop: string,
  rules: GroupedRules,
  {
    force = false,
    skipProductIds = [],
  }: { force?: boolean; skipProductIds?: string[] } = {},
) {
  await ensureBottlesDefinition(shop);
  const eligible = await computeEligibleProductIds(shop, rules);
  // Never flag the deposit product itself (e.g. an "All" collection rule)
  skipProductIds.forEach((gid) => eligible.delete(toNumericId(gid)));
  const current = await prisma.depositProduct.findMany({
    where: { shopId: shop },
    select: { productId: true },
  });
  const currentIds = new Set(current.map((r) => r.productId));

  const toFlag = [...eligible].filter((id) => force || !currentIds.has(id));
  const toUnflag = [...currentIds].filter((id) => !eligible.has(id));

  await flagProducts(shop, toFlag);
  await unflagProducts(shop, toUnflag);

  return { total: eligible.size, flagged: toFlag.length, unflagged: toUnflag.length };
}

/**
 * Re-evaluate one product (products/update webhook). No-op when the
 * result is unchanged — our own metafield writes also fire
 * products/update, so this must not write again.
 */
export async function recomputeProduct(shop: string, productGid: string, rules: GroupedRules) {
  const productId = toNumericId(productGid);
  const result = await adminGraphql(PRODUCT_RULE_FIELDS, { id: productGid }, shop);
  const product = result?.data?.product;

  let eligible = false;
  // Deposit products (tagged by the app) never carry a deposit themselves
  const isDepositProduct = (product?.tags ?? []).some((t: string) =>
    ["bottle-deposit", "bottle-deposit-item", "bottle-deposit-component"].includes(t.toLowerCase()),
  );
  if (product && !isDepositProduct) {
    const tags = new Set<string>((product.tags ?? []).map((t: string) => t.toLowerCase()));
    const collections = new Set<string>(
      (product.collections?.nodes ?? []).map((c: { id: string }) => c.id),
    );
    const matches = (
      tagRules: { value: string }[],
      collectionRules: { resourceId: string | null }[],
    ) =>
      tagRules.some((r) => tags.has(r.value.toLowerCase())) ||
      collectionRules.some((r) => !!r.resourceId && collections.has(r.resourceId));
    eligible =
      matches(rules.includeTags, rules.includeCollections) &&
      !matches(rules.excludeTags, rules.excludeCollections);
  }

  const row = await prisma.depositProduct.findUnique({
    where: { shopId_productId: { shopId: shop, productId } },
  });
  if (eligible && !row) await flagProducts(shop, [productId]);
  if (!eligible && row) {
    if (product) {
      await unflagProducts(shop, [productId]);
    } else {
      // Product deleted — its metafields went with it
      await prisma.depositProduct.delete({
        where: { shopId_productId: { shopId: shop, productId } },
      });
    }
  }
  return eligible;
}
