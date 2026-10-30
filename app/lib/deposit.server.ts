/**
 * Deposit business logic — shared between API routes and sync operations.
 */

import { prisma } from "~/db.server";
import {
  adminGraphql,
  CREATE_DEPOSIT_PRODUCT,
  CREATE_VALIDATION,
  DELETE_CART_TRANSFORM,
  DELETE_PRODUCT,
  DELETE_VALIDATION,
  GET_CART_TRANSFORMS,
  GET_DEPOSIT_PRODUCT,
  GET_PUBLICATIONS,
  GET_VALIDATIONS,
  PUBLISH_PRODUCT,
  SET_METAFIELDS,
  UPDATE_DEPOSIT_VARIANT,
  UPDATE_PRODUCT_STATUS,
} from "~/lib/admin-api.server";
import { getBillingAccess } from "~/lib/billing.server";
import { syncBilling } from "~/models/billing.server";
import { depositItemProductIds, syncDepositItems } from "~/lib/deposit-items.server";
import { syncEligibility } from "~/lib/eligibility.server";

const VALIDATION_HANDLE = "deposit-validation";
const VALIDATION_TITLE = "Bottle Deposit";

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
 * Publish the deposit product to the Online Store sales channel.
 * Without this the Ajax Cart API returns "Cannot find variant" —
 * products created via Admin API aren't channel-published by default.
 * Idempotent: publishing an already-published product is a no-op.
 */
export async function publishDepositProduct(shop: string, productId: string) {
  const pubsResult = await adminGraphql(GET_PUBLICATIONS, {}, shop);
  const pubs = pubsResult?.data?.publications?.nodes ?? [];
  const onlineStore = pubs.find(
    (p: { name?: string }) => p.name === "Online Store",
  );
  if (!onlineStore?.id) {
    throw new Error("Online Store publication not found");
  }

  const result = await adminGraphql(PUBLISH_PRODUCT, {
    id: productId,
    input: [{ publicationId: onlineStore.id }],
  }, shop);
  const errors = result?.data?.publishablePublish?.userErrors;
  if (errors?.length > 0) {
    throw new Error(`Failed to publish deposit product: ${JSON.stringify(errors)}`);
  }
}

/**
 * Delete this app's Cart Transforms. The deposit is a separate cart line
 * on every store (shown with its own price in cart and checkout); the
 * transform's bundling hid the deposit price inside the product line.
 */
export async function deleteCartTransforms(shop: string) {
  const existingResult = await adminGraphql(GET_CART_TRANSFORMS, {}, shop);
  const nodes: { id: string }[] = existingResult?.data?.cartTransforms?.nodes ?? [];
  for (const { id } of nodes) {
    const result = await adminGraphql(DELETE_CART_TRANSFORM, { id }, shop);
    const errors = result?.data?.cartTransformDelete?.userErrors;
    if (errors?.length > 0) {
      throw new Error(`Failed to delete cart transform: ${JSON.stringify(errors)}`);
    }
  }
  return nodes.map((n) => n.id);
}

/**
 * Get or create this app's Validation object — the server-side check
 * that the deposit line is present at checkout.
 *
 * The validation Function only enforces at checkout buyer-journey steps;
 * on cart interactions it passes, so its errors can't reject the
 * storefront script's own cart mutations. It backs up "Buy it now",
 * express checkout, blocked JS and direct /cart API calls.
 *
 * Returns null when Shopify refuses to activate the Function on this
 * shop's plan (custom apps can only run Functions on Shopify Plus) —
 * the deposit line is then storefront-only.
 */
export async function getOrCreateValidation(
  shop: string,
  existingId?: string | null,
): Promise<{ id: string } | null> {
  const existingResult = await adminGraphql(GET_VALIDATIONS, {}, shop);
  const nodes = existingResult?.data?.validations?.nodes ?? [];

  // Reuse the stored ID if it still exists, else one created earlier
  const match =
    (existingId && nodes.find((n: { id: string }) => n.id === existingId)) ||
    nodes.find((n: { title?: string }) => n.title === VALIDATION_TITLE);
  if (match) return match;

  const result = await adminGraphql(CREATE_VALIDATION, {
    validation: {
      title: VALIDATION_TITLE,
      functionHandle: VALIDATION_HANDLE,
      enable: true,
      blockOnFailure: false,
    },
  }, shop);
  const validation = result?.data?.validationCreate?.validation;
  const errors: { message?: string }[] = result?.data?.validationCreate?.userErrors ?? [];
  if (errors.some((e) => /shopify plus/i.test(e.message ?? ""))) {
    return null;
  }
  if (errors.length > 0) {
    throw new Error(`Failed to create validation: ${JSON.stringify(errors)}`);
  }
  if (!validation?.id) {
    throw new Error("Validation was created without an ID");
  }
  return validation;
}

/**
 * Sync the deposit configuration to the Validation's owner metafield.
 * Eligibility is not part of it — the Function reads each product's
 * $app:deposit.bottles metafield. `mode` is "line": the deposit is a
 * separate cart line, which the validation requires at checkout.
 */
