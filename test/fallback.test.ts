import { describe, expect, test, vi } from "vitest";
import type { CompletionRequest, CompletionResult, ModelClient } from "../src/core/chat";
import { CostMeter } from "../src/core/cost";
import {
  FallbackClient,
  failureKind,
  fallbackChain,
  fallbackReason,
  ProviderError,
  shouldFallBack,
} from "../src/core/fallback";
import { chooseModelId, modelPicks, pinnedModelId } from "../src/core/modelChoice";
import { AnthropicClient } from "../src/providers/anthropic";
import { finalError, httpError } from "../src/providers/http";
import { OpenAiCompatibleClient } from "../src/providers/openaiCompatible";
import { type ModelProfile, parseProfile as parseOne, parseProfiles, serializeProfile } from "../src/providers/profile";

const request = (signal = new AbortController().signal): CompletionRequest => ({
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  signal,
});

const answer = (content: string): CompletionResult => ({ content, toolCalls: [] });

/** A client that answers or fails in order, and counts its calls. */
function scripted(...steps: (string | Error)[]): ModelClient & { calls: number } {
  const client = {
    calls: 0,
    async complete(_request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
      const step = steps[Math.min(client.calls, steps.length - 1)];
      client.calls++;
      if (step instanceof Error) throw step;
      onText(step as string);
      return answer(step as string);
    },
  };
  return client;
}

const quota = () => new ProviderError("Claude (work): your account has no quota or credit left.", "quota", 402);
const rate = () => new ProviderError("Claude (work) rate limit reached after 4 attempts.", "rate", 429);

describe("failure kinds", () => {
  test("a provider error keeps its kind", () => {
    expect(failureKind(quota())).toBe("quota");
    expect(failureKind(new ProviderError("x", "auth", 401))).toBe("auth");
  });

  test("other errors are read from their words", () => {
    expect(failureKind(new Error("insufficient_quota: You exceeded your current quota"))).toBe("quota");
    expect(failureKind(new Error("Your credit balance is too low"))).toBe("quota");
    expect(failureKind(new Error("Anthropic returned an error: Overloaded"))).toBe("overloaded");
    expect(failureKind(new Error("Too Many Requests"))).toBe("rate");
    expect(failureKind(new Error("Invalid API key"))).toBe("auth");
    expect(failureKind(new Error("The model returned an error: bad tool schema"))).toBe("other");
    expect(failureKind("plain text")).toBe("other");
  });

  test("only quota, lasting rate limits, and overload fall back", () => {
    expect(shouldFallBack(quota())).toBe(true);
    expect(shouldFallBack(rate())).toBe(true);
    expect(shouldFallBack(new ProviderError("x", "overloaded", 529))).toBe(true);
    expect(shouldFallBack(new ProviderError("x", "auth", 401))).toBe(false);
    expect(shouldFallBack(new ProviderError("x", "other", 400))).toBe(false);
    expect(shouldFallBack(new Error("Cannot reach Anthropic"))).toBe(false);
  });

  test("a stopped request never falls back, whatever it says", () => {
    const abort = new Error("quota exceeded");
    abort.name = "AbortError";
    expect(shouldFallBack(abort)).toBe(false);
  });

  test("the reason reads well in the chat", () => {
    expect(fallbackReason(quota())).toBe("has no quota or credit left");
    expect(fallbackReason(rate())).toBe("stays rate limited");
    expect(fallbackReason(new ProviderError("x", "overloaded"))).toBe("is overloaded");
    expect(fallbackReason(new Error("?"))).toBe("failed");
  });
});

describe("the errors of the providers", () => {
  test("finalError names the kind of each failure", () => {
    const cases: [number, string, string][] = [
      [429, '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}', "quota"],
      [402, '{"error":"Payment required: out of credits"}', "quota"],
      [403, '{"error":{"message":"Your credit balance is too low to access the API."}}', "quota"],
      [
        400,
        '{"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
        "quota",
      ],
      [429, '{"error":"slow down"}', "rate"],
      [529, '{"type":"error","error":{"type":"overloaded_error"}}', "overloaded"],
      [503, "", "overloaded"],
      [401, '{"error":"invalid x-api-key"}', "auth"],
      [403, '{"error":"forbidden"}', "auth"],
      [400, '{"error":"bad"}', "other"],
      [500, "boom", "other"],
    ];
    for (const [status, body, kind] of cases) {
      const error = finalError("Claude", status, body, 4);
      expect(error, `${status} ${body}`).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind, `${status} ${body}`).toBe(kind);
      expect((error as ProviderError).status).toBe(status);
    }
  });

  test("the messages stay the same for people", () => {
    expect(finalError("X", 429, '{"error":"slow"}', 4).message).toMatch(/rate limit reached after 4 attempts/);
    expect(httpError("X", 401, "{}").message).toMatch(/Check the API key/);
  });
});

