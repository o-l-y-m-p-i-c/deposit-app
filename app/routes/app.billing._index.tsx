import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Banner,
  Button,
  DataTable,
  List,
  Modal,
} from "@shopify/polaris";
import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  PLAN_CURRENCY,
  PLAN_PRICE,
  PRO_PLAN,
  TRIAL_DAYS,
  getBillingAccess,
  isTestBilling,
} from "~/lib/billing.server";
import { formatMoney } from "~/lib/money";
import { syncDepositAccess } from "~/lib/deposit.server";
import { getSubscriptions, syncBilling } from "~/models/billing.server";
import { authenticate } from "~/shopify.server";

/** Billing page (ported from gift-app). Reachable even after the trial. */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  // Coming back from Shopify's approval page lands here — turn the
  // deposit back on right away if access returned
  await syncDepositAccess(shopId, { force: true });
  const billing = await syncBilling(shopId);
  const subscriptions = await getSubscriptions(shopId);

  return json({
    plan: {
      name: PRO_PLAN,
      price: Math.round(PLAN_PRICE * 100),
      currency: PLAN_CURRENCY,
      trialDays: TRIAL_DAYS,
    },
    access: getBillingAccess(billing),
    currentPeriodEnd: billing.currentPeriodEnd?.toISOString().split("T")[0] ?? null,
    subscriptions: subscriptions.map((sub) => ({
      id: sub.id,
      name: sub.name,
      status: sub.status,
      test: sub.test,
      amount: sub.amount,
      currency: sub.currencyCode,
      trialDays: sub.trialDays,
      date: sub.createdAt.toISOString().split("T")[0],
    })),
  });
}

type ActionResult = { error?: string; message?: string };

export async function action({ request }: ActionFunctionArgs) {
  const { session, billing } = await authenticate.admin(request);
  const shopId = session.shop;
  const intent = (await request.formData()).get("intent");
  const state = await syncBilling(shopId, { force: true });
  const access = getBillingAccess(state);
  const result = (data: ActionResult, status = 200) => json(data, { status });
  const requestFailed = "Shopify couldn't complete the request. Try again, or refresh the status.";

  if (intent === "subscribe") {
    if (access.reason === "dev_store") {
      return result({ error: "Development stores use the app for free." }, 400);
    }
    if (access.reason === "subscribed") {
      return result({ error: "The shop already has an active subscription." }, 400);
    }
    try {
      // Carry the remaining app trial over to the Shopify charge so the
      // merchant isn't billed before the 14 days are up. On success this
      // throws a redirect to Shopify's approval page.
      await billing.request({
        plan: PRO_PLAN,
        isTest: isTestBilling(),
        trialDays: access.trialDaysLeft,
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      console.error("[billing] Subscription request failed:", error);
      return result({ error: requestFailed }, 502);
    }
  }

  if (intent === "cancel" && state.subscriptionId) {
    try {
      await billing.cancel({
        subscriptionId: state.subscriptionId,
        isTest: isTestBilling(),
        prorate: true,
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      console.error("[billing] Cancel failed:", error);
      return result({ error: requestFailed }, 502);
    }
    // Deposit goes off now unless the trial is still running
    await syncDepositAccess(shopId, { force: true });
    return result({ message: "Subscription cancelled." });
  }

  return result({ error: "Unknown action." }, 400);
}

const STATUS_TONE: Record<string, "success" | "warning" | "critical" | "info" | undefined> = {
  ACTIVE: "success",
  PENDING: "warning",
  FROZEN: "warning",
  DECLINED: "critical",
  CANCELLED: undefined,
  EXPIRED: undefined,
};

export default function BillingPage() {
  const { plan, access, currentPeriodEnd, subscriptions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busyIntent = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;
  const planPrice = formatMoney(plan.price, plan.currency);
  // Stored values are UTC calendar dates
  const date = (value: string) => new Date(value).toLocaleDateString(undefined, { timeZone: "UTC" });
  const trialEnd = date(access.trialEndsAt);

  const statusBadge = {
    dev_store: <Badge tone="info">Development store — free</Badge>,
    subscribed: <Badge tone="success">Active</Badge>,
    trial: <Badge tone="warning">{`Free trial · ${access.trialDaysLeft} day(s) left`}</Badge>,
    trial_expired: <Badge tone="critical">Trial ended</Badge>,
  }[access.reason];

  const rows = subscriptions.map((sub) => [
    date(sub.date),
    sub.name,
    formatMoney(sub.amount, sub.currency),
    `${sub.trialDays} days`,
    <InlineStack gap="100" key={sub.id}>
      <Badge tone={STATUS_TONE[sub.status]}>{sub.status}</Badge>
      {sub.test && <Badge>Test</Badge>}
    </InlineStack>,
  ]);

  return (
    <Page title="Billing" subtitle="Manage your Bottle Deposit subscription">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {access.reason === "trial_expired" && (
              <Banner tone="critical" title="Your free trial has ended">
                <Text as="p">
                  The bottle deposit is paused on your storefront. Subscribe to turn it back on.
                </Text>
              </Banner>
            )}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}
            {actionData?.message && <Banner tone="success">{actionData.message}</Banner>}

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h2">
                    {plan.name}
                  </Text>
                  {statusBadge}
                </InlineStack>

                <Text variant="headingLg" as="p">
                  {planPrice} / month
                </Text>

                <List>
                  <List.Item>{`${plan.trialDays}-day free trial`}</List.Item>
                  <List.Item>Free on Shopify development stores</List.Item>
                  <List.Item>Unlimited deposit rules and products</List.Item>
                  <List.Item>Billed through your Shopify invoice every 30 days</List.Item>
                </List>

                {access.reason === "trial" && (
                  <Text as="p" tone="subdued">
                    {`Your trial ends on ${trialEnd}. Subscribing now won't charge you until then.`}
                  </Text>
                )}
                {access.reason === "subscribed" && currentPeriodEnd && (
                  <Text as="p" tone="subdued">
                    {`The current billing period ends on ${date(currentPeriodEnd)}.`}
                  </Text>
                )}
                {access.reason === "dev_store" && (
                  <Text as="p" tone="subdued">
                    This is a development store, so no subscription is needed. Billing starts once
                    the store moves to a paid Shopify plan.
                  </Text>
                )}

                <InlineStack gap="200">
                  {(access.reason === "trial" || access.reason === "trial_expired") && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="subscribe" />
                      <Button submit variant="primary" loading={busyIntent === "subscribe"}>
                        {`Subscribe for ${planPrice}/month`}
                      </Button>
                    </Form>
                  )}
                  {access.reason === "subscribed" && (
                    <Button
                      tone="critical"
                      loading={busyIntent === "cancel"}
                      onClick={() => setConfirmCancel(true)}
                    >
                      Cancel subscription
                    </Button>
                  )}
                  <Button
                    loading={revalidator.state === "loading"}
                    onClick={() => revalidator.revalidate()}
                  >
                    Refresh status
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">
                  Subscription history
                </Text>
                {rows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No subscriptions yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={["Created", "Plan", "Price", "Trial", "Status"]}
                    rows={rows}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel subscription?"
        primaryAction={{
          content: "Cancel subscription",
          destructive: true,
          onAction: () => {
            setConfirmCancel(false);
            submit({ intent: "cancel" }, { method: "post" });
          },
        }}
        secondaryActions={[{ content: "Keep subscription", onAction: () => setConfirmCancel(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            Cancel the subscription? The bottle deposit stops on your storefront unless the free
            trial is still running.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