export async function syncFunctionMetafields(
  shop: string,
  ownerIds: string[],
  settings: {
    enabled: boolean;
    depositMode: string;
    depositStyle: string;
    amountMinor: number;
    currencyCode: string;
    depositVariantId: string | null;
  },
) {
  const config = {
    enabled: settings.enabled,
    mode: settings.depositMode,
    // "shared" = one deposit product; "per_product" = each drink's own
    // deposit product ($app:deposit.deposit_variant on the drink)
    style: settings.depositStyle,
    amountMinor: settings.amountMinor,
    currencyCode: settings.currencyCode,
    depositVariantId: settings.depositVariantId,
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
 * Per-product eligibility comes from the product metafield (Liquid) and
 * the eligibility app proxy (storefront script), not from here.
 */
export async function syncStorefrontMetafield(
  shop: string,
  shopId: string,
  settings: {
    enabled: boolean;
    amountMinor: number;
    currencyCode: string;
    depositVariantId: string | null;
    depositMode: string;
    depositStyle: string;
  },
) {
  const config = {
    enabled: settings.enabled,
    // "line" → the storefront script adds and maintains the deposit line
    mode: settings.depositMode,
    // Which deposit product the line uses (see syncFunctionMetafields)
    style: settings.depositStyle,
    amountMinor: settings.amountMinor,
    currencyCode: settings.currencyCode,
    depositAmount: (settings.amountMinor / 100).toFixed(2),
    depositVariantId: settings.depositVariantId
      ? Number(settings.depositVariantId.split("/").pop())
      : null,
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
 * Full sync: update deposit price, flag eligible products, sync metafields.
 * `force` rewrites every eligible product's metafield (manual "Sync now").
 *
 * Without an active subscription the deposit is synced as disabled
 * (Cart Transform, deposit line and labels off) whatever the setting.
 */
export async function fullSync(
  shop: string,
  { force = false }: { force?: boolean } = {},
) {
  let settings = await getOrCreateSettings(shop);
  const log = (operation: string, status: string, message: string) =>
    prisma.syncLog.create({ data: { shopId: shop, operation, status, message } });

  const appInstallationId = await getAppInstallationId(shop);
  // What the storefront and Functions actually see: off once the trial
  // ended without a subscription, whatever the setting says
  const { hasAccess } = getBillingAccess(await syncBilling(shop));
  const depositActive = settings.enabled && hasAccess;
  if (settings.enabled && !hasAccess) {
    await log("billing", "warning", "Trial ended without a subscription — deposit synced as disabled");
  }

  try {
    let productId = settings.depositProductId;
    let variantId = settings.depositVariantId;
    if (productId && variantId) {
      await updateDepositPrice(shop, productId, variantId, settings.amountMinor);
      await log("update_deposit_price", "success", `Price updated to ${settings.amountMinor} cents`);
    } else {
      const created = await createDepositProduct(shop, settings.amountMinor);
      productId = created.productId;
      variantId = created.variantId;
      await log("create_deposit_product", "success", `Product ready: ${productId}`);
    }
    if (!productId || !variantId) {
      throw new Error("Deposit product is missing a product or variant ID");
    }
    // Line mode adds the deposit via the Ajax Cart API, which requires
    // the product to be published to the Online Store channel.
    await publishDepositProduct(shop, productId);
    await log("publish_deposit_product", "success", "Published to Online Store");
    settings = await prisma.depositSettings.update({
      where: { shopId: shop },
      data: { depositProductId: productId, depositVariantId: variantId },
    });
  } catch (error) {
    await log("sync_deposit_product", "error", String(error));
    throw error;
  }

  try {
    // Evaluate the rules once, server-side, onto product metafields —
    // Functions, Liquid and the storefront script all read the result
    // Deposit products themselves never carry a deposit
    const skipProductIds = [
      ...(settings.depositProductId ? [settings.depositProductId] : []),
      ...(await depositItemProductIds(shop)).map((id) => `gid://shopify/Product/${id}`),
    ];
    const result = await syncEligibility(shop, await getRulesGrouped(shop), {
      force,
      skipProductIds,
    });
    await log(
      "sync_eligibility",
      "success",
      `${result.total} products with deposit (+${result.flagged} / -${result.unflagged})`,
    );
  } catch (error) {
    await log("sync_eligibility", "error", String(error));
    throw error;
  }

  try {
    // "per_product": a "Deposit – <drink>" product per flagged drink;
    // "shared": archives any left from per_product
    const result = await syncDepositItems(shop, {
      style: settings.depositStyle,
      amountMinor: settings.amountMinor,
      force,
    });
    if (result.created + result.updated + result.archived > 0) {
      await log(
        "sync_deposit_items",
        "success",
        `Deposit products: +${result.created} new, ${result.updated} updated, ${result.archived} archived`,
      );
    }
  } catch (error) {
    await log("sync_deposit_items", "error", String(error));
    throw error;
  }

  try {
    // Every store uses a separate deposit line (own price in cart and
    // checkout). Remove the bundling Cart Transform from earlier versions.
    const deletedTransforms = await deleteCartTransforms(shop);
    if (deletedTransforms.length > 0) {
      await log("delete_cart_transform", "success", `Deleted ${deletedTransforms.join(", ")}`);
    }

    // Checkout check for the deposit line, where the plan allows Functions
    const validation = await getOrCreateValidation(shop, settings.validationId);
    const validationId = validation?.id ?? null;
    if (validationId && validationId !== settings.validationId) {
      await log("create_validation", "success", `Validation ready: ${validationId}`);
    }
    if (!validationId && settings.validationId !== null) {
      await log(
        "create_validation",
        "warning",
        "Store plan can't run Functions from a custom app — deposit line is storefront-only",
      );
    }

    if (
      settings.depositMode !== "line" ||
      settings.cartTransformId ||
      validationId !== settings.validationId
    ) {
      settings = await prisma.depositSettings.update({
        where: { shopId: shop },
        data: { depositMode: "line", cartTransformId: null, validationId },
      });
    }

    if (validationId) {
      await syncFunctionMetafields(shop, [validationId], {
        enabled: depositActive,
        depositMode: settings.depositMode,
        depositStyle: settings.depositStyle,
        amountMinor: settings.amountMinor,
        currencyCode: settings.currencyCode,
        depositVariantId: settings.depositVariantId,
      });
      await log("sync_metafields", "success", "Function metafields synced");
    }
  } catch (error) {
    await log("sync_functions", "error", String(error));
    throw error;
  }

  try {
    await syncStorefrontMetafield(shop, appInstallationId, {
      enabled: depositActive,
      amountMinor: settings.amountMinor,
      currencyCode: settings.currencyCode,
      depositVariantId: settings.depositVariantId,
      depositMode: settings.depositMode,
      depositStyle: settings.depositStyle,
    });
    await log("sync_storefront", "success", "Storefront metafield synced");
  } catch (error) {
    await log("sync_storefront", "error", String(error));
    throw error;
  }

  settings = await prisma.depositSettings.update({
    where: { shopId: shop },
    data: { lastSyncedAt: new Date() },
  });
  await prisma.shopBilling.update({
    where: { shopId: shop },
    data: { syncedAccess: hasAccess },
  });
  return settings;
}

const CURRENT_INSTALLATION = /* GraphQL */ `#graphql
  query DepositCurrentInstallation {
    currentAppInstallation { id }
  }
`;

/** Owner of the storefront display-config metafield. */
async function getAppInstallationId(shop: string) {
  const result = await adminGraphql(CURRENT_INSTALLATION, {}, shop);
  const id = result?.data?.currentAppInstallation?.id;
  if (!id) throw new Error("Current app installation ID is unavailable");
  return id as string;
}

/**
 * Re-sync the deposit config when billing access changed since the last
 * sync (trial ended, subscription approved or cancelled). No-op for shops
 * that were never set up.
 */
export async function syncDepositAccess(shop: string, { force = false } = {}) {
  const billing = await syncBilling(shop, { force });
  const { hasAccess } = getBillingAccess(billing);
  if (billing.syncedAccess === hasAccess) return;
  const settings = await prisma.depositSettings.findUnique({ where: { shopId: shop } });
  if (!settings?.lastSyncedAt) return;
  await fullSync(shop);
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Trials end by time, not by any Shopify event — check hourly (from the
 * cached state, no API calls) and switch the deposit off for shops whose
 * access ran out. Started once per server process.
 */
export function startBillingSweep() {
  const g = globalThis as unknown as { depositBillingSweep?: NodeJS.Timeout };
  if (g.depositBillingSweep) return;
  const sweep = async () => {
    const rows = await prisma.shopBilling.findMany({ where: { syncedAccess: { not: null } } });
    for (const row of rows) {
      if (getBillingAccess(row).hasAccess === row.syncedAccess) continue;
      await syncDepositAccess(row.shopId).catch((e) =>
        console.error(`[billing sweep] ${row.shopId}:`, e),
      );
    }
  };
  g.depositBillingSweep = setInterval(() => {
    sweep().catch((e) => console.error("[billing sweep]", e));
  }, SWEEP_INTERVAL_MS);
  g.depositBillingSweep.unref?.();
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

  // 4. Archive per-drink deposit products (kept for past orders)
  try {
    await syncDepositItems(shop, { style: "shared", amountMinor: 0 });
  } catch (error) {
    await log("archive_deposit_items", "warning", String(error));
  }

  // 5. Delete all rules and settings from the database
  await prisma.depositRule.deleteMany({ where: { shopId: shop } });
  // Product metafields are app-owned and removed by Shopify on uninstall
  await prisma.depositProduct.deleteMany({ where: { shopId: shop } });
  await prisma.depositItem.deleteMany({ where: { shopId: shop } });
  await prisma.depositSettings.deleteMany({ where: { shopId: shop } });
  await log("cleanup_db", "success", "Deleted all rules and settings");
}
