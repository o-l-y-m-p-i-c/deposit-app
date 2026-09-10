// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * Cart Transform Function: Bottle Deposit
 *
 * Reads configuration from the Cart Transform owner metafield
 * ($app:deposit -> function-configuration) and expands eligible
 * cart lines to include a deposit component.
 *
 * Configuration JSON shape (stored in metafield):
 * {
 *   "enabled": true,
 *   "amountMinor": 10,
 *   "currencyCode": "EUR",
 *   "depositVariantId": "gid://shopify/ProductVariant/xxx",
 *   "includeTags": ["water", "bottle"],
 *   "includeCollectionIds": ["gid://shopify/Collection/xxx"],
 *   "excludeTags": ["19l-bottle"],
 *   "excludeCollectionIds": ["gid://shopify/Collection/yyy"]
 * }
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const configMetafield = input?.cartTransform?.metafield;
  if (!configMetafield?.value) {
    return NO_CHANGES;
  }

  /** @type {any} */
  let config;
  try {
    config = JSON.parse(configMetafield.value);
  } catch {
    return NO_CHANGES;
  }

  if (!config.enabled || !config.depositVariantId) {
    return NO_CHANGES;
  }

  /** @type {any[]} */
  const operations = [];

  for (const line of input.cart.lines) {
    // Skip non-product variants
    if (line.merchandise.__typename !== "ProductVariant") {
      continue;
    }

    /** @type {any} */
    const variant = line.merchandise;

    // Skip the deposit product itself to avoid infinite recursion
    if (variant.id === config.depositVariantId) {
      continue;
    }

    const product = variant.product;
    if (!product) continue;

    // Check tags and collections using values loaded from the owner metafield.
    // Each aliased field is evaluated independently by Shopify's input query.
    // Missing or empty rule arrays evaluate to false.
    // Exclusion fields remain separate from inclusion fields.
    const included = product.hasIncludedTag || product.inIncludedCollection;
    const excluded = product.hasExcludedTag || product.inExcludedCollection;

    // Exclusions always win
    if (!included || excluded) {
      continue;
    }

    // Expand the line: original product + deposit component
    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: variant.id,
            quantity: 1,
          },
          {
            merchandiseId: config.depositVariantId,
            quantity: 1,
          },
        ],
      },
    });
  }

  return { operations };
}
