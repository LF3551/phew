import { expect, test } from "vitest";
import { runAgent, type ToolResult } from "../src/core/agent";
import type { ChatMessage, CompletionResult, ModelClient } from "../src/core/chat";
import { trimHistory } from "../src/core/chat";
import { CostMeter } from "../src/core/cost";

function scripted(results: CompletionResult[]): ModelClient & { calls: number } {
  const client = {
    calls: 0,
    async complete(_request: unknown, onText: (delta: string) => void) {
      const result = results[client.calls++];
      if (!result) throw new Error("No scripted result.");
      if (result.content) onText(result.content);
      return result;
    },
  };
  return client;
}

const meter = () => new CostMeter(undefined, { maxCostPerTask: 0, maxTokensPerTask: 0 });

test("runs tool calls and stops when the model answers without tools", async () => {
  const client = scripted([
    {
      content: "",
      toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a"}' }],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    { content: "Done.", toolCalls: [] },
  ]);
  const history: ChatMessage[] = [{ role: "user", content: "hi" }];
  const executed: string[] = [];
  const result = await runAgent({
    client,
    systemPrompt: "system",
    history,
    tools: [],
    executeTool: async (call) => {
      executed.push(call.name);
      return { content: "file" };
    },
    maxSteps: 5,
    meter: meter(),
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ status: "done", steps: 2, filesChanged: false });
  expect(executed).toEqual(["read_file"]);
  expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
});

test("keeps fixing until the check passes", async () => {
  const edit = { id: "e", name: "edit_file", arguments: "{}" };
  const client = scripted([
    { content: "", toolCalls: [edit] },
    { content: "Fixed.", toolCalls: [] },
    { content: "", toolCalls: [{ ...edit, id: "e2" }] },
    { content: "Fixed again.", toolCalls: [] },
  ]);
  const checks = [false, true];
  const history: ChatMessage[] = [{ role: "user", content: "fix" }];
  const result = await runAgent({
    client,
    systemPrompt: "s",
    history,
    tools: [],
    executeTool: async (): Promise<ToolResult> => ({ content: "ok", changed: true }),
    verify: async () => ({ passed: checks.shift() ?? false, output: "1 test failed" }),
    maxSteps: 10,
    meter: meter(),
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ status: "done", verified: true, filesChanged: true });
  expect(history.some((message) => message.role === "user" && message.content.includes("1 test failed"))).toBe(true);
});

test("stops after the maximum number of check attempts", async () => {
  const edit = { id: "e", name: "edit_file", arguments: "{}" };
  const client = scripted([
    { content: "", toolCalls: [edit] },
    { content: "a", toolCalls: [] },
    { content: "b", toolCalls: [] },
  ]);
  const result = await runAgent({
    client,
    systemPrompt: "s",
    history: [],
    tools: [],
    executeTool: async () => ({ content: "ok", changed: true }),
    verify: async () => ({ passed: false, output: "fail" }),
    maxVerifyAttempts: 2,
    maxSteps: 10,
    meter: meter(),
    signal: new AbortController().signal,
  });
  expect(result.status).toBe("verify-failed");
});

test("turns tool errors into tool results and respects the step and budget limits", async () => {
  const call = { id: "x", name: "boom", arguments: "{}" };
  const history: ChatMessage[] = [];
  const result = await runAgent({
    client: scripted([
      { content: "", toolCalls: [call] },
      { content: "", toolCalls: [call] },
    ]),
    systemPrompt: "s",
    history,
    tools: [],
    executeTool: async () => {
      throw new Error("bad input");
    },
    maxSteps: 2,
    meter: meter(),
    signal: new AbortController().signal,
  });
  expect(result.status).toBe("max-steps");
  expect(history.find((message) => message.role === "tool")?.content).toBe("Error: bad input");

  const limited = new CostMeter(undefined, { maxCostPerTask: 0, maxTokensPerTask: 10 });
  limited.add({ inputTokens: 20, outputTokens: 0 });
  const budget = await runAgent({
    client: scripted([]),
    systemPrompt: "s",
    history: [],
    tools: [],
    executeTool: async () => ({ content: "" }),
    maxSteps: 2,
    meter: limited,
    signal: new AbortController().signal,
  });
  expect(budget.status).toBe("budget");
});

test("stops at once when the task is cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runAgent({
    client: scripted([]),
    systemPrompt: "s",
    history: [],
    tools: [],
    executeTool: async () => ({ content: "" }),
    maxSteps: 2,
    meter: meter(),
    signal: controller.signal,
  });
  expect(result.status).toBe("aborted");
});

