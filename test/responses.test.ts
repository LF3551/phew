import { expect, test } from "vitest";
import type { ChatMessage } from "../src/core/chat";
import { apiFor, createHttpClient, parseModelList } from "../src/providers/factory";
import { providerPresets, validateBaseUrl } from "../src/providers/presets";
import { parseProfile, serializeProfile } from "../src/providers/profile";
import {
  applyResponsesEvent,
  finishResponses,
  newResponsesState,
  ResponsesClient,
  toResponsesInput,
} from "../src/providers/responses";

const conversation: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "fix", images: [{ mimeType: "image/png", data: "AAAA" }] },
  {
    role: "assistant",
    content: "Reading.",
    toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a"}' }],
  },
  { role: "tool", toolCallId: "call_1", content: "file" },
];

test("converts the conversation to Responses input items", () => {
  const { instructions, input } = toResponsesInput(conversation);
  expect(instructions).toBe("sys");
  expect(input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: "fix" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    },
    { role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "call_1", output: "file" },
  ]);
});

test("streams text, reasoning, function calls, and usage", () => {
  const state = newResponsesState();
  const text: string[] = [];
  const thoughts: string[] = [];
  for (const event of [
    { type: "response.reasoning_summary_text.delta", delta: "Thinking." },
    { type: "response.output_text.delta", delta: "Let me read." },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read_file", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a.ts"}' },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 40, output_tokens: 9 } } },
  ]) {
    applyResponsesEvent(
      state,
      event,
      (delta) => text.push(delta),
      (delta) => thoughts.push(delta),
    );
  }
  expect(finishResponses(state)).toEqual({
    content: "Let me read.",
    toolCalls: [{ id: "call_9", name: "read_file", arguments: '{"path":"a.ts"}' }],
    usage: { inputTokens: 40, outputTokens: 9, cacheReadTokens: 0, cacheReadFactor: 0.25 },
    finishReason: "completed",
    reasoning: { text: "Thinking." },
  });
  expect(() =>
    applyResponsesEvent(
      newResponsesState(),
      { type: "response.failed", response: { error: { message: "bad" } } },
      () => {},
    ),
  ).toThrow("bad");
});

test("the client posts to /responses with function tools", async () => {
  const captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const body = [
    { type: "response.output_text.delta", delta: "OK" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const fetchFunction = (async (url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const profile = parseProfile({
    id: "copilot",
    provider: "openai",
    baseUrl: "https://api.business.githubcopilot.com",
    model: "gpt-6.1-sol",
    api: "responses",
    headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
  });
  if (typeof profile === "string") throw new Error(profile);
  const client = createHttpClient(profile, "github_pat_x", fetchFunction);
  expect(client).toBeInstanceOf(ResponsesClient);
  const result = await client.complete(
    {
      messages: conversation,
      tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
      signal: new AbortController().signal,
    },
    () => {},
  );
  expect(result.content).toBe("OK");
  expect(captured[0].url).toBe("https://api.business.githubcopilot.com/responses");
  expect(captured[0].headers).toMatchObject({
    Authorization: "Bearer github_pat_x",
    "Copilot-Integration-Id": "copilot-developer-cli",
  });
  expect(captured[0].body).toMatchObject({ model: "gpt-6.1-sol", stream: true, store: false, instructions: "sys" });
  expect((captured[0].body.tools as unknown[])[0]).toEqual({
    type: "function",
    name: "read_file",
    description: "Read",
    parameters: { type: "object" },
  });
  expect(serializeProfile(profile).api).toBe("responses");
});

test("parses the GitHub Copilot model list and picks the API format", () => {
  const models = parseModelList("openai", {
    data: [
      {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        capabilities: { type: "chat", limits: { max_context_window_tokens: 328000 } },
        supported_endpoints: ["/v1/messages", "/chat/completions"],
      },
      { id: "gpt-6.1-sol", capabilities: { type: "chat" }, supported_endpoints: ["/responses", "ws:/responses"] },
      { id: "text-embedding-3-small", capabilities: { type: "embeddings" } },
      { id: "gpt-4o", capabilities: { type: "chat" } },
    ],
  });
  expect(models.map((model) => model.id)).toEqual(["claude-sonnet", "gpt-4o", "gpt-6.1-sol"]);
  expect(models[0]).toMatchObject({ label: "Claude Sonnet", contextWindow: 328000 });
  expect(apiFor(models[0])).toBe("chat");
  expect(apiFor(models[2])).toBe("responses");
  expect(apiFor(models[1])).toBeUndefined();
});

test("the GitHub Copilot preset probes every plan", () => {
  const preset = providerPresets.find((item) => item.id === "copilot-token");
  expect(preset?.probeBaseUrls?.map((url) => new URL(url).host)).toEqual([
    "api.individual.githubcopilot.com",
    "api.business.githubcopilot.com",
    "api.enterprise.githubcopilot.com",
  ]);
  for (const url of preset?.probeBaseUrls ?? []) expect(validateBaseUrl(url)).toBeUndefined();
  expect(preset?.keyEnv).toBe("COPILOT_GITHUB_TOKEN");
});
