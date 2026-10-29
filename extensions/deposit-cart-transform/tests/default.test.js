import path from "path";
import fs from "fs";
import { describe, beforeAll, test, expect } from "vitest";
import { buildFunction, getFunctionInfo, loadSchema, loadInputQuery, loadFixture, validateTestAssets, runFunction } from "@shopify/shopify-function-test-helpers";
import { cartTransformRun } from "../src/cart_transform_run.js";

const input = (bottles = "1") => ({
  presentmentCurrencyRate: "1.00",
  cart: {
    lines: [{
      id: "gid://shopify/CartLine/1",
      quantity: 3,
      cost: {
        amountPerQuantity: {
          amount: "10.00",
        },
      },
      merchandise: {
        __typename: "ProductVariant",
        id: "gid://shopify/ProductVariant/1",
        title: "0.5 L",
        product: {
          title: "Mineral Water",
          bottles: bottles === null ? null : { value: bottles },
        },
      },
    }],
  },
  cartTransform: {
    metafield: {
      value: JSON.stringify({
        enabled: true,
        mode: "expand",
        amountMinor: 10,
        depositVariantId: "gid://shopify/ProductVariant/2",
      }),
    },
  },
});

describe("Deposit rules", () => {
  test("adds one deposit component per source item", () => {
    const result = cartTransformRun(input());
    expect(result.operations[0].lineExpand.expandedCartItems).toEqual([
      {
        merchandiseId: "gid://shopify/ProductVariant/1",
        quantity: 1,
        price: { adjustment: { fixedPricePerUnit: { amount: "10.00" } } },
      },
      {
        merchandiseId: "gid://shopify/ProductVariant/2",
        quantity: 1,
        price: { adjustment: { fixedPricePerUnit: { amount: "0.10" } } },
      },
    ]);
  });

  test("titles the expanded line as including the deposit", () => {
    expect(cartTransformRun(input()).operations[0].lineExpand.title).toBe(
      "Mineral Water - 0.5 L (incl. deposit)",
    );
  });

  test("ignores line mode configs (retired) so nothing double-charges", () => {
    const lineMode = input();
    lineMode.cartTransform.metafield.value = JSON.stringify({
      enabled: true,
      mode: "line",
      amountMinor: 10,
      depositVariantId: "gid://shopify/ProductVariant/2",
    });
    expect(cartTransformRun(lineMode)).toEqual({ operations: [] });
  });

  test("converts the deposit into presentment currency", () => {
    const convertedInput = input();
    convertedInput.presentmentCurrencyRate = "1.20";
    const result = cartTransformRun(convertedInput);
    expect(
      result.operations[0].lineExpand.expandedCartItems[1].price.adjustment.fixedPricePerUnit.amount,
    ).toBe("0.12");
  });

  test("products without the deposit metafield are left alone", () => {
    expect(cartTransformRun(input(null))).toEqual({ operations: [] });
  });

  test("zero deposit units means no deposit", () => {
    expect(cartTransformRun(input("0"))).toEqual({ operations: [] });
  });

  test("multipacks get one deposit unit per bottle", () => {
    const result = cartTransformRun(input("6"));
    expect(result.operations[0].lineExpand.expandedCartItems[1].quantity).toBe(6);
  });
});

describe("Default Integration Test", () => {
  let schema;
  let functionDir;
  let functionInfo;
  let schemaPath;
  let targeting;
  let functionRunnerPath;
  let wasmPath;

  beforeAll(async () => {
    functionDir = path.dirname(__dirname);
    await buildFunction(functionDir);
    functionInfo = await getFunctionInfo(functionDir);
    ({ schemaPath, functionRunnerPath, wasmPath, targeting } = functionInfo);
    schema = await loadSchema(schemaPath);
  }, 45000);

  const fixturesDir = path.join(__dirname, "fixtures");
  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(fixturesDir, file));

  fixtureFiles.forEach((fixtureFile) => {
    test(`runs ${path.relative(fixturesDir, fixtureFile)}`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const targetInputQueryPath = targeting[fixture.target].inputQueryPath;
      const inputQueryAST = await loadInputQuery(targetInputQueryPath);

      const validationResult = await validateTestAssets({ schema, fixture, inputQueryAST });
      expect(validationResult.inputQuery.errors).toEqual([]);
      expect(validationResult.inputFixture.errors).toEqual([]);
      expect(validationResult.outputFixture.errors).toEqual([]);

      const runResult = await runFunction(fixture, functionRunnerPath, wasmPath, targetInputQueryPath, schemaPath);
      expect(runResult.error).toBeNull();
      expect(runResult.result.output).toEqual(fixture.expectedOutput);
    }, 10000);
  });
});
