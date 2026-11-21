import { describe, expect, test } from "vitest";
import { automaticPrice, matchPrice, parseOpenRouterModels, vendorOf } from "../src/core/priceCatalog";

/** The shape of https://openrouter.ai/api/v1/models: US dollars per token, as strings. */
const catalog = parseOpenRouterModels({
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" },
    },
    { id: "anthropic/claude-sonnet-5.5:batch", pricing: { prompt: "0.000001", completion: "0.000005" } },
    {
      id: "anthropic/claude-haiku-4.5",
      pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001" },
    },
    { id: "openai/gpt-5.1", pricing: { prompt: "0.00000125", completion: "0.00001", input_cache_read: "0.000000125" } },
    { id: "google/gemini-2.5-pro", pricing: { prompt: "0.00000125", completion: "0.00001" } },
    { id: "mistralai/mistral-large", pricing: { prompt: "0.000002", completion: "0.000006" } },
    { id: "openai/gpt-x", pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "openai/gpt.x", pricing: { prompt: "0.000003", completion: "0.000004" } },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
    { id: "broken", pricing: {} },
  ],
});
const profile = (provider: string, baseUrl: string, model: string, price?: { source?: "user" | "catalog" }) => ({
  provider,
  baseUrl,
  model,
  ...(price ? { price } : {}),
});

describe("parseOpenRouterModels", () => {
  test("turns prices per token into prices per million, and skips prices that are not prices", () => {
    expect(catalog.find((entry) => entry.id === "anthropic/claude-sonnet-5.5")).toEqual({
      id: "anthropic/claude-sonnet-5.5",
      input: 2,
      output: 10,
      cachedInput: 0.1,
    });
    expect(catalog.some((entry) => entry.id === "openrouter/auto" || entry.id === "broken")).toBe(false);
    expect(parseOpenRouterModels({ error: "x" })).toEqual([]);
  });
});

describe("vendorOf", () => {
  test("only vendors that sell at their own price on OpenRouter, and local models", () => {
    expect(vendorOf({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toBe("anthropic");
    expect(vendorOf({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).toBe("openai");
    expect(vendorOf({ provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" })).toBe(
      "google",
    );
    expect(vendorOf({ provider: "openai", baseUrl: "https://openrouter.ai/api/v1" })).toBe("openrouter");
    expect(vendorOf({ provider: "openai", baseUrl: "http://localhost:11434/v1" })).toBe("local");
    expect(vendorOf({ provider: "openai", baseUrl: "https://api.deepseek.com/v1" })).toBeUndefined();
    expect(vendorOf({ provider: "openai", baseUrl: "https://api.individual.githubcopilot.com" })).toBeUndefined();
    expect(vendorOf({ provider: "anthropic", baseUrl: "https://gateway.example.com/anthropic" })).toBeUndefined();
    expect(vendorOf({ provider: "openai", baseUrl: "https://openai.com.evil.example/v1" })).toBeUndefined();
  });
});

describe("matchPrice", () => {
  test("dots and dashes are the same, and a dated snapshot has the price of its model", () => {
    expect(matchPrice("claude-sonnet-5-5", "anthropic", catalog)?.input).toBe(2);
    expect(matchPrice("claude-haiku-4-5-20251001", "anthropic", catalog)?.output).toBe(5);
    expect(matchPrice("gpt-5.1", "openai", catalog)?.cachedInput).toBe(0.125);
  });

  test("no price for a model that is not there, or that matches twice", () => {
    expect(matchPrice("claude-opus-9", "anthropic", catalog)).toBeUndefined();
    expect(matchPrice("gpt-x", "openai", catalog)).toBeUndefined();
    expect(matchPrice("claude-sonnet-5.5", undefined, catalog)).toBeUndefined();
  });

  test("a special variant such as :batch is never the price of the model", () => {
    expect(matchPrice("claude-sonnet-5.5", "anthropic", catalog)?.input).toBe(2);
  });

  test("OpenRouter takes its own ids as they are", () => {
    expect(matchPrice("anthropic/claude-sonnet-5.5", "openrouter", catalog)?.output).toBe(10);
    expect(matchPrice("claude-sonnet-5.5", "openrouter", catalog)).toBeUndefined();
  });
});

describe("automaticPrice", () => {
  const today = "2026-11-21";

  test("fills the price with its source and day", () => {
    expect(
      automaticPrice(profile("anthropic", "https://api.anthropic.com/v1", "claude-sonnet-5-5"), catalog, today),
    ).toEqual({
      input: 2,
      output: 10,
      cachedInput: 0.1,
      source: "catalog",
      checked: today,
    });
    expect(
      automaticPrice(profile("openai", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5.5"), catalog, today)
        ?.source,
    ).toBe("provider");
    expect(automaticPrice(profile("openai", "http://127.0.0.1:1234/v1", "qwen"), catalog, today)).toEqual({
      input: 0,
      output: 0,
      source: "local",
      checked: today,
    });
  });

  test("never touches a price of the user, also an old one without a source", () => {
    const base = profile("anthropic", "https://api.anthropic.com/v1", "claude-sonnet-5-5");
    expect(automaticPrice({ ...base, price: { source: "user" } }, catalog, today)).toBeUndefined();
    expect(automaticPrice({ ...base, price: {} }, catalog, today)).toBeUndefined();
  });

  test("updates a price that came from the catalog", () => {
    const base = profile("anthropic", "https://api.anthropic.com/v1", "claude-sonnet-5-5", { source: "catalog" });
    expect(automaticPrice(base, catalog, today)?.input).toBe(2);
  });

  test("leaves a model without an exact match without a price", () => {
    expect(
      automaticPrice(profile("anthropic", "https://api.anthropic.com/v1", "claude-opus-9"), catalog, today),
    ).toBeUndefined();
    expect(
      automaticPrice(profile("openai", "https://api.individual.githubcopilot.com", "claude-haiku-5.5"), catalog, today),
    ).toBeUndefined();
  });
});
