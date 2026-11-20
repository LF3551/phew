import { describe, expect, test } from "vitest";
import type { CompletionRequest } from "../src/core/chat";
import { CostMeter, usageCost } from "../src/core/cost";
import { AnthropicClient, toAnthropic, withCacheMark } from "../src/providers/anthropic";
import { GeminiClient } from "../src/providers/gemini";
import { OpenAiCompatibleClient } from "../src/providers/openaiCompatible";
import type { ModelProfile } from "../src/providers/profile";

const profile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: "p",
  name: "Claude",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude",
  auth: "x-api-key",
  headers: {},
  query: {},
  extraBody: {},
  ...overrides,
});

const request: CompletionRequest = {
  messages: [
    { role: "system", content: "You are Phew." },
    { role: "user", content: "Fix the test." },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
    { role: "tool", toolCallId: "t1", content: "export const a = 1;" },
  ],
  tools: [
    { name: "read_file", description: "Read", parameters: { type: "object", properties: {} } },
    { name: "edit_file", description: "Edit", parameters: { type: "object", properties: {} } },
  ],
  signal: new AbortController().signal,
};

const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const anthropicAnswer = (usage: Record<string, number>) =>
  sse([
    { type: "message_start", message: { usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1000 } },
  ]);

describe("prompt caching with Anthropic", () => {
  test("marks the tools, the system prompt, and the end of the conversation", () => {
    const body = new AnthropicClient(profile(), "k").body(request) as {
      system: unknown;
      tools: Record<string, unknown>[];
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    expect(body.system).toEqual([{ type: "text", text: "You are Phew.", cache_control: { type: "ephemeral" } }]);
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1]).toMatchObject({ name: "edit_file", cache_control: { type: "ephemeral" } });
    const last = body.messages.at(-1);
    expect(last?.content.at(-1)).toMatchObject({ type: "tool_result", cache_control: { type: "ephemeral" } });
    // Only the very end: four marks at most, and earlier turns stay as they were.
    const marks = JSON.stringify(body).match(/cache_control/g) ?? [];
    expect(marks).toHaveLength(3);
  });

  test("the mark does not change the messages it was given", () => {
    const { messages } = toAnthropic(request.messages);
    const before = JSON.stringify(messages);
    withCacheMark(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("a thinking block at the end gets no mark", () => {
    const marked = withCacheMark([
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }] },
    ]);
    expect(JSON.stringify(marked)).not.toMatch(/cache_control/);
    expect(withCacheMark([])).toEqual([]);
  });

  test("reads the cached tokens from the answer", async () => {
    const client = new AnthropicClient(
      profile(),
      "k",
      (async () =>
        new Response(
          anthropicAnswer({ input_tokens: 5000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 90_000 }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    const result = await client.complete(request, () => {});
    expect(result.usage).toEqual({
      inputTokens: 100_000,
      outputTokens: 1000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 5000,
      cacheReadFactor: 0.1,
      cacheWriteFactor: 1.25,
    });
  });

  test("a gateway that rejects cache_control gets the request again without it, and never again", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const fetchFunction = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      calls++;
      if (calls === 1)
        return new Response(
          JSON.stringify({
            type: "error",
            error: { message: "system.0.cache_control: Extra inputs are not permitted" },
          }),
          { status: 400 },
        );
      return new Response(anthropicAnswer({ input_tokens: 10 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new AnthropicClient(profile(), "k", fetchFunction);
    expect((await client.complete(request, () => {})).content).toBe("Done.");
    await client.complete(request, () => {});
    expect(bodies[0]).toMatch(/cache_control/);
    expect(bodies[1]).not.toMatch(/cache_control/);
    expect(bodies[2]).not.toMatch(/cache_control/);
  });

  test("another error is not hidden", async () => {
    const client = new AnthropicClient(
      profile(),
      "k",
      (async () =>
        new Response(JSON.stringify({ error: { message: "model not found" } }), {
          status: 404,
        })) as unknown as typeof fetch,
    );
    await expect(client.complete(request, () => {})).rejects.toThrow(/model not found/);
  });
});

describe("cached tokens of other providers", () => {
  test("OpenAI-compatible: prompt_tokens_details.cached_tokens", async () => {
    const body = sse([
      { choices: [{ delta: { content: "ok" } }] },
      {
        choices: [],
        usage: { prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1536 } },
      },
    ]);
    const client = new OpenAiCompatibleClient(
      profile({ provider: "openai", auth: "bearer", baseUrl: "https://api.example.com/v1" }),
      "k",
      (async () => new Response(`${body}data: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    );
    expect((await client.complete(request, () => {})).usage).toMatchObject({
      inputTokens: 2000,
      cacheReadTokens: 1536,
      cacheReadFactor: 0.5,
    });
  });

  test("Gemini: cachedContentTokenCount", async () => {
    const body = sse([
      {
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 4, cachedContentTokenCount: 2048 },
      },
    ]);
    const client = new GeminiClient(
      profile({
        provider: "gemini",
        auth: "x-goog-api-key",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
      "k",
      (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    );
    expect((await client.complete(request, () => {})).usage).toMatchObject({
      inputTokens: 3000,
      cacheReadTokens: 2048,
      cacheReadFactor: 0.25,
    });
  });
});

describe("the cost with a prompt cache", () => {
  const sonnet = { input: 3, output: 15 };

  test("a cached step of a long task costs a quarter of an uncached one", () => {
    const cached = usageCost(
      {
        inputTokens: 100_000,
        outputTokens: 1000,
        cacheReadTokens: 90_000,
        cacheWriteTokens: 5000,
        cacheReadFactor: 0.1,
        cacheWriteFactor: 1.25,
      },
      sonnet,
    );
    const plain = usageCost({ inputTokens: 100_000, outputTokens: 1000 }, sonnet);
    expect(cached).toBeCloseTo(0.015 + 0.027 + 0.01875 + 0.015, 6);
    expect(plain).toBeCloseTo(0.315, 6);
    expect(cached / plain).toBeLessThan(0.25);
  });

  test("an own price for cached input wins over the share of the provider", () => {
    const cost = usageCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheReadFactor: 0.5 },
      { input: 2, output: 8, cachedInput: 0.2 },
    );
    expect(cost).toBeCloseTo(0.2, 6);
  });

  test("odd numbers from a provider never make a negative cost", () => {
    expect(
      usageCost({ inputTokens: 100, outputTokens: -5, cacheReadTokens: 500, cacheWriteTokens: 500 }, sonnet),
    ).toBeGreaterThanOrEqual(0);
  });

  test("the meter counts the cached tokens of the task and of its subagents", () => {
    const task = new CostMeter(sonnet, { maxCostPerTask: 0, maxTokensPerTask: 0 });
    task.add({ inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 8000, cacheReadFactor: 0.1 });
    const subagent = new CostMeter(sonnet, { maxCostPerTask: 0, maxTokensPerTask: 0 });
    subagent.add({ inputTokens: 5000, outputTokens: 50, cacheReadTokens: 4000, cacheReadFactor: 0.1 });
    task.absorb(subagent);
    expect(task.cachedTokens).toBe(12_000);
    expect(task.inputTokens).toBe(15_000);
  });
});
