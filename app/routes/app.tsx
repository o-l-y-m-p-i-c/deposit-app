import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "@remix-run/react";
import { Frame, Page, Layout, BlockStack, Text, Card, Banner } from "@shopify/polaris";
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { boundary } from "@shopify/shopify-app-remix/server";
import { getBillingAccess } from "~/lib/billing.server";
import { syncBilling } from "~/models/billing.server";
import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, redirect } = await authenticate.admin(request);
  const billing = await syncBilling(session.shop);
  const access = getBillingAccess(billing);

  // Only the billing pages stay reachable once the trial is over.
  if (!access.hasAccess && !new URL(request.url).pathname.startsWith("/app/billing")) {
    throw redirect("/app/billing");
  }

  return json({ access });
}

export default function AppLayout() {
  const { access } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();
  const navItems = [
    { label: "Dashboard", to: "/" },
    { label: "Deposit Settings", to: "/app/settings" },
    { label: "Billing", to: "/app/billing" },
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
              {access.reason === "trial" && !pathname.startsWith("/app/billing") && (
                <Banner tone="info" title={`Free trial: ${access.trialDaysLeft} day(s) left`}>
                  <Text as="p">
                    Subscribe on the Billing page to keep the bottle deposit running after the
                    trial. <Link to="/app/billing">Go to Billing</Link>
                  </Text>
                </Banner>
              )}
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
