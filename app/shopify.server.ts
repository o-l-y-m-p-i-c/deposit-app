import "@shopify/shopify-app-remix/server/adapters/node";
import { BillingInterval, shopifyApp } from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { prisma } from "~/db.server";

/** The single paid plan: €9.99 every 30 days after a 14-day trial. */
export const MONTHLY_PLAN = "Bottle Deposit Monthly";

const shopify = shopifyApp({
  billing: {
    [MONTHLY_PLAN]: {
      trialDays: 14,
      lineItems: [
        {
          amount: 9.99,
          currencyCode: "EUR",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  scopes: process.env.SCOPES?.split(",") || [
    "read_products",
    "write_products",
    "write_cart_transforms",
    "read_metaobjects",
    "write_metaobjects",
    "read_orders",
    "read_themes",
  ],
  appUrl: process.env.SHOPIFY_APP_URL!,
  sessionStorage: new PrismaSessionStorage(prisma),
  isEmbeddedApp: true,
  api: {
    apiVersion: "2026-07",
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
});

export default shopify;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
