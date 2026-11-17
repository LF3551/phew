import { expect, test } from "vitest";
import { OpenAiCompatibleClient, toApiMessages } from "../src/providers/openaiCompatible";
import { apiKeySecretName, validateBaseUrl } from "../src/providers/presets";

function sse(events: unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function fakeFetch(responses: { status: number; body: string }[], requests: unknown[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    if (!next) throw new Error("No response.");
    const bytes = new TextEncoder().encode(next.body);
    const stream = new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
        controller.close();
      },
    });
    return new Response(stream, { status: next.status });
  }) as typeof fetch;
}

test("streams text, tool calls, and usage", async () => {
  const body = sse([
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
  ]);
  const requests: Record<string, unknown>[] = [];
  const client = new OpenAiCompatibleClient({
    baseUrl: "https://api.example.com/v1/",
    model: "m",
    apiKey: "k",
    fetch: fakeFetch([{ status: 200, body }], requests),
  });
  const deltas: string[] = [];
  const result = await client.complete(
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", description: "d", parameters: {} }],
      signal: new AbortController().signal,
    },
    (delta) => deltas.push(delta),
  );
  expect(deltas.join("")).toBe("Hello");
  expect(result.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }]);
  expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  expect(requests[0]).toMatchObject({ model: "m", stream: true, stream_options: { include_usage: true } });
});

test("retries without stream_options when the server rejects it", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = new OpenAiCompatibleClient({
    baseUrl: "http://localhost:11434/v1",
    model: "m",
    fetch: fakeFetch(
      [
        { status: 400, body: '{"error":{"message":"unknown field stream_options"}}' },
        { status: 200, body: sse([{ choices: [{ delta: { content: "ok" } }] }]) },
      ],
      requests,
    ),
  });
  const result = await client.complete({ messages: [], tools: [], signal: new AbortController().signal }, () => {});
  expect(result.content).toBe("ok");
  expect(requests[1]).not.toHaveProperty("stream_options");
});

test("reports HTTP errors with a hint and without secrets", async () => {
  const client = new OpenAiCompatibleClient({
    baseUrl: "https://api.example.com/v1",
    model: "m",
    fetch: fakeFetch([{ status: 401, body: `{"error":{"message":"bad key sk-${"x".repeat(30)}"}}` }]),
  });
  await expect(
    client.complete({ messages: [], tools: [], signal: new AbortController().signal }, () => {}),
  ).rejects.toThrow(/HTTP 401.*REDACTED.*Configure Model/s);
});

test("converts messages to the API format", () => {
  expect(
    toApiMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", arguments: "" }] },
      { role: "tool", toolCallId: "1", content: "r" },
    ]),
  ).toEqual([
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "1", content: "r" },
  ]);
});

test("validates base URLs and builds secret names", () => {
  expect(validateBaseUrl("https://api.openai.com/v1")).toBeUndefined();
  expect(validateBaseUrl("http://localhost:11434/v1")).toBeUndefined();
  expect(validateBaseUrl("http://example.com/v1")).toMatch(/HTTPS/);
  expect(validateBaseUrl("https://user:pass@example.com")).toMatch(/credentials/);
  expect(validateBaseUrl("not a url")).toBeDefined();
  expect(apiKeySecretName("https://API.example.com/v1/")).toBe("phew.apiKey:https://api.example.com/v1");
});
