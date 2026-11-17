import { describe, expect, test } from "vitest";
import type { ChatMessage, CompletionRequest } from "../src/core/chat";
import { AnthropicClient, toAnthropic } from "../src/providers/anthropic";
import { createHttpClient, listModels, parseModelList, testConnection } from "../src/providers/factory";
import { GeminiClient, toGemini, toGeminiSchema } from "../src/providers/gemini";
import { errorMessage, httpError, networkError } from "../src/providers/http";
import { OpenAiCompatibleClient, toApiMessages } from "../src/providers/openaiCompatible";
import { apiKeySecretName, providerPresets, validateBaseUrl } from "../src/providers/presets";
import {
  endpoint,
  type ModelProfile,
  parseProfile,
  parseProfiles,
  requestHeaders,
  serializeProfile,
  uniqueId,
} from "../src/providers/profile";

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

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function fakeFetch(
  responses: { status?: number; body: string; type?: string }[],
  captured: Captured[] = [],
): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    captured.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("No response.");
    const bytes = new TextEncoder().encode(next.body);
    const stream = new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 5) controller.enqueue(bytes.slice(index, index + 5));
        controller.close();
      },
    });
    return new Response(stream, {
      status: next.status ?? 200,
      headers: { "content-type": next.type ?? "text/event-stream" },
    });
  }) as typeof fetch;
}

const sse = (events: unknown[], done = true) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");

const conversation: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "fix" },
  {
    role: "assistant",
    content: "Reading.",
    toolCalls: [
      { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}', signature: "sig-1" },
      { id: "c2", name: "get_problems", arguments: "" },
    ],
  },
  { role: "tool", toolCallId: "c1", content: "file" },
  { role: "tool", toolCallId: "c2", content: "none" },
  { role: "user", content: "go on" },
];

const request = (messages: ChatMessage[] = conversation): CompletionRequest => ({
  messages,
  tools: [
    {
      name: "read_file",
      description: "Read",
      parameters: {
        type: "object",
        properties: { path: { type: ["string", "null"] } },
        required: ["path", "missing"],
        additionalProperties: false,
      },
    },
  ],
  signal: new AbortController().signal,
});

describe("profiles", () => {
  test("parse with defaults, validation, and duplicates", () => {
    const parsed = parseProfiles([
      {
        id: "claude",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1/",
        model: "claude-x",
        price: { input: 3, output: 15 },
      },
      { id: "claude", provider: "anthropic", baseUrl: "x", model: "y" },
      { id: "bad id!", provider: "openai", model: "x" },
      { id: "nourl", provider: "openai", model: "x" },
      { id: "copilot", provider: "vscode", model: "gpt-4o" },
    ]);
    expect(parsed.profiles.map((item) => item.id)).toEqual(["claude", "copilot"]);
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.profiles[0]).toMatchObject({
      auth: "x-api-key",
      baseUrl: "https://api.anthropic.com/v1",
      name: "claude-x",
    });
    expect(parsed.profiles[1].auth).toBe("none");
  });

  test("serialize omits defaults and round-trips", () => {
    const original = parseProfile({
      id: "az",
      name: "Azure",
      provider: "openai",
      baseUrl: "https://r.openai.azure.com/openai/v1",
      model: "dep",
      auth: "api-key",
      query: { "api-version": "preview" },
      extraBody: { reasoning_effort: "high" },
      maxTokens: 4000,
    }) as ModelProfile;
    const json = serializeProfile(original);
    expect(json).not.toHaveProperty("headers");
    expect(parseProfile(json)).toEqual(original);
    expect(serializeProfile({ ...original, auth: "bearer" })).not.toHaveProperty("auth");
  });

  test("headers follow the auth style and custom headers win", () => {
    expect(requestHeaders(profile({ auth: "bearer" }), "k").Authorization).toBe("Bearer k");
    expect(requestHeaders(profile({ auth: "api-key" }), "k")["api-key"]).toBe("k");
    expect(requestHeaders(profile({ auth: "x-goog-api-key" }), "k")["x-goog-api-key"]).toBe("k");
    expect(requestHeaders(profile({ auth: "none" }), "k")).not.toHaveProperty("Authorization");
    expect(requestHeaders(profile({ headers: { "X-Title": "Phew" } }), undefined)["X-Title"]).toBe("Phew");
  });

  test("endpoints keep the base path and add query parameters", () => {
    expect(endpoint("https://h/openai/v1/", "/chat/completions", { "api-version": "2024-10-21" })).toBe(
      "https://h/openai/v1/chat/completions?api-version=2024-10-21",
    );
  });

  test("identifiers are unique and safe", () => {
    expect(uniqueId("Claude Sonnet (work)", [])).toBe("claude-sonnet-work");
    expect(uniqueId("GPT", ["gpt", "gpt-2"])).toBe("gpt-3");
    expect(apiKeySecretName("gpt")).toBe("phew.apiKey.gpt");
  });

  test("every preset makes a valid profile with a safe URL", () => {
    for (const preset of providerPresets) {
      const parsed = parseProfile({
        id: preset.id,
        provider: preset.provider,
        baseUrl: preset.baseUrl,
        model: preset.modelHint || "x",
        auth: preset.auth,
      });
      expect(typeof parsed, preset.id).toBe("object");
      if (preset.provider !== "vscode" && !preset.askBaseUrl)
        expect(validateBaseUrl(preset.baseUrl), preset.id).toBeUndefined();
    }
    expect(new Set(providerPresets.map((preset) => preset.id)).size).toBe(providerPresets.length);
  });

  test("base URL validation", () => {
    expect(validateBaseUrl("http://192.168.1.10:11434/v1")).toBeUndefined();
    expect(validateBaseUrl("http://host.docker.internal:1234/v1")).toBeUndefined();
    expect(validateBaseUrl("http://example.com/v1")).toMatch(/HTTPS/);
    expect(validateBaseUrl("https://YOUR-RESOURCE.openai.azure.com")).toMatch(/YOUR-RESOURCE/);
    expect(validateBaseUrl("https://user:pw@example.com")).toMatch(/credentials/);
  });
});