describe("fallbackChain", () => {
  const profiles = [
    { id: "work", fallback: "personal" },
    { id: "personal", fallback: "gpt" },
    { id: "gpt", fallback: "local" },
    { id: "local" },
  ];

  test("follows the fallbacks up to three models", () => {
    expect(fallbackChain("work", profiles)).toEqual(["work", "personal", "gpt"]);
    expect(fallbackChain("work", profiles, 4)).toEqual(["work", "personal", "gpt", "local"]);
    expect(fallbackChain("local", profiles)).toEqual(["local"]);
  });

  test("stops at a loop, at the model itself, and at a removed model", () => {
    expect(
      fallbackChain("a", [
        { id: "a", fallback: "b" },
        { id: "b", fallback: "a" },
      ]),
    ).toEqual(["a", "b"]);
    expect(fallbackChain("a", [{ id: "a", fallback: "a" }])).toEqual(["a"]);
    expect(fallbackChain("a", [{ id: "a", fallback: "gone" }])).toEqual(["a"]);
    expect(fallbackChain("gone", profiles)).toEqual([]);
  });
});

describe("FallbackClient", () => {
  test("answers with the first model when it works, and never creates the fallback", async () => {
    const make = vi.fn(async () => scripted("from personal"));
    const onSwitch = vi.fn();
    const client = new FallbackClient(
      [
        { name: "work", client: async () => scripted("from work") },
        { name: "personal", client: make },
      ],
      onSwitch,
    );
    expect((await client.complete(request(), () => {})).content).toBe("from work");
    expect(make).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(client.current).toBe("work");
  });

  test("moves on when the quota ends, sends the same request again, and stays on the new model", async () => {
    const work = scripted(quota());
    const personal = scripted("one", "two");
    const switches: [number, number, unknown][] = [];
    const client = new FallbackClient(
      [
        { name: "work", client: async () => work },
        { name: "personal", client: async () => personal },
      ],
      (from, to, error) => switches.push([from, to, error]),
    );
    const text: string[] = [];
    expect((await client.complete(request(), (delta) => text.push(delta))).content).toBe("one");
    expect((await client.complete(request(), () => {})).content).toBe("two");
    expect(work.calls).toBe(1);
    expect(personal.calls).toBe(2);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.slice(0, 2)).toEqual([0, 1]);
    expect(failureKind(switches[0]?.[2])).toBe("quota");
    expect(text).toEqual(["one"]);
    expect(client.current).toBe("personal");
  });

  test("goes down the whole chain and fails with the error of the last model", async () => {
    const last = new ProviderError("gpt is overloaded", "overloaded", 529);
    const onSwitch = vi.fn();
    const client = new FallbackClient(
      [
        { name: "work", client: async () => scripted(quota()) },
        { name: "personal", client: async () => scripted(rate()) },
        { name: "gpt", client: async () => scripted(last) },
      ],
      onSwitch,
    );
    await expect(client.complete(request(), () => {})).rejects.toBe(last);
    expect(onSwitch.mock.calls.map(([from, to]) => [from, to])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  test("a wrong key or a bad request does not fall back", async () => {
    for (const error of [new ProviderError("Claude returned HTTP 401", "auth", 401), new Error("bad schema")]) {
      const make = vi.fn(async () => scripted("never"));
      const client = new FallbackClient(
        [
          { name: "work", client: async () => scripted(error) },
          { name: "personal", client: make },
        ],
        () => {},
      );
      await expect(client.complete(request(), () => {})).rejects.toBe(error);
      expect(make).not.toHaveBeenCalled();
    }
  });

  test("a stopped task does not fall back", async () => {
    const controller = new AbortController();
    const make = vi.fn(async () => scripted("never"));
    const client = new FallbackClient(
      [
        {
          name: "work",
          client: async () => ({
            complete: async () => {
              controller.abort();
              throw quota();
            },
          }),
        },
        { name: "personal", client: make },
      ],
      () => {},
    );
    await expect(client.complete(request(controller.signal), () => {})).rejects.toThrow(/quota/);
    expect(make).not.toHaveBeenCalled();
  });

  test("a single model just reports its error", async () => {
    const client = new FallbackClient([{ name: "work", client: async () => scripted(quota()) }], () => {});
    await expect(client.complete(request(), () => {})).rejects.toThrow(/no quota/);
  });

  test("needs at least one model", () => {
    expect(() => new FallbackClient([], () => {})).toThrow();
  });

  test("works with the real clients: Anthropic without credit, then OpenAI", async () => {
    const profile = (overrides: Partial<ModelProfile>): ModelProfile => ({
      id: "p",
      name: "Test",
      provider: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "m",
      auth: "bearer",
      headers: {},
      query: {},
      extraBody: {},
      ...overrides,
    });
    const urls: string[] = [];
    const claudeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Your credit balance is too low to access the API." },
        }),
        { status: 400 },
      );
    }) as unknown as typeof fetch;
    const openAiFetch = (async (url: string) => {
      urls.push(url);
      const body = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Done by GPT." } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const claude = new AnthropicClient(
      profile({ provider: "anthropic", name: "Claude (work)", baseUrl: "https://api.anthropic.com/v1" }),
      "key-1",
      claudeFetch,
    );
    const gpt = new OpenAiCompatibleClient(profile({ name: "GPT" }), "key-2", openAiFetch);
    const reasons: string[] = [];
    const client = new FallbackClient(
      [
        { name: "Claude (work)", client: async () => claude },
        { name: "GPT", client: async () => gpt },
      ],
      (_from, _to, error) => reasons.push(fallbackReason(error)),
    );
    const result = await client.complete(request(), () => {});
    expect(result.content).toBe("Done by GPT.");
    expect(reasons).toEqual(["has no quota or credit left"]);
    expect(urls).toEqual(["https://api.anthropic.com/v1/messages", "https://api.example.com/v1/chat/completions"]);
  });

  test("works with the real clients: a lasting 429 moves to the second key", async () => {
    const base: ModelProfile = {
      id: "p",
      name: "Claude (work)",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude",
      auth: "x-api-key",
      headers: {},
      query: {},
      extraBody: {},
    };
    const keys: string[] = [];
    const fetchFunction = (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-api-key"] ?? "";
      keys.push(key);
      if (key === "work")
        return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', {
          status: 429,
          headers: { "retry-after": "0" },
        });
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Personal key." } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new FallbackClient(
      [
        { name: "Claude (work)", client: async () => new AnthropicClient(base, "work", fetchFunction, 1) },
        {
          name: "Claude (personal)",
          client: async () => new AnthropicClient({ ...base, name: "Claude (personal)" }, "personal", fetchFunction),
        },
      ],
      () => {},
    );
    expect((await client.complete(request(), () => {})).content).toBe("Personal key.");
    expect(keys).toEqual(["work", "work", "personal"]);
  });
});