test("trims old history at a user message", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "a".repeat(100) },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", arguments: "{}" }] },
    { role: "tool", toolCallId: "1", content: "b".repeat(100) },
    { role: "user", content: "new" },
    { role: "assistant", content: "ok" },
  ];
  const trimmed = trimHistory(history, 50);
  expect(trimmed[0]).toEqual({ role: "user", content: "new" });
  expect(trimHistory(history, 10_000)).toHaveLength(5);
});

test("reminds the model to apply a fix when it only shows code", async () => {
  const history: ChatMessage[] = [{ role: "user", content: "fix" }];
  const result = await runAgent({
    client: scripted([
      { content: "```js\nreturn a + b;\n```", toolCalls: [] },
      { content: "", toolCalls: [{ id: "e", name: "edit_file", arguments: "{}" }] },
      { content: "Fixed.", toolCalls: [] },
    ]),
    systemPrompt: "s",
    history,
    tools: [],
    executeTool: async () => ({ content: "ok", changed: true }),
    requireChanges: true,
    maxSteps: 10,
    meter: meter(),
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ status: "done", filesChanged: true, steps: 3 });
  expect(history[2]).toMatchObject({ role: "user", content: expect.stringContaining("did not change any file") });
});

test("stops reminding after the limit", async () => {
  const result = await runAgent({
    client: scripted([
      { content: "a", toolCalls: [] },
      { content: "b", toolCalls: [] },
    ]),
    systemPrompt: "s",
    history: [],
    tools: [],
    executeTool: async () => ({ content: "" }),
    requireChanges: true,
    maxNudges: 1,
    maxSteps: 10,
    meter: meter(),
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ status: "done", filesChanged: false, steps: 2 });
});

/** A model that says a few words and then never answers, until the request is stopped. */
function hangsFirst(): ModelClient & { calls: number } {
  const client = {
    calls: 0,
    async complete(request: { signal: AbortSignal }, onText: (delta: string) => void): Promise<CompletionResult> {
      client.calls++;
      if (client.calls === 1) {
        onText("Partial");
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        );
      }
      onText("Done.");
      return { content: "Done.", toolCalls: [] };
    },
  };
  return client;
}

test("Retry sends a quiet model request again, and the task goes on", async () => {
  const client = hangsFirst();
  const control: { retry?: () => void } = {};
  const events: string[] = [];
  const running = runAgent({
    client,
    systemPrompt: "system",
    history: [{ role: "user", content: "hi" }],
    tools: [],
    executeTool: async () => ({ content: "" }),
    maxSteps: 5,
    meter: meter(),
    signal: new AbortController().signal,
    requestControl: control,
    events: { onText: (delta) => events.push(delta), onRequestRestart: () => events.push("restart") },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(control.retry).toBeTypeOf("function");
  control.retry?.();
  const result = await running;
  expect(result.status).toBe("done");
  expect(client.calls).toBe(2);
  expect(events).toEqual(["Partial", "restart", "Done."]);
  expect(control.retry).toBeUndefined();
});

test("Stop still ends the task while a request hangs", async () => {
  const client = hangsFirst();
  const controller = new AbortController();
  const running = runAgent({
    client,
    systemPrompt: "system",
    history: [{ role: "user", content: "hi" }],
    tools: [],
    executeTool: async () => ({ content: "" }),
    maxSteps: 5,
    meter: meter(),
    signal: controller.signal,
    requestControl: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await expect(running).rejects.toThrow();
  expect(client.calls).toBe(1);
});
