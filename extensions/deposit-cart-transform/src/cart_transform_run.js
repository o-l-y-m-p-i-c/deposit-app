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

  const includeTags = config.includeTags || [];
  const includeCollectionIds = config.includeCollectionIds || [];
  const excludeTags = config.excludeTags || [];
  const excludeCollectionIds = config.excludeCollectionIds || [];

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

    // Check tags and collections
    // Note: hasAnyTag and inAnyCollection use empty arrays in the input query
    // because the actual tag/collection lists come from the config metafield.
    // In production, we'd use GraphQL variables for the config values.
    const hasIncludedTag = includeTags.length > 0 && product.hasAnyTag === true;
    const inIncludedCollection = includeCollectionIds.length > 0 && product.inAnyCollection === true;
    const hasExcludedTag = excludeTags.length > 0 && product.hasAnyTag === true;
    const inExcludedCollection = excludeCollectionIds.length > 0 && product.inAnyCollection === true;

    // Determine eligibility
    const included = hasIncludedTag || inIncludedCollection;
    const excluded = hasExcludedTag || inExcludedCollection;

    // Exclusions always win
    if (!included || excluded) {
      continue;
    }

    // Expand the line: original product + deposit component
    operations.push({
      expand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: variant.id,
            quantity: line.quantity,
          },
          {
            merchandiseId: config.depositVariantId,
            quantity: line.quantity,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: (config.amountMinor / 100).toFixed(2),
                },
              },
            },
          },
        ],
      },
    });
  }

  return { operations };
}