describe("OpenAI-compatible", () => {
  test("streams text, tool calls, and usage, and sends extra fields", async () => {
    const captured: Captured[] = [];
    const body = sse([
      { choices: [{ delta: { content: "Hi" } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "t", function: { name: "read_file", arguments: '{"path":' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" },
        ],
      },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);
    const client = new OpenAiCompatibleClient(
      profile({ extraBody: { reasoning_effort: "low" }, maxTokens: 100, query: { "api-version": "1" } }),
      "key",
      fakeFetch([{ body }], captured),
    );
    const text: string[] = [];
    const result = await client.complete(request(), (delta) => text.push(delta));
    expect(text.join("")).toBe("Hi");
    expect(result.toolCalls).toEqual([{ id: "t", name: "read_file", arguments: '{"path":"a"}' }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(captured[0].url).toBe("https://api.example.com/v1/chat/completions?api-version=1");
    expect(captured[0].headers.Authorization).toBe("Bearer key");
    expect(captured[0].body).toMatchObject({
      reasoning_effort: "low",
      max_tokens: 100,
      stream_options: { include_usage: true },
    });
  });

  test("uses max_completion_tokens for the official OpenAI API", () => {
    const client = new OpenAiCompatibleClient(profile({ baseUrl: "https://api.openai.com/v1", maxTokens: 5 }), "k");
    expect(client.body(request(), false)).toMatchObject({ max_completion_tokens: 5 });
  });

  test("retries without stream_options and accepts a JSON response", async () => {
    const captured: Captured[] = [];
    const client = new OpenAiCompatibleClient(
      profile({}),
      undefined,
      fakeFetch(
        [
          {
            status: 400,
            body: '{"error":{"message":"Unrecognized request argument: stream_options"}}',
            type: "application/json",
          },
          { body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }), type: "application/json" },
        ],
        captured,
      ),
    );
    const result = await client.complete(request([{ role: "user", content: "x" }]), () => {});
    expect(result.content).toBe("ok");
    expect(captured[1].body).not.toHaveProperty("stream_options");
  });

  test("converts messages", () => {
    expect(toApiMessages(conversation)[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1" }, { id: "c2", function: { arguments: "{}" } }],
    });
  });
});

describe("Anthropic", () => {
  test("merges tool results and keeps roles alternating", () => {
    const { system, messages } = toAnthropic(conversation);
    expect(system).toBe("sys");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1].content).toEqual([
      { type: "text", text: "Reading." },
      { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } },
      { type: "tool_use", id: "c2", name: "get_problems", input: {} },
    ]);
    expect(messages[2].content.map((block) => block.type)).toEqual(["tool_result", "tool_result", "text"]);
  });

  test("streams text, tool input, and usage", async () => {
    const captured: Captured[] = [];
    const body = sse(
      [
        {
          type: "message_start",
          message: { usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 1 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path"' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"a.ts"}' } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
        { type: "message_stop" },
      ],
      false,
    );
    const client = new AnthropicClient(
      profile({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", auth: "x-api-key" }),
      "key",
      fakeFetch([{ body }], captured),
    );
    const result = await client.complete(request(), () => {});
    expect(result).toMatchObject({
      content: "Let me look.",
      toolCalls: [{ id: "toolu_1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      usage: { inputTokens: 25, outputTokens: 30 },
      finishReason: "tool_use",
    });
    expect(captured[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured[0].headers).toMatchObject({ "x-api-key": "key", "anthropic-version": "2023-06-01" });
    expect(captured[0].body).toMatchObject({ max_tokens: 8192, system: "sys", stream: true });
    const tools = (captured[0].body as { tools: { input_schema: unknown }[] }).tools;
    expect(tools[0].input_schema).toBeDefined();
  });

  test("reports stream errors", async () => {
    const client = new AnthropicClient(
      profile({ provider: "anthropic" }),
      "k",
      fakeFetch([
        { body: sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }], false) },
      ]),
    );
    await expect(client.complete(request(), () => {})).rejects.toThrow("Overloaded");
  });
});

describe("Gemini", () => {
  test("cleans JSON Schema for function declarations", () => {
    expect(
      toGeminiSchema({
        type: "object",
        $schema: "x",
        additionalProperties: false,
        properties: { a: { type: ["string", "null"], examples: ["x"] }, b: { type: "array", items: { const: 1 } } },
        required: ["a", "gone"],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string", nullable: true }, b: { type: "array", items: { type: "string" } } },
      required: ["a"],
    });
  });

  test("converts the conversation and sends thought signatures back", () => {
    const { system, contents } = toGemini(conversation);
    expect(system).toBe("sys");
    expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
    expect(contents[1].parts[1]).toEqual({
      functionCall: { name: "read_file", args: { path: "a.ts" }, id: "c1" },
      thoughtSignature: "sig-1",
    });
    expect(contents[2].parts[0]).toEqual({
      functionResponse: { name: "read_file", response: { result: "file" }, id: "c1" },
    });
  });

  test("streams parts with function calls, signatures, and usage", async () => {
    const captured: Captured[] = [];
    const body = sse(
      [
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "Thinking", thought: true }, { text: "Checking." }] } },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } }, thoughtSignature: "abc" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
        },
      ],
      false,
    );
    const client = new GeminiClient(
      profile({
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        auth: "x-goog-api-key",
        model: "models/gemini-x",
        temperature: 0.2,
      }),
      "key",
      fakeFetch([{ body }], captured),
    );
    const result = await client.complete(request(), () => {});
    expect(result.content).toBe("Checking.");
    expect(result.toolCalls[0]).toMatchObject({ name: "read_file", arguments: '{"path":"a.ts"}', signature: "abc" });
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
    expect(captured[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse",
    );
    expect(captured[0].headers["x-goog-api-key"]).toBe("key");
    expect(captured[0].body).toMatchObject({
      systemInstruction: { parts: [{ text: "sys" }] },
      generationConfig: { temperature: 0.2 },
    });
  });

  test("reports blocked prompts", async () => {
    const client = new GeminiClient(
      profile({ provider: "gemini" }),
      "k",
      fakeFetch([{ body: sse([{ promptFeedback: { blockReason: "SAFETY" } }], false) }]),
    );
    await expect(client.complete(request(), () => {})).rejects.toThrow("SAFETY");
  });
});

