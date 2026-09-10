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
import { useLoaderData, useSubmit, useFetcher } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { getSettings, updateSettings } from "~/models/settings.server";
import { getRules, addRule, removeRule } from "~/models/rules.server";
import { fullSync } from "~/lib/deposit.server";
import { adminGraphql, GET_PRODUCT_TAGS, GET_COLLECTIONS } from "~/lib/admin-api.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const rules = await getRules(session.shop);

  const includeTags = rules.filter((r) => r.effect === "INCLUDE" && r.resourceType === "TAG");
  const includeCollections = rules.filter((r) => r.effect === "INCLUDE" && r.resourceType === "COLLECTION");
  const excludeTags = rules.filter((r) => r.effect === "EXCLUDE" && r.resourceType === "TAG");
  const excludeCollections = rules.filter((r) => r.effect === "EXCLUDE" && r.resourceType === "COLLECTION");

  // Fetch available tags from Shopify
  let availableTags: string[] = [];
  try {
    const result = await adminGraphql(GET_PRODUCT_TAGS, {}, session.shop);
    availableTags = result?.data?.shop?.productTags?.edges?.map((e: { node: string }) => e.node) || [];
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
      cartTransformId: settings.cartTransformId,
      lastSyncedAt: settings.lastSyncedAt,
    },
    includeTags,
    includeCollections,
    excludeTags,
    excludeCollections,
    availableTags,
    collections,
  });
}

async function getShopId(admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"]): Promise<string | null> {
  try {
    const response = await admin.graphql(`#graphql\nquery { shop { id } }`);
    const data = await response.json();
    return data?.data?.shop?.id ?? null;
  } catch {
    return null;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.formData();
  const intent = body.get("intent") as string;

  if (intent === "updateSettings") {
    const enabled = body.get("enabled") === "true";
    const amountMinor = parseInt(body.get("amountMinor") as string, 10);
    if (isNaN(amountMinor) || amountMinor < 0) {
      return json({ error: "Invalid deposit amount" }, { status: 400 });
    }

    await updateSettings(session.shop, { enabled, amountMinor });

    // Trigger full sync
    try {
      const shopId = await getShopId(admin);
      if (shopId) {
        await fullSync(session.shop, shopId);
      }
    } catch (e) {
      console.error("[action updateSettings] Sync failed:", e);
    }

    return json({ success: true });
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
      const shopId = await getShopId(admin);
      if (shopId) {
        await fullSync(session.shop, shopId);
      }
    } catch (e) {
      console.error("[action addRule] Sync failed:", e);
    }

    return json({ success: true });
  }

  if (intent === "removeRule") {
    const ruleId = parseInt(body.get("ruleId") as string, 10);
    if (isNaN(ruleId)) {
      return json({ error: "Invalid rule ID" }, { status: 400 });
    }

    await removeRule(session.shop, ruleId);

    // Trigger full sync
    try {
      const shopId = await getShopId(admin);
      if (shopId) {
        await fullSync(session.shop, shopId);
      }
    } catch (e) {
      console.error("[action removeRule] Sync failed:", e);
    }

    return json({ success: true });
  }

  if (intent === "sync") {
    try {
      const shopId = await getShopId(admin);
      if (shopId) {
        await fullSync(session.shop, shopId);
      }
      return json({ success: true });
    } catch (e) {
      return json({ error: String(e) }, { status: 500 });
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const fetcher = useFetcher();

  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [amountEuros, setAmountEuros] = useState((data.settings.amountMinor / 100).toFixed(2));
  const [showAddModal, setShowAddModal] = useState(false);
  const [newRuleEffect, setNewRuleEffect] = useState("INCLUDE");
  const [newRuleType, setNewRuleType] = useState("TAG");
  const [newRuleTagValue, setNewRuleTagValue] = useState("");
  const [newRuleCollectionId, setNewRuleCollectionId] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(data.settings.enabled);
    setAmountEuros((data.settings.amountMinor / 100).toFixed(2));
  }, [data.settings.enabled, data.settings.amountMinor]);

  const handleSaveSettings = useCallback(() => {
    const amountMinor = Math.round(parseFloat(amountEuros) * 100);
    if (isNaN(amountMinor) || amountMinor < 0) {
      setToastMessage("Invalid amount");
      return;
    }
    submit(
      { intent: "updateSettings", enabled: String(enabled), amountMinor: String(amountMinor) },
      { method: "post" },
    );
    setToastMessage("Settings saved and synced");
  }, [amountEuros, enabled, submit]);

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

    submit(
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
    setToastMessage("Rule added and synced");
  }, [newRuleType, newRuleTagValue, newRuleCollectionId, newRuleEffect, data.collections, submit]);

  const handleRemoveRule = useCallback((ruleId: number) => {
    submit({ intent: "removeRule", ruleId: String(ruleId) }, { method: "post" });
    setToastMessage("Rule removed and synced");
  }, [submit]);

  const handleSync = useCallback(() => {
    setSyncing(true);
    fetcher.submit({ intent: "sync" }, { method: "post" });
  }, [fetcher]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean; error?: string };
      setSyncing(false);
      if (data.success) {
        setToastMessage("Sync complete");
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
                  </BlockStack>
                </Card>

                <InlineStack gap="400">
                  <Badge tone={data.settings.depositProductId ? "success" : "attention"}>
                    {`Deposit product: ${data.settings.depositProductId ? "Created" : "Not created"}`}
                  </Badge>
                  <Badge tone={data.settings.cartTransformId ? "success" : "attention"}>
                    {`Cart Transform: ${data.settings.cartTransformId ? "Active" : "Not created"}`}
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
                  ["Deposit product", data.settings.depositProductId ? "Created" : "Pending"],
                  ["Cart Transform", data.settings.cartTransformId ? "Active" : "Pending"],
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
    </Page>
  );
}
