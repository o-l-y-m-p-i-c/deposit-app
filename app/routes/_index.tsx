import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  InlineGrid,
  Badge,
} from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { formatMoney } from "~/lib/money";
import { getBillingAccess } from "~/lib/billing.server";
import { syncBilling } from "~/models/billing.server";
import { authenticate } from "~/shopify.server";
import { getSettings } from "~/models/settings.server";
import { getRules } from "~/models/rules.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, redirect } = await authenticate.admin(request);
  // The dashboard sits outside the /app layout — same billing gate
  if (!getBillingAccess(await syncBilling(session.shop)).hasAccess) {
    throw redirect("/app/billing");
  }
  const settings = await getSettings(session.shop);
  const rules = await getRules(session.shop);

  const includeCount = rules.filter((r) => r.effect === "INCLUDE").length;
  const excludeCount = rules.filter((r) => r.effect === "EXCLUDE").length;

  return json({
    settings: {
      enabled: settings.enabled,
      amountMinor: settings.amountMinor,
      currencyCode: settings.currencyCode,
      hasDepositProduct: !!settings.depositProductId,
      hasCheckoutCheck: !!settings.validationId,
      lastSyncedAt: settings.lastSyncedAt,
    },
    includeCount,
    excludeCount,
  });
}

export default function Index() {
  const { settings } = useLoaderData<typeof loader>();
  const deposit = formatMoney(settings.amountMinor, settings.currencyCode);

  return (
    <Page title="Bottle Deposit App" subtitle="Add returnable bottle deposits to eligible products">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">
                  Welcome! 
                </Text>
                <Text as="p" tone="subdued">
                  {`This app adds a bottle deposit (${deposit} per bottle) to eligible products. `}
                  {`The deposit appears next to the price as "+ ${deposit} per bottle" and is `}
                  added to the cart as a separate deposit line with its own price.
                </Text>
              </BlockStack>
            </Card>

            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h3">
                    Deposit Settings
                  </Text>
                  <Text as="p" tone="subdued">
                    Edit the deposit amount, enable/disable the app, and configure
                    which tags or collections get the deposit.
                  </Text>
                  <Button fullWidth url="/app/settings">
                    Configure Settings
                  </Button>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h3">
                    How It Works
                  </Text>
                  <BlockStack gap="200">
                    <Text as="p">1. Select tags or collections for deposit</Text>
                    <Text as="p">2. Exclude specific tags or collections if needed</Text>
                    <Text as="p">3. Deposit appears next to price on storefront</Text>
                    <Text as="p">4. A separate deposit line is added to the cart</Text>
                    <Text as="p">5. Deposit is included in checkout and order total</Text>
                  </BlockStack>
                </BlockStack>
              </Card>
            </InlineGrid>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">
                  Rule Priority
                </Text>
                <BlockStack gap="200">
                  <Text as="p">
                    <Badge tone="critical">Exclusions always win</Badge>
                    If a product matches both an include and exclude rule,
                    the deposit is NOT applied.
                  </Text>
                  <Text as="p">
                    Example: Product is in collection "Water" (included) but has
                    tag "19L bottle" (excluded) — no deposit.
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
