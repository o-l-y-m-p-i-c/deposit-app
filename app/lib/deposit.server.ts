/**
 * Deposit business logic — shared between API routes and sync operations.
 */

import { prisma } from "~/db.server";
import { adminGraphql, CREATE_DEPOSIT_PRODUCT, UPDATE_DEFAULT_VARIANT_PRICE, UPDATE_VARIANT_PRICE, UPDATE_PRODUCT_STATUS, CREATE_CART_TRANSFORM, SET_METAFIELDS } from "~/lib/admin-api.server";

const API_VERSION = "2026-07";

/**
 * Get or create default settings for a shop.
 */
export async function getOrCreateSettings(shopId: string) {
  let settings = await prisma.depositSettings.findUnique({
    where: { shopId },
  });

  if (!settings) {
    settings = await prisma.depositSettings.create({
      data: { shopId },
    });
  }

  return settings;
}

/**
 * Get all rules for a shop, grouped by effect.
 */
export async function getRulesGrouped(shopId: string) {
  const rules = await prisma.depositRule.findMany({
    where: { shopId },
    orderBy: { createdAt: "asc" },
  });

  return {
    includeTags: rules.filter((r) => r.effect === "INCLUDE" && r.resourceType === "TAG"),
    includeCollections: rules.filter((r) => r.effect === "INCLUDE" && r.resourceType === "COLLECTION"),
    excludeTags: rules.filter((r) => r.effect === "EXCLUDE" && r.resourceType === "TAG"),
    excludeCollections: rules.filter((r) => r.effect === "EXCLUDE" && r.resourceType === "COLLECTION"),
  };
}

/**
 * Create the hidden deposit product and return its IDs.
 * Product is set to DRAFT status so it's not visible on the storefront.
 * Uses the new product model: create product (gets default variant), then set variant price.
 */
export async function createDepositProduct(shop: string, amountMinor: number, currencyCode: string) {
  const price = (amountMinor / 100).toFixed(2);

  // Step 1: Create the product (gets a default variant automatically)
  const result = await adminGraphql(CREATE_DEPOSIT_PRODUCT, {
    product: {
      title: "Bottle Deposit",
      productType: "Deposit",
      vendor: "Bottle Deposit App",
      status: "DRAFT",
      tags: ["deposit", "bottle-deposit"],
    },
  }, shop);

  const product = result?.data?.productCreate?.product;
  const errors = result?.data?.productCreate?.userErrors;

  if (errors?.length > 0) {
    throw new Error(`Failed to create deposit product: ${JSON.stringify(errors)}`);
  }

  if (!product?.id) {
    throw new Error("Deposit product created but missing product ID");
  }

  const productId = product.id;
  const variantId = product.defaultVariant?.id;

  if (!variantId) {
    throw new Error("Deposit product created but missing default variant ID");
  }

  // Step 2: Update the default variant's price
  const variantResult = await adminGraphql(UPDATE_DEFAULT_VARIANT_PRICE, {
    productId,
    variants: [{
      id: variantId,
      price,
      sku: "BOTTLE-DEPOSIT",
      taxable: false,
      requiresShipping: false,
      inventoryManagement: "NOT_MANAGED",
    }],
  }, shop);

  const variantErrors = variantResult?.data?.productVariantsBulkUpdate?.userErrors;
  if (variantErrors?.length > 0) {
    throw new Error(`Failed to update deposit variant: ${JSON.stringify(variantErrors)}`);
  }

  return { productId, variantId };
}

/**
 * Update the deposit variant price when settings change.
 */
export async function updateDepositPrice(shop: string, variantId: string, amountMinor: number) {
  const price = (amountMinor / 100).toFixed(2);

  const result = await adminGraphql(UPDATE_VARIANT_PRICE, {
    input: {
      id: variantId,
      price,
    },
  }, shop);

  const errors = result?.data?.productVariantUpdate?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Failed to update deposit price: ${JSON.stringify(errors)}`);
  }

  return result?.data?.productVariantUpdate?.productVariant;
}

/**
 * Create the Cart Transform Function and link it to the deposit variant.
 */
export async function createCartTransform(shop: string, functionId: string) {
  const result = await adminGraphql(CREATE_CART_TRANSFORM, {
    input: {
      functionId,
      title: "Bottle Deposit",
    },
  }, shop);

  const cartTransform = result?.data?.cartTransformCreate?.cartTransform;
  const errors = result?.data?.cartTransformCreate?.userErrors;

  if (errors?.length > 0) {
    throw new Error(`Failed to create cart transform: ${JSON.stringify(errors)}`);
  }

  return cartTransform;
}

/**
 * Sync the deposit configuration to the Cart Transform owner metafield.
 * This is the runtime configuration the Function reads.
 */
export async function syncCartTransformMetafield(
  shop: string,
  cartTransformId: string,
  settings: {
    enabled: boolean;
    amountMinor: number;
    currencyCode: string;
    depositVariantId: string | null;
  },
  rules: {
    includeTags: { value: string }[];
    includeCollections: { resourceId: string | null; value: string }[];
    excludeTags: { value: string }[];
    excludeCollections: { resourceId: string | null; value: string }[];
  },
) {
  const config = {
    enabled: settings.enabled,
    amountMinor: settings.amountMinor,
    currencyCode: settings.currencyCode,
    depositVariantId: settings.depositVariantId,
    includeTags: rules.includeTags.map((r) => r.value),
    includeCollectionIds: rules.includeCollections.map((r) => r.resourceId).filter(Boolean),
    excludeTags: rules.excludeTags.map((r) => r.value),
    excludeCollectionIds: rules.excludeCollections.map((r) => r.resourceId).filter(Boolean),
  };

  const result = await adminGraphql(SET_METAFIELDS, {
    metafields: [
      {
        namespace: "$app:deposit",
        key: "function-configuration",
        ownerId: cartTransformId,
        type: "json",
        value: JSON.stringify(config),
      },
    ],
  }, shop);

  const errors = result?.data?.metafieldsSet?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Failed to set metafields: ${JSON.stringify(errors)}`);
  }

  return result?.data?.metafieldsSet?.metafields;
}

