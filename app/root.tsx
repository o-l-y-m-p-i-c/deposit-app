import type { LinksFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "@remix-run/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-remix/react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  { rel: "stylesheet", href: polarisStyles },
];

export function loader() {
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <ShopifyAppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/" rel="home">Dashboard</Link>
        <Link to="/app/settings">Deposit Settings</Link>
      </NavMenu>
      <Outlet />
    </ShopifyAppProvider>
  );
}
