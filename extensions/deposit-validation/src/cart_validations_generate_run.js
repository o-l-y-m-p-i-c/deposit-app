// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * Cart Validation Function: Bottle Deposit (separate-line mode)
 *
 * Enforces that the deposit product line always matches the number of
 * deposit-eligible bottles in the cart. Only runs at checkout steps —
 * on CART_INTERACTION an error would reject the cart mutation itself
 * and deadlock the storefront script (can't add water without the
 * deposit line, can't add the deposit without water). Blocks checkout when:
 *   - the deposit line is missing while eligible products are present
 *   - the deposit quantity was changed by the customer
 *   - the deposit product was added manually with no eligible products
 *
 * Eligibility comes from each product's $app:deposit.bottles metafield
 * (deposit units per product unit), written by the app's server-side
 * sync — the same data the storefront script reads via the app proxy.
 *
 * Two deposit styles:
 *   "shared"      — one deposit product (depositVariantId); a drink needs
 *                   quantity × bottles of it
 *   "per_product" — each drink has its own deposit variant ("Drink: <title>")
 *                   ($app:deposit.deposit_variant, priced per unit incl.
 *                   all bottles); a drink needs quantity of it
 * Lines are compared per deposit variant.
 *
 * Configuration JSON shape (stored in the Validation owner metafield
 * $app:deposit -> function-configuration):
 * {
 *   "enabled": true,
 *   "mode": "line",
 *   "style": "shared" | "per_product",
 *   "depositVariantId": "gid://shopify/ProductVariant/xxx"
 * }
 */

/**
 * @type {CartValidationsGenerateRunResult}
 */
const NO_ERRORS = {
  operations: [],
};

/** Buyer journey steps where the deposit line is enforced. */
const ENFORCED_STEPS = ["CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"];

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  // Cart edits (and an unknown step) pass — the storefront script keeps
  // the deposit line in sync there; checkout is where it must hold
  const step = input?.buyerJourney?.step;
  if (!step || !ENFORCED_STEPS.includes(step)) {
    return NO_ERRORS;
  }

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

  const perProduct = config.style === "per_product";
  /** @type {Map<string, number>} deposit variant -> required quantity */
  const expected = new Map();
  /** @type {Map<string, number>} deposit variant -> quantity in the cart */
  const actual = new Map();
  const add = (/** @type {Map<string, number>} */ map, /** @type {string} */ id, /** @type {number} */ qty) =>
    map.set(id, (map.get(id) || 0) + qty);

  for (const line of input.cart.lines) {
    const merchandise = /** @type {any} */ (line.merchandise);
    if (merchandise.__typename !== "ProductVariant") {
      continue;
    }

    const product = merchandise.product;
    if (merchandise.id === config.depositVariantId || product?.isDepositItem) {
      add(actual, merchandise.id, line.quantity);
      continue;
    }
    if (!product) continue;

    const bottles = parseInt(product.bottles?.value ?? "", 10);
    if (!(bottles > 0)) continue;

    const ownDeposit = parseInt(product.depositVariant?.value ?? "", 10);
    if (perProduct && ownDeposit > 0) {
      // Its own deposit variant is priced for all bottles of one unit
      add(expected, `gid://shopify/ProductVariant/${ownDeposit}`, line.quantity);
    } else {
      add(expected, config.depositVariantId, line.quantity * bottles);
    }
  }

  const variants = new Set([...expected.keys(), ...actual.keys()]);
  const mismatch = [...variants].some((id) => (expected.get(id) || 0) !== (actual.get(id) || 0));
  if (!mismatch) {
    return NO_ERRORS;
  }
  const anyExpected = [...expected.values()].some((qty) => qty > 0);

  const message =
    anyExpected
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
