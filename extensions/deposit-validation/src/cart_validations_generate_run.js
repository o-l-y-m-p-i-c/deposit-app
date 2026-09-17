// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * Cart Validation Function: Bottle Deposit (separate-line mode)
 *
 * Enforces that the deposit product line always matches the number of
 * deposit-eligible bottles in the cart. Blocks checkout when:
 *   - the deposit line is missing while eligible products are present
 *   - the deposit quantity was changed by the customer
 *   - the deposit product was added manually with no eligible products
 *
 * Configuration JSON shape (stored in the Validation owner metafield
 * $app:deposit -> function-configuration):
 * {
 *   "enabled": true,
 *   "mode": "line",
 *   "depositVariantId": "gid://shopify/ProductVariant/xxx",
 *   "includeTags": [...],
 *   "includeCollectionIds": [...],
 *   "excludeTags": [...],
 *   "excludeCollectionIds": [...]
 * }
 */

/**
 * @type {CartValidationsGenerateRunResult}
 */
const NO_ERRORS = {
  operations: [],
};

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const configMetafield = input?.validation?.metafield;
  if (!configMetafield?.value) {
    return NO_ERRORS;
  }

  /** @type {any} */
  let config;
  try {
    config = JSON.parse(configMetafield.value);
  } catch {
    return NO_ERRORS;
  }

  if (!config.enabled || config.mode !== "line" || !config.depositVariantId) {
    return NO_ERRORS;
  }

  let expected = 0;
  let depositQty = 0;

  for (const line of input.cart.lines) {
    const merchandise = /** @type {any} */ (line.merchandise);
    if (merchandise.__typename !== "ProductVariant") {
      continue;
    }

    if (merchandise.id === config.depositVariantId) {
      depositQty += line.quantity;
      continue;
    }

    const product = merchandise.product;
    if (!product) continue;

    const included = product.hasIncludedTag || product.inIncludedCollection;
    const excluded = product.hasExcludedTag || product.inExcludedCollection;

    if (included && !excluded) {
      expected += line.quantity;
    }
  }

  if (depositQty === expected) {
    return NO_ERRORS;
  }

  const message =
    expected > 0
      ? "The bottle deposit is required and its quantity is managed automatically. Return to the cart and try again."
      : "The deposit product can't be purchased on its own.";

  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              message,
              target: "$.cart",
            },
          ],
        },
      },
    ],
  };
}
