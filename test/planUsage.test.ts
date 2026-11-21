import { describe, expect, test } from "vitest";
import {
  budgetRing,
  describeQuota,
  parseCopilotUser,
  parseDeepSeekBalance,
  parseOpenRouter,
  planRing,
} from "../src/core/planUsage";

const snapshot = (entitlement: number, remaining: number, unlimited = false) => ({
  entitlement,
  remaining,
  quota_remaining: remaining,
  percent_remaining: entitlement ? (remaining / entitlement) * 100 : 0,
  unlimited,
  overage_count: 0,
});

/** The shape of api.github.com/copilot_internal/user, as GitHub answered in November 2026. */
const copilotFree = {
  access_type_sku: "free_limited_copilot",
  copilot_plan: "individual",
  quota_snapshots: {
    chat: snapshot(200, 190),
    completions: snapshot(2000, 1960),
    premium_interactions: snapshot(0, 0),
  },
  quota_reset_date: "2026-12-01",
};

const copilotBusiness = {
  access_type_sku: "copilot_for_business_seat",
  copilot_plan: "business",
  quota_snapshots: {
    chat: snapshot(0, 0, true),
    completions: snapshot(0, 0, true),
    premium_interactions: snapshot(300, 120),
  },
  quota_reset_date: "2026-12-01",
};

describe("GitHub Copilot", () => {
  test("the free plan counts chat messages", () => {
    const usage = parseCopilotUser(copilotFree);
    expect(usage?.plan).toBe("Free");
    expect(usage?.main).toEqual({
      name: "Chat messages",
      unit: "requests",
      unlimited: false,
      limit: 200,
      remaining: 190,
      used: 10,
    });
    expect(usage?.others.map((item) => item.name)).toEqual(["Completions"]);
    expect(usage?.resetsOn).toBe("2026-12-01");
  });

  test("a paid plan counts premium requests; unlimited chat is a detail", () => {
    const usage = parseCopilotUser(copilotBusiness);
    expect(usage?.plan).toBe("Business");
    expect(usage?.main).toMatchObject({ name: "Premium requests", limit: 300, remaining: 120, used: 180 });
    expect(usage?.others.map(describeQuota)).toEqual(["Chat messages: unlimited", "Completions: unlimited"]);
  });

  test("names the plans", () => {
    const plan = (sku: string, kind: string) =>
      parseCopilotUser({ ...copilotBusiness, access_type_sku: sku, copilot_plan: kind })?.plan;
    expect(plan("copilot_enterprise_seat", "enterprise")).toBe("Enterprise");
    expect(plan("monthly_subscriber", "individual")).toBe("Pro");
    expect(plan("plus_monthly_subscriber", "individual")).toBe("Pro+");
  });

  test("unlimited premium requests fill the ring", () => {
    const usage = parseCopilotUser({
      ...copilotBusiness,
      quota_snapshots: { premium_interactions: snapshot(0, 0, true) },
    });
    expect(planRing(usage as never)).toMatchObject({ left: 1, short: "∞" });
  });

  test("an answer without quotas or a plan is no plan", () => {
    expect(parseCopilotUser({ message: "Not Found" })).toBeUndefined();
    expect(parseCopilotUser(null)).toBeUndefined();
  });
});

describe("OpenRouter and DeepSeek", () => {
  test("OpenRouter credits", () => {
    const usage = parseOpenRouter({ data: { total_credits: 10, total_usage: 2.5 } }, { data: { is_free_tier: false } });
    expect(usage).toMatchObject({
      plan: "Paid",
      main: { name: "Credits", unit: "USD", limit: 10, used: 2.5, remaining: 7.5 },
    });
    expect(describeQuota(usage?.main as never)).toBe("Credits: $7.50 of $10.00 left ($2.50 used)");
  });

  test("an OpenRouter key on the free tier without credits", () => {
    const usage = parseOpenRouter({}, { data: { is_free_tier: true } });
    expect(usage?.plan).toBe("Free");
    expect(usage?.main).toBeUndefined();
    expect(planRing(usage as never)).toBeUndefined();
  });

  test("DeepSeek balance: what is left, without a limit", () => {
    const usage = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0", topped_up_balance: "4.20" }],
    });
    expect(planRing(usage as never)).toEqual({
      plan: "Pay as you go",
      short: "$4.20",
      details: ["DeepSeek Pay as you go", "Balance: $4.20 left"],
    });
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeUndefined();
  });
});

describe("the ring", () => {
  test("shows what is left, the plan, and when it starts again", () => {
    const ring = planRing(parseCopilotUser(copilotFree) as never, new Date("2026-11-21T10:00:00Z"));
    expect(ring).toEqual({
      plan: "Free",
      left: 0.95,
      short: "190/200",
      details: [
        "GitHub Copilot Free",
        "Chat messages: 190 of 200 left (10 used)",
        "Completions: 1960 of 2000 left (40 used)",
        "Starts again on Dec 1 (in 10 days)",
      ],
    });
  });

  test("an empty quota is an empty ring, and odd numbers stay in range", () => {
    const usage = parseCopilotUser({ ...copilotBusiness, quota_snapshots: { premium_interactions: snapshot(300, 0) } });
    expect(planRing(usage as never)?.left).toBe(0);
    const odd = parseCopilotUser({ ...copilotBusiness, quota_snapshots: { premium_interactions: snapshot(300, 400) } });
    expect(planRing(odd as never)?.left).toBe(1);
  });

  test("a fractional quota keeps one decimal", () => {
    expect(describeQuota({ name: "Chat messages", unit: "requests", limit: 200, remaining: 190.5 })).toBe(
      "Chat messages: 190.5 of 200 left",
    );
  });
});

describe("the budget ring", () => {
  const today = new Date(2026, 10, 21, 12);

  test("shows what Phew spent of the budget this month", () => {
    expect(budgetRing({ name: "Claude", budget: 20, spent: 7.4, priced: true, today })).toEqual({
      plan: "Budget",
      left: 0.63,
      short: "$7.40/$20",
      details: [
        "Budget of Claude: $20 a month",
        "Spent through Phew: $7.40, $12.60 left",
        "Counted by Phew from the tokens of each answer and the price of the model. Use of the same key elsewhere is not counted.",
        "Starts again on Dec 1 (in 10 days)",
      ],
    });
  });

  test("an overspent budget is an empty ring", () => {
    const ring = budgetRing({ name: "Claude", budget: 5, spent: 6.2, priced: true, today });
    expect(ring.left).toBe(0);
    expect(ring.details[1]).toBe("Spent through Phew: $6.20, $0.00 left");
  });

  test("without a price, Phew says that it cannot count money", () => {
    const ring = budgetRing({ name: "Claude", budget: 20, spent: 0, priced: false, today });
    expect(ring.left).toBeUndefined();
    expect(ring.short).toBe("?/$20");
    expect(ring.details[1]).toMatch(/no price/);
  });
});