describe("the model of a chat", () => {
  const available = ["work", "personal", "gpt"];

  test("the mode, then the chat, then the default, then the first model", () => {
    expect(chooseModelId({ available, modeModel: "gpt", chatModel: "personal", defaultModel: "work" })).toBe("gpt");
    expect(chooseModelId({ available, chatModel: "personal", defaultModel: "work" })).toBe("personal");
    expect(chooseModelId({ available, defaultModel: "work" })).toBe("work");
    expect(chooseModelId({ available })).toBe("work");
    expect(chooseModelId({ available: [] })).toBeUndefined();
  });

  test("a removed model is skipped", () => {
    expect(chooseModelId({ available, modeModel: "gone", chatModel: "gone", defaultModel: "gpt" })).toBe("gpt");
    expect(chooseModelId({ available, chatModel: "gone", defaultModel: "gone" })).toBe("work");
  });

  test("a chat in another window keeps its model when the default changes", () => {
    const windowA = pinnedModelId({ available, defaultModel: "work" });
    // Window B chooses another model, which changes the default for everyone.
    const defaultModel = "personal";
    expect(chooseModelId({ available, chatModel: windowA, defaultModel })).toBe("work");
    expect(chooseModelId({ available, defaultModel })).toBe("personal");
  });

  test("a chat pins its own model, or the default at its first task", () => {
    expect(pinnedModelId({ available, chatModel: "gpt", defaultModel: "work" })).toBe("gpt");
    expect(pinnedModelId({ available, defaultModel: "personal" })).toBe("personal");
    expect(pinnedModelId({ available, chatModel: "gone", defaultModel: "gone" })).toBe("work");
    expect(pinnedModelId({ available: [] })).toBeUndefined();
  });
});