/**
 * Sync the deposit display configuration to the shop's app-data metafield.
 * This is read by the Theme App Extension to show deposit text on the storefront.
 */
export async function syncStorefrontMetafield(
  shop: string,
  shopId: string,
  settings: {
    enabled: boolean;
    amountMinor: number;
    currencyCode: string;
  },
) {
  const config = {
    enabled: settings.enabled,
    amountMinor: settings.amountMinor,
    currencyCode: settings.currencyCode,
    depositText: `${(settings.amountMinor / 100).toFixed(2)}${settings.currencyCode === "EUR" ? "Euro" : settings.currencyCode} per bottle`,
  };

  const result = await adminGraphql(SET_METAFIELDS, {
    metafields: [
      {
        namespace: "$app:deposit",
        key: "display-config",
        ownerId: shopId,
        type: "json",
        value: JSON.stringify(config),
      },
    ],
  }, shop);

  const errors = result?.data?.metafieldsSet?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Failed to set storefront metafield: ${JSON.stringify(errors)}`);
  }

  return result?.data?.metafieldsSet?.metafields;
}

/**
 * Full sync: update deposit price, sync metafields.
 */
export async function fullSync(shop: string, shopId: string) {
  const settings = await getOrCreateSettings(shop);
  const rules = await getRulesGrouped(shop);
  const log = (operation: string, status: string, message: string) =>
    prisma.syncLog.create({ data: { shopId: shop, operation, status, message } });

  // 1. Update deposit variant price
  if (settings.depositVariantId) {
    try {
      await updateDepositPrice(shop, settings.depositVariantId, settings.amountMinor);
      await log("update_deposit_price", "success", `Price updated to ${settings.amountMinor} cents`);
    } catch (e) {
      await log("update_deposit_price", "error", String(e));
    }
  } else {
    // Create deposit product if it doesn't exist
    try {
      const { productId, variantId } = await createDepositProduct(shop, settings.amountMinor, settings.currencyCode);
      await prisma.depositSettings.upsert({
        where: { shopId },
        update: { depositProductId: productId, depositVariantId: variantId },
        create: { shopId, depositProductId: productId, depositVariantId: variantId },
      });
      await log("create_deposit_product", "success", `Product created: ${productId}`);
    } catch (e) {
      await log("create_deposit_product", "error", String(e));
    }
  }

  // 2. Sync Cart Transform metafield
  if (settings.cartTransformId) {
    try {
      const updatedSettings = await getOrCreateSettings(shop);
      const updatedRules = await getRulesGrouped(shop);
      await syncCartTransformMetafield(shop, settings.cartTransformId, {
        enabled: updatedSettings.enabled,
        amountMinor: updatedSettings.amountMinor,
        currencyCode: updatedSettings.currencyCode,
        depositVariantId: updatedSettings.depositVariantId,
      }, updatedRules);
      await log("sync_metafields", "success", "Cart Transform metafield synced");
    } catch (e) {
      await log("sync_metafields", "error", String(e));
    }
  }

  // 3. Sync storefront metafield
  try {
    await syncStorefrontMetafield(shop, shopId, {
      enabled: settings.enabled,
      amountMinor: settings.amountMinor,
      currencyCode: settings.currencyCode,
    });
    await log("sync_storefront", "success", "Storefront metafield synced");
  } catch (e) {
    await log("sync_storefront", "error", String(e));
  }

  // 4. Update lastSyncedAt
  await prisma.depositSettings.upsert({
    where: { shopId },
    update: { lastSyncedAt: new Date() },
    create: { shopId, lastSyncedAt: new Date() },
  });
}
