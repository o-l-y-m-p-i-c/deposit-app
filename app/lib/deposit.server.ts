/**
 * Deposit business logic — shared between API routes and sync operations.
 */

import { prisma } from "~/db.server";
import {
  adminGraphql,
  CREATE_CART_TRANSFORM,
  CREATE_DEPOSIT_PRODUCT,
  CREATE_VALIDATION,
  DELETE_CART_TRANSFORM,
  DELETE_PRODUCT,
  DELETE_VALIDATION,
  GET_CART_TRANSFORMS,
  GET_COLLECTION_HANDLES,
  GET_DEPOSIT_PRODUCT,
  GET_VALIDATIONS,
  SET_METAFIELDS,
  UPDATE_DEPOSIT_VARIANT,
  UPDATE_PRODUCT_STATUS,
} from "~/lib/admin-api.server";

const CART_TRANSFORM_HANDLE = "deposit-cart-transform";
const VALIDATION_HANDLE = "deposit-validation";

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
 * Find or create the deposit product and configure its default variant.
 */
export async function createDepositProduct(shop: string, amountMinor: number) {
  const existingResult = await adminGraphql(GET_DEPOSIT_PRODUCT, {}, shop);
  let product = existingResult?.data?.products?.nodes?.[0];

  if (!product) {
    const createResult = await adminGraphql(CREATE_DEPOSIT_PRODUCT, {
      product: {
        title: "Bottle Deposit",
        productType: "Deposit",
        vendor: "Bottle Deposit App",
        status: "ACTIVE",
        tags: ["deposit", "bottle-deposit"],
      },
    }, shop);
    const errors = createResult?.data?.productCreate?.userErrors;
    if (errors?.length > 0) {
      throw new Error(`Failed to create deposit product: ${JSON.stringify(errors)}`);
    }
    product = createResult?.data?.productCreate?.product;
  } else if (product.status !== "ACTIVE") {
    const statusResult = await adminGraphql(UPDATE_PRODUCT_STATUS, {
      product: { id: product.id, status: "ACTIVE" },
    }, shop);
    const errors = statusResult?.data?.productUpdate?.userErrors;
    if (errors?.length > 0) {
      throw new Error(`Failed to activate deposit product: ${JSON.stringify(errors)}`);
    }
  }

  const productId = product?.id;
  const variantId = product?.variants?.nodes?.[0]?.id;
  if (!productId || !variantId) {
    throw new Error("Deposit product is missing a product or variant ID");
  }

  await updateDepositPrice(shop, productId, variantId, amountMinor);
  return { productId, variantId };
}

/**
 * Update price, SKU, tax, tracking, and shipping settings on the deposit variant.
 */
export async function updateDepositPrice(
  shop: string,
  productId: string,
  variantId: string,
  amountMinor: number,
) {
  const result = await adminGraphql(UPDATE_DEPOSIT_VARIANT, {
    productId,
    variants: [{
      id: variantId,
      price: (amountMinor / 100).toFixed(2),
      taxable: false,
      inventoryItem: {
        sku: "BOTTLE-DEPOSIT",
        tracked: false,
        requiresShipping: false,
      },
    }],
  }, shop);
  const errors = result?.data?.productVariantsBulkUpdate?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Failed to update deposit variant: ${JSON.stringify(errors)}`);
  }
  return result?.data?.productVariantsBulkUpdate?.productVariants?.[0];
}

/**
 * Get or create a Cart Transform for the shop.
 * If `existingId` is provided, verifies it still exists in Shopify;
 * if it was deleted (e.g. app reinstalled), a new one is created.
 */
export async function getOrCreateCartTransform(shop: string, existingId?: string | null) {
  const existingResult = await adminGraphql(GET_CART_TRANSFORMS, {}, shop);
  const nodes = existingResult?.data?.cartTransforms?.nodes ?? [];

  // Reuse the stored ID if it still exists
  if (existingId) {
    const match = nodes.find((n: { id: string }) => n.id === existingId);
    if (match) return match;
  }

  // Reuse any other existing Cart Transform for this app
  if (nodes.length > 0) return nodes[0];

  // Otherwise create a new one
  const result = await adminGraphql(CREATE_CART_TRANSFORM, {
    functionHandle: CART_TRANSFORM_HANDLE,
  }, shop);
  const cartTransform = result?.data?.cartTransformCreate?.cartTransform;
  const errors = result?.data?.cartTransformCreate?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Failed to create cart transform: ${JSON.stringify(errors)}`);
  }
  if (!cartTransform?.id) {
    throw new Error("Cart Transform was created without an ID");
  }
  return cartTransform;
}

/**
 * Get or create a Validation for the shop.
 * If `existingId` is provided, verifies it still exists in Shopify;
 * if it was deleted (e.g. app reinstalled), a new one is created.
 */
