import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Grid,
  Badge,
} from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link as RemixLink } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { getSettings } from "~/models/settings.server";
import { getRules } from "~/models/rules.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
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
      hasCartTransform: !!settings.cartTransformId,
      lastSyncedAt: settings.lastSyncedAt,
    },
    includeCount,
    excludeCount,
  });
}

export default function Index() {
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
                  This app automatically adds a bottle deposit (default: 0.10 EUR per bottle)
                  to eligible products. The deposit appears next to the price as
                  "price + 0.10Euro per bottle" and is added to the cart as a bundled component.
                </Text>
              </BlockStack>
            </Card>

            <Grid columns={{ xs: 1, sm: 2, md: 2 }}>
              <Grid.Cell>
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h3">
                      Deposit Settings
                    </Text>
                    <Text as="p" tone="subdued">
                      Edit the deposit amount, enable/disable the app, and configure
                      which tags or collections get the deposit.
                    </Text>
                    <RemixLink to="/app/settings">
                      <Button fullWidth>Configure Settings</Button>
                    </RemixLink>
                  </BlockStack>
                </Card>
              </Grid.Cell>

              <Grid.Cell>
                <Card>
                  <BlockStack gap="300">
                    <Text variant="headingMd" as="h3">
                      How It Works
                    </Text>
                    <BlockStack gap="200">
                      <Text as="p">1. Select tags or collections for deposit</Text>
                      <Text as="p">2. Exclude specific tags or collections if needed</Text>
                      <Text as="p">3. Deposit appears next to price on storefront</Text>
                      <Text as="p">4. Cart Transform adds deposit as a bundled component</Text>
                      <Text as="p">5. Deposit is included in checkout and order total</Text>
                    </BlockStack>
                  </BlockStack>
                </Card>
              </Grid.Cell>
            </Grid>

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
