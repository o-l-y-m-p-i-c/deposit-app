import { describe, test, expect } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run.js";

const DEPOSIT_VARIANT = "gid://shopify/ProductVariant/999";

const config = (overrides = {}) =>
  JSON.stringify({
    enabled: true,
    mode: "line",
    depositVariantId: DEPOSIT_VARIANT,
    ...overrides,
  });

const productLine = (id, quantity, product = {}) => ({
  id: `gid://shopify/CartLine/${id}`,
  quantity,
  merchandise: {
    __typename: "ProductVariant",
    id: `gid://shopify/ProductVariant/${id}`,
    product: {
      hasIncludedTag: true,
      inIncludedCollection: false,
      hasExcludedTag: false,
      inExcludedCollection: false,
      ...product,
    },
  },
});

const depositLine = (quantity) => ({
  id: "gid://shopify/CartLine/deposit",
  quantity,
  merchandise: {
    __typename: "ProductVariant",
    id: DEPOSIT_VARIANT,
    product: {
      hasIncludedTag: false,
      inIncludedCollection: false,
      hasExcludedTag: false,
      inExcludedCollection: false,
    },
  },
});

const input = (lines, cfg = config()) => ({
  cart: { lines },
  validation: { metafield: { value: cfg } },
});

describe("Deposit validation", () => {
  test("allows cart when deposit quantity matches eligible items", () => {
    const result = cartValidationsGenerateRun(
      input([productLine(1, 3), depositLine(3)]),
    );
    expect(result.operations).toEqual([]);
  });

  test("blocks checkout when deposit is missing", () => {
    const result = cartValidationsGenerateRun(input([productLine(1, 2)]));
    expect(result.operations[0].validationAdd.errors.length).toBe(1);
  });

  test("blocks checkout when deposit quantity was edited", () => {
    const result = cartValidationsGenerateRun(
      input([productLine(1, 5), depositLine(2)]),
    );
    expect(result.operations[0].validationAdd.errors.length).toBe(1);
  });

  test("blocks deposit purchased alone", () => {
    const result = cartValidationsGenerateRun(input([depositLine(1)]));
    expect(result.operations[0].validationAdd.errors.length).toBe(1);
  });

  test("ignores ineligible products", () => {
    const result = cartValidationsGenerateRun(
      input([
        productLine(1, 4, { hasIncludedTag: false, inIncludedCollection: false }),
        depositLine(0),
      ]),
    );
    // deposit qty 0 === expected 0
    expect(result.operations).toEqual([]);
  });

  test("sums eligible quantities across multiple lines", () => {
    const result = cartValidationsGenerateRun(
      input([productLine(1, 2), productLine(2, 3), depositLine(5)]),
    );
    expect(result.operations).toEqual([]);
  });

  test("no-ops when mode is expand", () => {
    const result = cartValidationsGenerateRun(
      input([productLine(1, 2)], config({ mode: "expand" })),
    );
    expect(result.operations).toEqual([]);
  });

  test("no-ops when disabled", () => {
    const result = cartValidationsGenerateRun(
      input([productLine(1, 2)], config({ enabled: false })),
    );
    expect(result.operations).toEqual([]);
  });
});