describe("the models for a new agent", () => {
  const profiles = [
    { id: "work", name: "Claude (work)" },
    { id: "personal", name: "Claude (personal)" },
    { id: "gpt", name: "GPT" },
  ];

  test("the default comes first and is marked, the others keep their order", () => {
    expect(modelPicks(profiles, "gpt").map((item) => [item.profile.id, item.isDefault])).toEqual([
      ["gpt", true],
      ["work", false],
      ["personal", false],
    ]);
  });

  test("without a valid default, the first model is the default", () => {
    expect(modelPicks(profiles, "gone")[0]).toEqual({ profile: profiles[0], isDefault: true });
    expect(modelPicks(profiles, undefined)).toHaveLength(3);
  });

  test("no models, no picks", () => {
    expect(modelPicks([], "work")).toEqual([]);
  });
});

describe("the cost of a task with a fallback", () => {
  const limits = { maxCostPerTask: 0, maxTokensPerTask: 0 };

  test("each model counts with its own price", () => {
    const meter = new CostMeter({ input: 3, output: 15 }, limits);
    meter.add({ inputTokens: 1_000_000, outputTokens: 0 });
    meter.usePrice({ input: 1, output: 2 });
    meter.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(meter.cost).toBeCloseTo(3 + 1 + 2);
    expect(meter.tokens).toBe(3_000_000);
  });

  test("a model without a price makes the total unknown once it used tokens", () => {
    const meter = new CostMeter({ input: 3, output: 15 }, limits);
    meter.add({ inputTokens: 1_000_000, outputTokens: 0 });
    meter.usePrice(undefined);
    expect(meter.cost).toBeCloseTo(3);
    meter.add({ inputTokens: 10, outputTokens: 10 });
    expect(meter.cost).toBeUndefined();
    meter.usePrice({ input: 1, output: 1 });
    expect(meter.cost).toBeUndefined();
  });

  test("a switch before any tokens keeps the cost exact", () => {
    const meter = new CostMeter(undefined, limits);
    meter.usePrice({ input: 2, output: 2 });
    meter.add({ inputTokens: 500_000, outputTokens: 500_000 });
    expect(meter.cost).toBeCloseTo(2);
  });

  test("the budget sees the cost of both models", () => {
    const meter = new CostMeter({ input: 10, output: 10 }, { maxCostPerTask: 15, maxTokensPerTask: 0 });
    meter.add({ inputTokens: 1_000_000, outputTokens: 0 });
    meter.usePrice({ input: 10, output: 10 });
    expect(meter.exceeded()).toBeUndefined();
    meter.add({ inputTokens: 500_000, outputTokens: 0 });
    expect(meter.exceeded()).toMatch(/reaches the limit/);
  });
});

/** Parses a profile and fails the test with its error. */
function parseProfile(value: unknown): ModelProfile {
  const profile = parseOne(value);
  if (typeof profile === "string") throw new Error(profile);
  return profile;
}

describe("the fallback of a profile", () => {
  const raw = {
    id: "work",
    name: "Claude (work)",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
  };

  test("is read and written back", () => {
    const profile = parseProfile({ ...raw, fallback: " personal " });
    expect(profile.fallback).toBe("personal");
    expect(serializeProfile(profile).fallback).toBe("personal");
    expect(serializeProfile(parseProfile(raw))).not.toHaveProperty("fallback");
  });

  test("ignores itself and ids that cannot be ids", () => {
    expect(parseProfile({ ...raw, fallback: "work" }).fallback).toBeUndefined();
    expect(parseProfile({ ...raw, fallback: "../../x" }).fallback).toBeUndefined();
    expect(parseProfile({ ...raw, fallback: 3 }).fallback).toBeUndefined();
    expect(parseProfile({ ...raw, fallback: "" }).fallback).toBeUndefined();
  });

  test("two keys of one provider are two models with their own ids", () => {
    const { profiles, errors } = parseProfiles([
      { ...raw, fallback: "personal" },
      { ...raw, id: "personal", name: "Claude (personal)", fallback: "work" },
    ]);
    expect(errors).toEqual([]);
    expect(profiles.map((profile) => [profile.id, profile.fallback])).toEqual([
      ["work", "personal"],
      ["personal", "work"],
    ]);
    expect(fallbackChain("work", profiles)).toEqual(["work", "personal"]);
  });
});
