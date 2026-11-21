import { describe, expect, test, vi } from "vitest";
import type * as vscode from "vscode";
import { PlanUsageService, planSource } from "../src/host/planUsage";
import type { ModelProfile } from "../src/providers/profile";

const profile = (overrides: Partial<ModelProfile>): ModelProfile => ({
  id: "p",
  name: "Model",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "m",
  auth: "bearer",
  headers: {},
  query: {},
  extraBody: {},
  ...overrides,
});
const log = { warn: () => {}, debug: () => {} } as unknown as vscode.LogOutputChannel;
const copilotUser = {
  access_type_sku: "copilot_for_business_seat",
  copilot_plan: "business",
  quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, unlimited: false } },
  quota_reset_date: "2026-12-01",
};
const answering = (body: unknown, calls: { url: string; auth: string }[] = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    return new Response(JSON.stringify(typeof body === "function" ? (body as (url: string) => unknown)(url) : body), {
      status: 200,
    });
  }) as unknown as typeof fetch;

describe("planSource", () => {
  test("knows the providers that tell their plan", () => {
    expect(planSource(profile({ baseUrl: "https://api.business.githubcopilot.com" }))).toBe("copilot");
    expect(planSource(profile({ provider: "vscode", baseUrl: "" }))).toBe("copilot-vscode");
    expect(planSource(profile({ baseUrl: "https://openrouter.ai/api/v1" }))).toBe("openrouter");
    expect(planSource(profile({ baseUrl: "https://api.deepseek.com/v1" }))).toBe("deepseek");
    expect(planSource(profile({}))).toBeUndefined();
    expect(planSource(profile({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" }))).toBeUndefined();
    expect(planSource(profile({ baseUrl: "https://githubcopilot.com.evil.example/v1" }))).toBeUndefined();
  });
});

describe("PlanUsageService", () => {
  test("asks nothing by itself: only a check asks, once", async () => {
    const calls: { url: string; auth: string }[] = [];
    const service = new PlanUsageService(
      async () => "ghu_key",
      log,
      async () => undefined,
      answering(copilotUser, calls),
    );
    const copilot = profile({ id: "c", baseUrl: "https://api.business.githubcopilot.com" });
    expect(service.last(copilot)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([]);
    const usage = await service.check(copilot);
    expect(usage).toMatchObject({ plan: "Business", main: { remaining: 120, limit: 300 } });
    expect(service.last(copilot)?.usage.plan).toBe("Business");
    expect(calls).toEqual([{ url: "https://api.github.com/copilot_internal/user", auth: "token ghu_key" }]);
    // Reading the last check asks nothing again.
    service.last(copilot);
    expect(calls).toHaveLength(1);
  });

  test("two clicks at once make one request", async () => {
    const calls: { url: string; auth: string }[] = [];
    const service = new PlanUsageService(
      async () => "k",
      log,
      async () => undefined,
      answering(copilotUser, calls),
    );
    const copilot = profile({ id: "c", baseUrl: "https://api.individual.githubcopilot.com" });
    await Promise.all([service.check(copilot), service.check(copilot)]);
    expect(calls).toHaveLength(1);
  });

  test("Copilot models of VS Code use the GitHub sign-in of VS Code, and nothing without it", async () => {
    const calls: { url: string; auth: string }[] = [];
    const signedIn = new PlanUsageService(
      async () => undefined,
      log,
      async () => "gho_vscode",
      answering(copilotUser, calls),
    );
    await signedIn.check(profile({ id: "v", provider: "vscode", baseUrl: "" }));
    expect(calls.map((call) => call.auth)).toEqual(["token gho_vscode"]);
    const signedOut = new PlanUsageService(
      async () => undefined,
      log,
      async () => undefined,
      answering(copilotUser, calls),
    );
    expect(await signedOut.check(profile({ id: "v2", provider: "vscode", baseUrl: "" }))).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("OpenRouter: credits and the plan of the key", async () => {
    const service = new PlanUsageService(
      async () => "sk-or",
      log,
      async () => undefined,
      answering((url: string) =>
        url.endsWith("/credits") ? { data: { total_credits: 10, total_usage: 4 } } : { data: { is_free_tier: false } },
      ),
    );
    expect(await service.check(profile({ id: "o", baseUrl: "https://openrouter.ai/api/v1/" }))).toMatchObject({
      plan: "Paid",
      main: { remaining: 6, limit: 10 },
    });
  });

  test("a failed check says why and keeps the last plan", async () => {
    let fail = false;
    const fetchFunction = (async () =>
      fail
        ? new Response("no", { status: 500 })
        : new Response(JSON.stringify(copilotUser), { status: 200 })) as unknown as typeof fetch;
    const service = new PlanUsageService(
      async () => "k",
      log,
      async () => undefined,
      fetchFunction,
    );
    const copilot = profile({ id: "c", baseUrl: "https://api.individual.githubcopilot.com" });
    await service.check(copilot);
    fail = true;
    await expect(service.check(copilot)).rejects.toThrow(/500/);
    expect(service.last(copilot)?.usage.plan).toBe("Business");
  });

  test("other providers are never asked", async () => {
    const fetchFunction = vi.fn() as unknown as typeof fetch;
    const service = new PlanUsageService(
      async () => "k",
      log,
      async () => undefined,
      fetchFunction,
    );
    expect(
      await service.check(profile({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" })),
    ).toBeUndefined();
    expect(fetchFunction).not.toHaveBeenCalled();
  });
});
