import { Link, Outlet, useRouteError } from "@remix-run/react";
import { Frame, Page, Layout, BlockStack, Text, Card } from "@shopify/polaris";
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}

export default function AppLayout() {
  const navItems = [
    { label: "Dashboard", to: "/" },
    { label: "Deposit Settings", to: "/app/settings" },
  ];

  return (
    <Frame>
      <Page>
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", padding: "8px 12px" }}>
                  {navItems.map((item) => (
                    <Link key={item.to} to={item.to}>
                      <Text as="span" variant="bodyMd" tone="subdued">
                        {item.label}
                      </Text>
                    </Link>
                  ))}
                </div>
              </Card>
              <Outlet />
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
