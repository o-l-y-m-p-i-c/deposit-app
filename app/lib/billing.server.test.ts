import { afterEach, describe, expect, it, vi } from "vitest";
import { TRIAL_DAYS, getBillingAccess, nextTrialState } from "./billing.server";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-26T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("getBillingAccess", () => {
  it("grants a trial for the first 14 days", () => {
    const access = getBillingAccess(
      { trialStartedAt: daysAgo(3), isDevStore: false, subscriptionStatus: null },
      now,
    );
    expect(access).toMatchObject({ hasAccess: true, reason: "trial", trialDaysLeft: TRIAL_DAYS - 3 });
  });

  it("blocks access once the trial is over without a subscription", () => {
    const access = getBillingAccess(
      { trialStartedAt: daysAgo(20), isDevStore: false, subscriptionStatus: "CANCELLED" },
      now,
    );
    expect(access).toMatchObject({ hasAccess: false, reason: "trial_expired", trialDaysLeft: 0 });
  });

  it("keeps development stores free", () => {
    const access = getBillingAccess(
      { trialStartedAt: daysAgo(400), isDevStore: true, subscriptionStatus: null },
      now,
    );
    expect(access).toMatchObject({ hasAccess: true, reason: "dev_store" });
  });

  it("grants access with an active subscription", () => {
    const access = getBillingAccess(
      { trialStartedAt: daysAgo(90), isDevStore: false, subscriptionStatus: "ACTIVE" },
      now,
    );
    expect(access).toMatchObject({ hasAccess: true, reason: "subscribed" });
  });
});

describe("nextTrialState", () => {
  it("restarts the trial when a development store is transferred to a paid plan", () => {
    const trial = nextTrialState({ trialStartedAt: daysAgo(400), devStore: true }, false, now);
    expect(trial).toEqual({ devStore: false, trialStartedAt: now });
    expect(getBillingAccess({ ...trial, isDevStore: false, subscriptionStatus: null }, now)).toMatchObject({
      hasAccess: true,
      reason: "trial",
      trialDaysLeft: TRIAL_DAYS,
    });
  });

  it("keeps the original trial start otherwise", () => {
    const started = daysAgo(20);
    expect(nextTrialState({ trialStartedAt: started, devStore: false }, false, now).trialStartedAt).toBe(started);
    expect(nextTrialState({ trialStartedAt: started, devStore: false }, true, now)).toEqual({
      devStore: true,
      trialStartedAt: started,
    });
  });
});

describe("plan env vars", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads overrides", async () => {
    vi.stubEnv("BILLING_PLAN_PRICE", "19");
    vi.stubEnv("BILLING_TRIAL_DAYS", "7");
    vi.stubEnv("BILLING_PLAN_CURRENCY", "eur");
    vi.resetModules();
    const plan = await import("./billing.server");
    expect([plan.PLAN_PRICE, plan.TRIAL_DAYS, plan.PLAN_CURRENCY]).toEqual([19, 7, "EUR"]);
  });

  it("rejects a fractional trial length", async () => {
    vi.stubEnv("BILLING_TRIAL_DAYS", "7.5");
    vi.resetModules();
    await expect(import("./billing.server")).rejects.toThrow("Invalid BILLING_TRIAL_DAYS");
  });
});
