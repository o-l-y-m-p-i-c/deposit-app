import { json } from "@remix-run/node";

/**
 * Health check endpoint for Render.
 * Returns 200 OK without requiring Shopify authentication.
 */
export function loader() {
  return json({ status: "ok" }, { status: 200 });
}
