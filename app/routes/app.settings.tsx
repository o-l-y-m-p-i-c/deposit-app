import { useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Button,
  Badge,
  Tag,
  Modal,
  Select,
  ChoiceList,
  InlineStack,
  Spinner,
  Banner,
  DataTable,
  EmptyState,
} from "@shopify/polaris";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { getSettings, updateSettings } from "~/models/settings.server";
import { getRules, addRule, removeRule } from "~/models/rules.server";
import { fullSync, cleanupShop } from "~/lib/deposit.server";
import {
  adminGraphql,
  GET_COLLECTIONS,
  GET_PRODUCT_TAGS,
} from "~/lib/admin-api.server";
import { getBillingAccess } from "~/lib/billing.server";
import { syncBilling } from "~/models/billing.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Billing gate: the /app layout loader redirects to Billing without access
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const rules = await getRules(session.shop);
  const access = getBillingAccess(await syncBilling(session.shop));
  const depositProductCount = await prisma.depositProduct.count({
    where: { shopId: session.shop },
  });

  const includeTags = rules.filter((r) => r.effect === "INCLUDE" && r.resourceType === "TAG");
  const includeCollections = rules.filter((r) => r.effect === "INCLUDE" && r.resourceType === "COLLECTION");
  const excludeTags = rules.filter((r) => r.effect === "EXCLUDE" && r.resourceType === "TAG");
  const excludeCollections = rules.filter((r) => r.effect === "EXCLUDE" && r.resourceType === "COLLECTION");

  // Fetch available tags from Shopify
  let availableTags: string[] = [];
  try {
    const result = await adminGraphql(GET_PRODUCT_TAGS, {}, session.shop);
    availableTags = result?.data?.productTags?.nodes || [];
  } catch {
    // Tags fetch is non-critical
  }

  // Fetch collections from Shopify
  let collections: { id: string; title: string }[] = [];
  try {
    const result = await adminGraphql(GET_COLLECTIONS, { first: 250 }, session.shop);
    collections = result?.data?.collections?.edges?.map((e: { node: { id: string; title: string } }) => ({
      id: e.node.id,
      title: e.node.title,
    })) || [];
  } catch {
    // Collections fetch is non-critical
  }

  return json({
    shop: session.shop,
    settings: {
      enabled: settings.enabled,
      amountMinor: settings.amountMinor,
      currencyCode: settings.currencyCode,
      depositProductId: settings.depositProductId,
      depositVariantId: settings.depositVariantId,
      validationId: settings.validationId,
      depositStyle: settings.depositStyle,
      lastSyncedAt: settings.lastSyncedAt,
    },
    includeTags,
    includeCollections,
    excludeTags,
    excludeCollections,
    availableTags,
    collections,
    depositProductCount,
    billingReason: access.reason,
    trialDaysLeft: access.trialDaysLeft,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.formData();
  const intent = body.get("intent") as string;

  const { session } = await authenticate.admin(request);
  // Cleanup before uninstall stays possible after the trial; changes
  // that sync the deposit need access (actions skip the layout loader)
  if (intent !== "cleanup" && !getBillingAccess(await syncBilling(session.shop)).hasAccess) {
    return json({ error: "Your free trial has ended. Subscribe on the Billing page." }, { status: 402 });
  }

  if (intent === "updateSettings") {
    const enabled = body.get("enabled") === "true";
    const amountMinor = parseInt(body.get("amountMinor") as string, 10);
    if (isNaN(amountMinor) || amountMinor < 0) {
      return json({ error: "Invalid deposit amount" }, { status: 400 });
    }
    const depositStyle = body.get("depositStyle");
    if (depositStyle !== "shared" && depositStyle !== "per_product") {
      return json({ error: "Invalid deposit style" }, { status: 400 });
    }

    await updateSettings(session.shop, { enabled, amountMinor, depositStyle });

    // Trigger full sync
    try {
      await fullSync(session.shop);
    } catch (e) {
      console.error("[action updateSettings] Sync failed:", e);
      return json({ error: String(e) }, { status: 500 });
    }

    return json({ success: true, message: "Settings saved and synced" });
  }

  if (intent === "addRule") {
    const effect = body.get("effect") as string;
    const resourceType = body.get("resourceType") as string;
    const value = body.get("value") as string;
    const label = body.get("label") as string;
    const resourceId = (body.get("resourceId") as string) || null;

    if (!effect || !resourceType || !value || !label) {
      return json({ error: "Missing required fields" }, { status: 400 });
    }

    try {
      await addRule(session.shop, { effect, resourceType, resourceId, value, label });
    } catch {
      return json({ error: "Rule already exists" }, { status: 409 });
    }

    // Trigger full sync
    try {
      await fullSync(session.shop);
    } catch (e) {
      console.error("[action addRule] Sync failed:", e);
      return json({ error: String(e) }, { status: 500 });
    }

    return json({ success: true, message: "Rule added and synced" });
  }

  if (intent === "removeRule") {
    const ruleId = parseInt(body.get("ruleId") as string, 10);
    if (isNaN(ruleId)) {
      return json({ error: "Invalid rule ID" }, { status: 400 });
    }

    await removeRule(session.shop, ruleId);

    // Trigger full sync
    try {
      await fullSync(session.shop);
    } catch (e) {
      console.error("[action removeRule] Sync failed:", e);
      return json({ error: String(e) }, { status: 500 });
    }

    return json({ success: true, message: "Rule removed and synced" });
  }

  if (intent === "sync") {
    try {
      // Manual sync rewrites every product flag (repairs manual edits)
      await fullSync(session.shop, { force: true });
      return json({ success: true, message: "Sync complete" });
    } catch (e) {
      return json({ error: String(e) }, { status: 500 });
    }
  }

  if (intent === "cleanup") {
    try {
      await cleanupShop(session.shop);
      return json({ success: true, message: "Cleanup complete — you can now safely uninstall the app" });
    } catch (e) {
      return json({ error: String(e) }, { status: 500 });
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [depositStyle, setDepositStyle] = useState(data.settings.depositStyle);
  const [amountEuros, setAmountEuros] = useState((data.settings.amountMinor / 100).toFixed(2));
  const [showAddModal, setShowAddModal] = useState(false);
  const [newRuleEffect, setNewRuleEffect] = useState("INCLUDE");
  const [newRuleType, setNewRuleType] = useState("TAG");
  const [newRuleTagValue, setNewRuleTagValue] = useState("");
  const [newRuleCollectionId, setNewRuleCollectionId] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [showCleanupModal, setShowCleanupModal] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(data.settings.enabled);
    setDepositStyle(data.settings.depositStyle);
    setAmountEuros((data.settings.amountMinor / 100).toFixed(2));
  }, [data.settings.enabled, data.settings.amountMinor, data.settings.depositStyle]);

  const handleSaveSettings = useCallback(() => {
    const amountMinor = Math.round(parseFloat(amountEuros) * 100);
    if (isNaN(amountMinor) || amountMinor < 0) {
      setToastMessage("Invalid amount");
      return;
    }
    fetcher.submit(
      {
        intent: "updateSettings",
        enabled: String(enabled),
        amountMinor: String(amountMinor),
        depositStyle,
      },
      { method: "post" },
    );
  }, [amountEuros, enabled, depositStyle, fetcher]);

  const handleAddRule = useCallback(() => {
    let value = "";
    let label = "";
    let resourceId: string | null = null;

    if (newRuleType === "TAG") {
      value = newRuleTagValue.trim().toLowerCase();
      label = newRuleTagValue.trim();
    } else {
      const col = data.collections.find((c) => c.id === newRuleCollectionId);
      if (!col) return;
      value = col.id;
      label = col.title;
      resourceId = col.id;
    }

    if (!value) return;

    fetcher.submit(
      {
        intent: "addRule",
        effect: newRuleEffect,
        resourceType: newRuleType,
        value,
        label,
        resourceId: resourceId || "",
      },
      { method: "post" },
    );
    setShowAddModal(false);
    setNewRuleTagValue("");
    setNewRuleCollectionId("");
  }, [newRuleType, newRuleTagValue, newRuleCollectionId, newRuleEffect, data.collections, fetcher]);

  const handleRemoveRule = useCallback((ruleId: number) => {
    fetcher.submit({ intent: "removeRule", ruleId: String(ruleId) }, { method: "post" });
  }, [fetcher]);

  const handleSync = useCallback(() => {
    setSyncing(true);
    fetcher.submit({ intent: "sync" }, { method: "post" });
  }, [fetcher]);

  const handleCleanup = useCallback(() => {
    setCleaningUp(true);
    setShowCleanupModal(false);
    fetcher.submit({ intent: "cleanup" }, { method: "post" });
  }, [fetcher]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean; error?: string; message?: string };
      setSyncing(false);
      setCleaningUp(false);
      if (data.success) {
        setToastMessage(data.message || "Sync complete");
      } else if (data.error) {
        setToastMessage(`Sync error: ${data.error}`);
      }
    }
  }, [fetcher.state, fetcher.data]);

  // Auto-dismiss toast
  useEffect(() => {
    if (toastMessage) {
      const t = setTimeout(() => setToastMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toastMessage]);

  const depositPreview = `${amountEuros}${data.settings.currencyCode === "EUR" ? "Euro" : data.settings.currencyCode} per bottle`;

  const renderRulesTable = (
    rules: { id: number; label: string; effect: string; resourceType: string }[],
    emptyText: string,
  ) => {
    if (rules.length === 0) {
      return (
        <EmptyState image="">
          <Text as="p" tone="subdued">{emptyText}</Text>
        </EmptyState>
      );
    }
    return (
      <BlockStack gap="200">
        {rules.map((rule) => (
          <InlineStack key={rule.id} gap="200" align="space-between" blockAlign="center">
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={rule.resourceType === "TAG" ? "info" : "success"}>
                {rule.resourceType === "TAG" ? "Tag" : "Collection"}
              </Badge>
              <Text as="span" variant="bodyMd">{rule.label}</Text>
            </InlineStack>
            <Button tone="critical" variant="monochromePlain" onClick={() => handleRemoveRule(rule.id)}>
              Remove
            </Button>
          </InlineStack>
        ))}
      </BlockStack>
    );
  };

  return (
    <Page
      title="Deposit Settings"
      subtitle="Configure bottle deposit amount and eligibility rules"
      primaryAction={{
        content: "Save & Sync",
        onAction: handleSaveSettings,
      }}
      secondaryActions={[
        {
          content: "Sync Now",
          onAction: handleSync,
          loading: syncing,
        },
        {
          content: "Clean up before uninstall",
          onAction: () => setShowCleanupModal(true),
          loading: cleaningUp,
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {toastMessage && (
              <Banner tone={toastMessage.includes("error") ? "critical" : "success"} onDismiss={() => setToastMessage(null)}>
                {toastMessage}
              </Banner>
            )}

            {/* Main Settings */}
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Deposit Configuration</Text>

                <ChoiceList
                  title="Status"
                  choices={[
                    { label: "Enabled — deposit is active", value: "true" },
                    { label: "Disabled — no deposit applied", value: "false" },
                  ]}
                  selected={[String(enabled)]}
                  onChange={(selected) => setEnabled(selected[0] === "true")}
                />

                <ChoiceList
                  title="Deposit in the cart"
                  choices={[
                    {
                      label: "One shared deposit product",
                      value: "shared",
                      helpText:
                        'A "Bottle Deposit" line per drink, linked by a "Deposit for: <drink>" note.',
                    },
                    {
                      label: "A deposit product per drink",
                      value: "per_product",
                      helpText:
                        'The app creates "Deposit – <drink>" products; the line title shows the drink. Takes a moment on first sync.',
                    },
                  ]}
                  selected={[depositStyle]}
                  onChange={(selected) => setDepositStyle(selected[0])}
                />

                <TextField
                  label="Deposit amount per bottle"
                  type="number"
                  step={0.01}
                  min={0}
                  value={amountEuros}
                  onChange={setAmountEuros}
                  suffix="EUR"
                  autoComplete="off"
                  helpText="Default: 0.10 EUR. Stored in cents to avoid floating-point errors."
                />

                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3">Preview</Text>
                    <Text variant="bodyLg" as="p">
                      <Text as="span" fontWeight="bold">€2.50 + {depositPreview}</Text>
                    </Text>
                    <Text tone="subdued" as="p">
                      This text appears next to prices on the storefront.
                    </Text>
                    <Text tone="subdued" as="p">
                      {data.settings.depositStyle === "per_product"
                        ? 'In the cart and checkout each drink gets its own "Deposit – <drink>" line with its own price.'
                        : 'In the cart and checkout the deposit is a separate "Bottle Deposit" line with its own price, linked to each drink ("Deposit for: …").'}{" "}
                      Keep the "Deposit Price Display" app embed on — it adds and updates that line.
                    </Text>
                    {!data.settings.validationId && data.settings.lastSyncedAt && (
                      <Banner tone="warning">
                        This store's plan can't run Shopify Functions from a custom app, so checkout
                        can't verify the deposit line. "Buy it now" and express checkout buttons
                        skip the cart and won't add the deposit — consider turning off dynamic
                        checkout buttons for deposit products in your theme settings.
                      </Banner>
                    )}
                  </BlockStack>
                </Card>

                <InlineStack gap="400">
                  <Badge tone={data.settings.depositProductId ? "success" : "attention"}>
                    {`Deposit product: ${data.settings.depositProductId ? "Created" : "Not created"}`}
                  </Badge>
                  <Badge tone={data.settings.validationId ? "success" : "info"}>
                    {`Checkout check: ${
                      data.settings.validationId ? "Active" : "Not available on this plan"
                    }`}
                  </Badge>
                  {data.settings.lastSyncedAt && (
                    <Badge tone="info">
                      {`Last synced: ${new Date(data.settings.lastSyncedAt).toLocaleString()}`}
                    </Badge>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Include Rules */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">Include Rules</Text>
                    <Text tone="subdued" as="p">
                      Products matching these tags or collections WILL get a deposit.
                    </Text>
                  </BlockStack>
                  <Button onClick={() => { setNewRuleEffect("INCLUDE"); setShowAddModal(true); }}>
                    Add include rule
                  </Button>
                </InlineStack>

                <BlockStack gap="300">
                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3">Tags ({data.includeTags.length})</Text>
                    {renderRulesTable(data.includeTags, "No include tags yet")}
                  </BlockStack>

                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3">Collections ({data.includeCollections.length})</Text>
                    {renderRulesTable(data.includeCollections, "No include collections yet")}
                  </BlockStack>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Exclude Rules */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">Exclude Rules</Text>
                    <Text tone="subdued" as="p">
                      Products matching these tags or collections will NOT get a deposit.
                      Exclusions always override includes.
                    </Text>
                  </BlockStack>
                  <Button tone="critical" onClick={() => { setNewRuleEffect("EXCLUDE"); setShowAddModal(true); }}>
                    Add exclude rule
                  </Button>
                </InlineStack>

                <BlockStack gap="300">
                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3">Tags ({data.excludeTags.length})</Text>
                    {renderRulesTable(data.excludeTags, "No exclude tags yet")}
                  </BlockStack>

                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3">Collections ({data.excludeCollections.length})</Text>
                    {renderRulesTable(data.excludeCollections, "No exclude collections yet")}
                  </BlockStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Diagnostics</Text>
              <DataTable
                columnContentTypes={["text", "text"]}
                headings={["Metric", "Value"]}
                rows={[
                  ["Include rules", String(data.includeTags.length + data.includeCollections.length)],
                  ["Exclude rules", String(data.excludeTags.length + data.excludeCollections.length)],
                  ["Products with deposit", String(data.depositProductCount)],
                  [
                    "Plan",
                    {
                      dev_store: "Development store — free",
                      subscribed: "Subscribed",
                      trial: `Free trial · ${data.trialDaysLeft} day(s) left`,
                      trial_expired: "Trial ended",
                    }[data.billingReason],
                  ],
                  [
                    "Cart",
                    data.settings.depositStyle === "per_product"
                      ? "Deposit product per drink"
                      : "Shared deposit product",
                  ],
                  ["Deposit product", data.settings.depositProductId ? "Created" : "Pending"],
                  [
                    "Checkout check",
                    data.settings.validationId ? "Active" : "Not available on this plan",
                  ],
                  ["Last sync", data.settings.lastSyncedAt ? new Date(data.settings.lastSyncedAt).toLocaleString() : "Never"],
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Add Rule Modal */}
      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={`Add ${newRuleEffect === "INCLUDE" ? "Include" : "Exclude"} Rule`}
        primaryAction={{
          content: "Add Rule",
          onAction: handleAddRule,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setShowAddModal(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <ChoiceList
              title="Rule type"
              choices={[
                { label: "Tag — match products by tag", value: "TAG" },
                { label: "Collection — match products by collection", value: "COLLECTION" },
              ]}
              selected={[newRuleType]}
              onChange={(selected) => setNewRuleType(selected[0])}
            />

            {newRuleType === "TAG" ? (
              <Select
                label="Select tag"
                options={data.availableTags.map((t) => ({ label: t, value: t }))}
                value={newRuleTagValue}
                onChange={setNewRuleTagValue}
                placeholder="Choose a tag..."
              />
            ) : (
              <Select
                label="Select collection"
                options={data.collections.map((c) => ({ label: c.title, value: c.id }))}
                value={newRuleCollectionId}
                onChange={setNewRuleCollectionId}
                placeholder="Choose a collection..."
              />
            )}

            <Banner tone={newRuleEffect === "EXCLUDE" ? "critical" : "info"}>
              {newRuleEffect === "EXCLUDE"
                ? "Exclusion rules always take priority over inclusion rules."
                : "Products matching this rule will get a deposit (unless excluded by another rule)."}
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Cleanup Confirmation Modal */}
      <Modal
        open={showCleanupModal}
        onClose={() => setShowCleanupModal(false)}
        title="Clean up before uninstall"
        primaryAction={{
          content: "Yes, clean up everything",
          onAction: handleCleanup,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setShowCleanupModal(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Banner tone="critical">
              This will permanently remove all deposit data. Only do this if you plan to uninstall the app.
            </Banner>
            <Text as="p">The following will be deleted:</Text>
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="critical">1</Badge>
                <Text as="span">Checkout check — stops the deposit Function from running</Text>
              </InlineStack>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="critical">2</Badge>
                <Text as="span">Bottle Deposit product — removed from your catalog</Text>
              </InlineStack>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="critical">3</Badge>
                <Text as="span">All rules and settings — deleted from the database</Text>
              </InlineStack>
            </BlockStack>
            <Text tone="subdued" as="p">
              App-owned metafields are automatically removed by Shopify when you uninstall.
              After cleanup, you can safely uninstall the app from your Shopify admin.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
