import { json } from "@remix-run/node";

/**
 * CORS helpers for app proxy routes.
 * Allows the storefront to call app proxy endpoints.
 */

const ALLOWED_ORIGINS = [
  "https://checkout.shopify.com",
];

export function corsJson(data: unknown, init?: ResponseInit) {
  return json(data, {
    ...init,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...init?.headers,
    },
  });
}

export function handleCorsPreflight(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }
  return null;
}
