import { describe, expect, test, vi } from "vitest";
import type * as vscode from "vscode";
import { PriceCatalogService } from "../src/host/priceCatalog";
import type { ModelProfile } from "../src/providers/profile";

const catalogBody = {
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" },
    },
    { id: "openai/gpt-5.1", pricing: { prompt: "0.00000125", completion: "0.00001" } },
  ],
};
const log = { info: () => {}, warn: () => {} } as unknown as vscode.LogOutputChannel;

function memory(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    keys: () => [...values.keys()],
  } as unknown as vscode.Memento;
}

function setup(profiles: ModelProfile[], fetchFunction?: typeof fetch, day = new Date(2026, 10, 21)) {
  const current = new Map(profiles.map((profile) => [profile.id, profile]));
  const models = {
    profiles: () => ({ profiles: [...current.values()] }),
    update: vi.fn(async (id: string, changes: Partial<ModelProfile>) => {
      current.set(id, { ...(current.get(id) as ModelProfile), ...changes });
    }),
  };
  const fetchMock =
    fetchFunction ??
    (vi.fn(async () => new Response(JSON.stringify(catalogBody), { status: 200 })) as unknown as typeof fetch);
  let now = day;
  const service = new PriceCatalogService(memory(), models, log, fetchMock, () => now);
  return { service, models, current, fetchMock, nextDay: () => (now = new Date(now.getTime() + 86_400_000)) };
}

const profile = (id: string, overrides: Partial<ModelProfile>): ModelProfile => ({
  id,
  name: id,
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude-sonnet-5-5",
  auth: "x-api-key",
  headers: {},
  query: {},
  extraBody: {},
  ...overrides,
});

describe("PriceCatalogService", () => {
  test("fills a missing price from the catalog, with its source and day", async () => {
    const { service, current } = setup([profile("a", {})]);
    expect(await service.apply()).toBe(1);
    expect(current.get("a")?.price).toEqual({
      input: 2,
      output: 10,
      cachedInput: 0.1,
      source: "catalog",
      checked: "2026-11-21",
    });
  });

  test("never overwrites a price of the user, also an old one without a source", async () => {
    const mine = { input: 1.5, output: 7, source: "user" as const };
    const old = { input: 9, output: 9 };
    const { service, current, models } = setup([profile("a", { price: mine }), profile("b", { price: old })]);
    expect(await service.apply()).toBe(0);
    expect(current.get("a")?.price).toEqual(mine);
    expect(current.get("b")?.price).toEqual(old);
    expect(models.update).not.toHaveBeenCalled();
  });

  test("downloads the catalog once a day, and writes the settings only when a price changes", async () => {
    const { service, fetchMock, models, nextDay } = setup([profile("a", {})]);
    await service.apply();
    await service.apply();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(models.update).toHaveBeenCalledTimes(1);
    nextDay();
    await service.apply();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(models.update).toHaveBeenCalledTimes(1);
  });

  test("downloads nothing when no model needs the catalog", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const { service, current } = setup(
      [
        profile("local", { provider: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen3" }),
        profile("copilot", { provider: "openai", baseUrl: "https://api.individual.githubcopilot.com", model: "x" }),
        profile("mine", { price: { input: 1, output: 1, source: "user" } }),
      ],
      fetchMock,
    );
    await service.apply();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(current.get("local")?.price).toEqual({ input: 0, output: 0, source: "local", checked: "2026-11-21" });
    expect(current.get("copilot")?.price).toBeUndefined();
  });

  test("without the network, the last catalog still works, and nothing breaks", async () => {
    let online = true;
    const fetchMock = (async () => {
      if (!online) throw new Error("offline");
      return new Response(JSON.stringify(catalogBody), { status: 200 });
    }) as unknown as typeof fetch;
    const { service, current, nextDay } = setup([profile("a", {})], fetchMock);
    await service.apply();
    online = false;
    nextDay();
    current.set("b", profile("b", { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" }));
    await expect(service.apply()).resolves.toBe(1);
    expect(current.get("b")?.price?.input).toBe(1.25);
  });

  test("a catalog price follows the catalog when the provider changes it", async () => {
    const changed = {
      data: [{ id: "anthropic/claude-sonnet-5.5", pricing: { prompt: "0.0000015", completion: "0.000008" } }],
    };
    let body: unknown = catalogBody;
    const fetchMock = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const { service, current, nextDay } = setup([profile("a", {})], fetchMock);
    await service.apply();
    body = changed;
    nextDay();
    await service.apply();
    expect(current.get("a")?.price).toMatchObject({ input: 1.5, output: 8, source: "catalog", checked: "2026-11-22" });
  });

  test("two updates at once download once", async () => {
    const { service, fetchMock } = setup([profile("a", {})]);
    await Promise.all([service.apply(), service.apply()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