describe("model lists, tests, and errors", () => {
  test("parses the model list formats", () => {
    expect(
      parseModelList("openai", { data: [{ id: "b" }, { id: "a" }, { id: "a" }] }).map((model) => model.id),
    ).toEqual(["a", "b"]);
    expect(parseModelList("anthropic", { data: [{ id: "claude-x", display_name: "Claude X" }] })).toEqual([
      { id: "claude-x", label: "Claude X" },
    ]);
    expect(
      parseModelList("gemini", {
        models: [
          { name: "models/gemini-x", displayName: "Gemini X", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    ).toEqual([{ id: "gemini-x", label: "Gemini X" }]);
    expect(parseModelList("openai", { models: [{ name: "llama3" }] })).toEqual([{ id: "llama3", label: undefined }]);
  });

  test("loads models with the provider headers", async () => {
    const captured: Captured[] = [];
    await listModels(
      profile({ provider: "anthropic", auth: "x-api-key" }),
      "k",
      fakeFetch([{ body: '{"data":[]}', type: "application/json" }], captured),
    );
    expect(captured[0].url).toBe("https://api.example.com/v1/models?limit=1000");
    expect(captured[0].headers["anthropic-version"]).toBe("2023-06-01");
    await expect(
      listModels(profile({}), "bad", fakeFetch([{ status: 401, body: '{"error":{"message":"Invalid key"}}' }])),
    ).rejects.toThrow(/HTTP 401: Invalid key.*API key/);
  });

  test("the connection test detects tool calling", async () => {
    const ok = createHttpClient(
      profile({}),
      "k",
      fakeFetch([
        {
          body: sse([
            {
              choices: [
                { delta: { tool_calls: [{ index: 0, id: "1", function: { name: "ping", arguments: "{}" } }] } },
              ],
            },
          ]),
        },
      ]),
    );
    expect(await testConnection(ok, new AbortController().signal)).toMatchObject({ ok: true, toolCalling: true });
    const text = createHttpClient(
      profile({}),
      "k",
      fakeFetch([{ body: sse([{ choices: [{ delta: { content: "OK" } }] }]) }]),
    );
    expect(await testConnection(text, new AbortController().signal)).toMatchObject({ ok: true, toolCalling: false });
    const failed = createHttpClient(profile({}), "k", fakeFetch([{ status: 404, body: "model not found" }]));
    expect(await testConnection(failed, new AbortController().signal)).toMatchObject({ ok: false });
  });

  test("errors are clear and redact secrets", () => {
    expect(errorMessage('[{"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}]')).toBe(
      "API key not valid",
    );
    expect(httpError("X", 429, '{"message":"slow down"}').message).toMatch(/slow down.*rate limit/);
    expect(httpError("X", 401, `{"error":"bad sk-${"a".repeat(30)}"}`).message).toContain("REDACTED");
    const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    expect(networkError("Ollama", "http://localhost:11434/v1", refused).message).toMatch(/ECONNREFUSED.*local server/);
  });
});