export async function getOrCreateValidation(shop: string, existingId?: string | null) {
  const existingResult = await adminGraphql(GET_VALIDATIONS, {}, shop);
  const nodes = existingResult?.data?.validations?.nodes ?? [];

  // Reuse the stored ID if it still exists
  if (existingId) {
    const match = nodes.find((n: { id: string }) => n.id === existingId);
    if (match) return match;
  }

  // Reuse any existing Validation for this function
  const owned = nodes.find(
    (n: { shopifyFunction?: { handle?: string } }) =>
      n.shopifyFunction?.handle === VALIDATION_HANDLE,
  );
  if (owned) return owned;

  // Otherwise create a new one
  const result = await adminGraphql(CREATE_VALIDATION, {
    validation: {
      title: "Bottle Deposit",
      functionHandle: VALIDATION_HANDLE,
      enable: true,
      blockOnFailure: false,
    },
  }, shop);
  const validation = result?.data?.validationCreate?.validation;
  const errors = result?.data?.validationCreate?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Failed to create validation: ${JSON.stringify(errors)}`);
  }
  if (!validation?.id) {
    throw new Error("Validation was created without an ID");
  }
  return validation;
}

/**
 * Sync the deposit configuration to function owner metafields
 * (Cart Transform + Validation). Both functions read the same config;
 * `mode` decides which one acts:
 *   "line"   — validation enforces a standalone deposit line (default)
 *   "expand" — cart transform bundles deposit as a line component
 */
export async function syncFunctionMetafields(
  shop: string,
  ownerIds: string[],
  settings: {
    enabled: boolean;
    depositMode: string;
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
    mode: settings.depositMode,
    amountMinor: settings.amountMinor,
    currencyCode: settings.currencyCode,
    depositVariantId: settings.depositVariantId,
    includeTags: rules.includeTags.map((r) => r.value),
    includeCollectionIds: rules.includeCollections.map((r) => r.resourceId).filter(Boolean),
    excludeTags: rules.excludeTags.map((r) => r.value),
    excludeCollectionIds: rules.excludeCollections.map((r) => r.resourceId).filter(Boolean),
  };

  const result = await adminGraphql(SET_METAFIELDS, {
    metafields: ownerIds.map((ownerId) => ({
      namespace: "$app:deposit",
      key: "function-configuration",
      ownerId,
      type: "json",
      value: JSON.stringify(config),
    })),
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
    depositVariantId: string | null;
  },
  rules: {
    includeTags: { value: string }[];
    includeCollections: { resourceId: string | null; value: string }[];
    excludeTags: { value: string }[];
    excludeCollections: { resourceId: string | null; value: string }[];
  },
) {
  // Storefront JS can't evaluate collections by GID — resolve handles.
  const collectionIds = [
    ...rules.includeCollections.map((r) => r.resourceId),
    ...rules.excludeCollections.map((r) => r.resourceId),
  ].filter((id): id is string => Boolean(id));

  const handleById = new Map<string, string>();
  if (collectionIds.length > 0) {
    const result = await adminGraphql(GET_COLLECTION_HANDLES, { ids: collectionIds }, shop);
    for (const node of result?.data?.nodes ?? []) {
      if (node?.id && node?.handle) handleById.set(node.id, node.handle);
    }
  }

  const config = {
    enabled: settings.enabled,
    amountMinor: settings.amountMinor,
    currencyCode: settings.currencyCode,
    depositAmount: (settings.amountMinor / 100).toFixed(2),
    depositVariantId: settings.depositVariantId
      ? Number(settings.depositVariantId.split("/").pop())
      : null,
    includeTags: rules.includeTags.map((r) => r.value),
    excludeTags: rules.excludeTags.map((r) => r.value),
    includeCollections: rules.includeCollections
      .map((r) => (r.resourceId ? handleById.get(r.resourceId) : undefined))
      .filter(Boolean),
    excludeCollections: rules.excludeCollections
      .map((r) => (r.resourceId ? handleById.get(r.resourceId) : undefined))
      .filter(Boolean),
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
export async function fullSync(shop: string, appInstallationId: string) {
  let settings = await getOrCreateSettings(shop);
  const log = (operation: string, status: string, message: string) =>
    prisma.syncLog.create({ data: { shopId: shop, operation, status, message } });

  try {
    let productId = settings.depositProductId;
    let variantId = settings.depositVariantId;
    if (productId && variantId) {
      await updateDepositPrice(shop, productId, variantId, settings.amountMinor);
      await log("update_deposit_price", "success", `Price updated to ${settings.amountMinor} cents`);
    } else {
      ({ productId, variantId } = await createDepositProduct(shop, settings.amountMinor));
      await log("create_deposit_product", "success", `Product ready: ${productId}`);
    }
    settings = await prisma.depositSettings.update({
      where: { shopId: shop },
      data: { depositProductId: productId, depositVariantId: variantId },
    });
  } catch (error) {
    await log("sync_deposit_product", "error", String(error));
    throw error;
  }

  try {
    // Always verify the Cart Transform + Validation still exist in Shopify.
    // They can be deleted when the app is reinstalled, leaving a stale ID.
    const cartTransform = await getOrCreateCartTransform(shop, settings.cartTransformId);
    let cartTransformId = cartTransform.id;
    if (cartTransformId !== settings.cartTransformId) {
      await log("create_cart_transform", "success", `Cart Transform ready: ${cartTransformId}`);
    }

    const validation = await getOrCreateValidation(shop, settings.validationId);
    const validationId = validation.id;
    if (validationId !== settings.validationId) {
      await log("create_validation", "success", `Validation ready: ${validationId}`);
    }

    if (cartTransformId !== settings.cartTransformId || validationId !== settings.validationId) {
      settings = await prisma.depositSettings.update({
        where: { shopId: shop },
        data: { cartTransformId, validationId },
      });
    }

    const rules = await getRulesGrouped(shop);
    await syncFunctionMetafields(shop, [cartTransformId, validationId], {
      enabled: settings.enabled,
      depositMode: settings.depositMode,
      amountMinor: settings.amountMinor,
      currencyCode: settings.currencyCode,
      depositVariantId: settings.depositVariantId,
    }, rules);
    await log("sync_metafields", "success", "Function metafields synced");
  } catch (error) {
    await log("sync_functions", "error", String(error));
    throw error;
  }

  try {
    const storefrontRules = await getRulesGrouped(shop);
    await syncStorefrontMetafield(shop, appInstallationId, {
      enabled: settings.enabled,
      amountMinor: settings.amountMinor,
      currencyCode: settings.currencyCode,
      depositVariantId: settings.depositVariantId,
    }, storefrontRules);
    await log("sync_storefront", "success", "Storefront metafield synced");
  } catch (error) {
    await log("sync_storefront", "error", String(error));
    throw error;
  }

  settings = await prisma.depositSettings.update({
    where: { shopId: shop },
    data: { lastSyncedAt: new Date() },
  });
  return settings;
}

/**
 * Remove all deposit artifacts from Shopify and the database.
 *
 * This should be called BEFORE the merchant uninstalls the app, while
 * the OAuth token is still valid. After uninstall, Shopify revokes the
 * token and Admin API calls are no longer possible.
 *
 * Steps:
 * 1. Delete the Cart Transform (stops the Function from running)
 * 2. Delete the Validation (unlocks checkout)
 * 3. Delete the deposit product (removes the €0.10 variant from the catalog)
 * 4. Delete all rules and settings from the database
 *
 * Metafields in the $app:deposit namespace are auto-deleted by Shopify
 * on uninstall, so we don't need to remove them manually.
 */
export async function cleanupShop(shop: string) {
  const settings = await prisma.depositSettings.findUnique({
    where: { shopId: shop },
  });
  const log = (operation: string, status: string, message: string) =>
    prisma.syncLog.create({ data: { shopId: shop, operation, status, message } });

  // 1. Delete the Cart Transform
  if (settings?.cartTransformId) {
    try {
      const result = await adminGraphql(DELETE_CART_TRANSFORM, {
        id: settings.cartTransformId,
      }, shop);
      const errors = result?.data?.cartTransformDelete?.userErrors;
      if (errors?.length > 0) {
        // Cart Transform may have already been deleted — log but don't throw
        await log("delete_cart_transform", "warning", `Errors: ${JSON.stringify(errors)}`);
      } else {
        await log("delete_cart_transform", "success", `Deleted ${settings.cartTransformId}`);
      }
    } catch (error) {
      // Non-fatal: Cart Transform may already be gone
      await log("delete_cart_transform", "warning", String(error));
    }
  }

  // 2. Delete the Validation
  if (settings?.validationId) {
    try {
      const result = await adminGraphql(DELETE_VALIDATION, {
        id: settings.validationId,
      }, shop);
      const errors = result?.data?.validationDelete?.userErrors;
      if (errors?.length > 0) {
        await log("delete_validation", "warning", `Errors: ${JSON.stringify(errors)}`);
      } else {
        await log("delete_validation", "success", `Deleted ${settings.validationId}`);
      }
    } catch (error) {
      await log("delete_validation", "warning", String(error));
    }
  }

  // 3. Delete the deposit product
  if (settings?.depositProductId) {
    try {
      const result = await adminGraphql(DELETE_PRODUCT, {
        id: settings.depositProductId,
      }, shop);
      const errors = result?.data?.productDelete?.userErrors;
      if (errors?.length > 0) {
        await log("delete_deposit_product", "warning", `Errors: ${JSON.stringify(errors)}`);
      } else {
        await log("delete_deposit_product", "success", `Deleted ${settings.depositProductId}`);
      }
    } catch (error) {
      // Non-fatal: product may already be deleted
      await log("delete_deposit_product", "warning", String(error));
    }
  }

  // 4. Delete all rules and settings from the database
  await prisma.depositRule.deleteMany({ where: { shopId: shop } });
  await prisma.depositSettings.deleteMany({ where: { shopId: shop } });
  await log("cleanup_db", "success", "Deleted all rules and settings");
}
