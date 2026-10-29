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
 * Eligibility is not evaluated here: the app's server-side sync writes
 * $app:deposit.bottles (deposit units per product unit) onto each
 * eligible product. No metafield = no deposit.
 *
 * Configuration JSON shape (stored in metafield):
 * {
 *   "enabled": true,
 *   "amountMinor": 10,
 *   "currencyCode": "EUR",
 *   "depositVariantId": "gid://shopify/ProductVariant/xxx",
 *   "titleSuffix": "(incl. deposit)"   // optional
 * }
 *
 * mode: "expand" = bundle the deposit as a line component (this function).
 *       Anything else (the retired "line" mode, or a missing value) is a
 *       no-op so a stale config can never double-charge.
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

  const amountMinor = Number(config.amountMinor);
  const presentmentCurrencyRate = Number(input.presentmentCurrencyRate);
  if (
    !config.enabled ||
    config.mode !== "expand" ||
    !config.depositVariantId ||
    !Number.isFinite(amountMinor) ||
    !Number.isFinite(presentmentCurrencyRate)
  ) {
    return NO_CHANGES;
  }
  const depositAmount = ((amountMinor / 100) * presentmentCurrencyRate).toFixed(2);
  const titleSuffix =
    typeof config.titleSuffix === "string" ? config.titleSuffix : "(incl. deposit)";

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

    // Rules (exclusions win) were applied by the eligibility sync
    const bottles = parseInt(product.bottles?.value ?? "", 10);
    if (!(bottles > 0)) {
      continue;
    }

    // Cart line title tells the customer the price includes the deposit
    const variantTitle =
      variant.title && variant.title !== "Default Title" ? ` - ${variant.title}` : "";
    const title = [`${product.title}${variantTitle}`, titleSuffix]
      .filter(Boolean)
      .join(" ");

    // Expand the line: original product + deposit component
    operations.push({
      lineExpand: {
        cartLineId: line.id,
        title,
        expandedCartItems: [
          {
            merchandiseId: variant.id,
            quantity: 1,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: line.cost.amountPerQuantity.amount,
                },
              },
            },
          },
          {
            merchandiseId: config.depositVariantId,
            quantity: bottles,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: depositAmount,
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
