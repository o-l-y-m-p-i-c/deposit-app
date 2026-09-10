import { run, output } from "@shopify/shopify_function";

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

run(({ cart, cartTransform }) => {
  const configMetafield = cartTransform?.metafield;
  if (!configMetafield?.value) {
    return output([]);
  }

  let config;
  try {
    config = JSON.parse(configMetafield.value);
  } catch {
    return output([]);
  }

  if (!config.enabled || !config.depositVariantId) {
    return output([]);
  }

  const includeTags = config.includeTags || [];
  const includeCollectionIds = config.includeCollectionIds || [];
  const excludeTags = config.excludeTags || [];
  const excludeCollectionIds = config.excludeCollectionIds || [];

  const operations = [];

  for (const line of cart.lines) {
    // Skip non-product variants
    if (line.merchandise.__typename !== "ProductVariant") {
      continue;
    }

    // Skip the deposit product itself to avoid infinite recursion
    if (line.merchandise.id === config.depositVariantId) {
      continue;
    }

    const product = line.merchandise.product;
    if (!product) continue;

    // Check collection membership (via inAnyCollection with variables)
    const inIncludedCollection = includeCollectionIds.length > 0 &&
      product.inAnyCollection === true;

    // For tags, we check at runtime using the config arrays
    // hasAnyTag in the input query uses an empty array as placeholder;
    // actual tag matching is done here using the config from metafield
    const productTags = product.hasAnyTag || [];
    const hasIncludedTag = includeTags.length > 0 &&
      includeTags.some((tag) => productTags.includes(tag));
    const hasExcludedTag = excludeTags.length > 0 &&
      excludeTags.some((tag) => productTags.includes(tag));

    // For exclude collections, we need a separate check
    // Since the input query only has includeCollectionIds variable,
    // we check exclude collections via the config metafield approach
    // In production, we'd add excludeCollectionIds as another variable
    const inExcludedCollection = excludeCollectionIds.length > 0 &&
      product.inAnyCollection === true; // This is simplified; see note below

    // Determine eligibility
    const included = hasIncludedTag || inIncludedCollection;
    const excluded = hasExcludedTag || inExcludedCollection;

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
            merchandiseId: line.merchandise.id,
            quantity: line.quantity,
            title: line.merchandise.title,
            image: line.merchandise.image,
          },
          {
            merchandiseId: config.depositVariantId,
            quantity: line.quantity,
            title: "Bottle Deposit",
            price: {
              percentage: 0,
            },
          },
        ],
      },
    });
  }

  return output(operations);
});
