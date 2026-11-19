import { describe, expect, test } from "vitest";
import { runAgent } from "../src/core/agent";
import type { ChatMessage, CompletionResult, ModelClient, ToolCall } from "../src/core/chat";
import { CostMeter } from "../src/core/cost";
import { builtInModes } from "../src/core/modes";
import {
  delegateTool,
  delegateToolName,
  Limiter,
  parseDelegate,
  subagentPrompt,
  subagentResult,
  subagentToolNames,
} from "../src/core/subagents";
import { toolsForMode } from "../src/core/tools";
import { type SubagentMessage, stepLabel, subagentModel, subagentState } from "../src/webview/subagentLabels";

const models = [
  { id: "work", name: "Claude (work)" },
  { id: "fast", name: "Gemini Flash" },
];
const limits = { maxParallel: 3, maxSteps: 25 };

describe("the delegate tool", () => {
  test("asks for a title and a complete task", () => {
    const tool = delegateTool(models, limits);
    expect(tool.name).toBe(delegateToolName);
    expect(tool.parameters).toMatchObject({ required: ["title", "task"], additionalProperties: false });
    expect(tool.description).toMatch(/up to 3 at once/);
    expect(tool.description).toMatch(/up to 25 steps/);
    expect(tool.description).toMatch(/cannot change files, run commands, or ask the user/);
  });

  test("offers the models of the user by id, with their names", () => {
    const model = (
      delegateTool(models, limits).parameters as {
        properties: Record<string, { enum?: string[]; description?: string }>;
      }
    ).properties.model;
    expect(model?.enum).toEqual(["work", "fast"]);
    expect(model?.description).toMatch(/work: Claude \(work\); fast: Gemini Flash/);
  });

  test("with one model there is nothing to choose", () => {
    const properties = (
      delegateTool([models[0] as (typeof models)[0]], limits).parameters as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(properties).not.toHaveProperty("model");
  });
});

describe("parseDelegate", () => {
  test("reads the title, the task, and the model", () => {
    expect(
      parseDelegate({ title: " Find  callers ", task: " Find every caller of parse. ", model: "fast" }, models),
    ).toEqual({
      title: "Find callers",
      task: "Find every caller of parse.",
      model: "fast",
    });
  });

  test("the model can be named, and may be left out", () => {
    expect(parseDelegate({ title: "x", task: "y", model: "gemini flash" }, models)).toMatchObject({ model: "fast" });
    expect(parseDelegate({ title: "x", task: "y" }, models)).toEqual({ title: "x", task: "y" });
    expect(parseDelegate({ title: "x", task: "y", model: "" }, models)).toEqual({ title: "x", task: "y" });
  });

  test("a missing title comes from the first line of the task", () => {
    expect(parseDelegate({ task: "Map the auth flow\nStart in src/auth" }, models)).toMatchObject({
      title: "Map the auth flow",
    });
  });

  test("explains what is wrong, so the model can fix it", () => {
    expect(parseDelegate({ title: "x" }, models)).toBe("Give the subagent a task.");
    expect(parseDelegate({ title: "x", task: "   " }, models)).toBe("Give the subagent a task.");
    expect(parseDelegate({ task: "y".repeat(20_001) }, models)).toMatch(/too long/);
    expect(parseDelegate({ task: "y", model: "gpt-9" }, models)).toBe(
      'There is no model "gpt-9". Use one of: work, fast.',
    );
    expect(parseDelegate({ task: "y", model: 3 }, models)).toMatch(/one of the listed ids/);
  });
});

describe("what a subagent may do", () => {
  test("it only reads: no edits, commands, MCP, questions, plan, memory, or subagents", () => {
    for (const name of [
      "list_files",
      "read_file",
      "search_text",
      "search_code",
      "git_diff",
      "get_problems",
      "load_skill",
    ])
      expect(subagentToolNames.has(name), name).toBe(true);
    for (const name of [
      "edit_file",
      "write_file",
      "run_command",
      "read_terminal",
      "ask_user",
      "update_plan",
      "remember",
      "forget",
      "delegate",
      "mcp__demo__echo",
    ])
      expect(subagentToolNames.has(name), name).toBe(false);
  });

  test("every tool of the Code mode that changes something is out of reach", () => {
    const code = builtInModes.find((mode) => mode.id === "code");
    if (!code) throw new Error("no Code mode");
    const reachable = toolsForMode(code, { memory: true, index: true, skills: true, terminals: true })
      .map((tool) => tool.name)
      .filter((name) => subagentToolNames.has(name));
    expect(reachable.sort()).toEqual(
      [
        "get_problems",
        "git_diff",
        "list_files",
        "load_skill",
        "read_file",
        "read_skill_file",
        "search_code",
        "search_text",
      ].sort(),
    );
  });

  test("its prompt says so, and carries the rules of the project", () => {
    const prompt = subagentPrompt({ workspace: "shop", platform: "linux", date: "2026-11-19", rules: "Use pnpm." });
    expect(prompt).toMatch(/read-only tools/);
    expect(prompt).toMatch(/cannot change files, run commands, or ask anyone/);
    expect(prompt).toMatch(/file paths with line numbers/);
    expect(prompt).toMatch(/Workspace: shop/);
    expect(prompt).toMatch(/Rules of the project:\nUse pnpm\./);
    expect(subagentPrompt({ workspace: "shop", platform: "linux", date: "d" })).not.toMatch(/Rules of the project/);
  });
});

describe("the report for the agent of the chat", () => {
  const base = { model: "Gemini Flash", steps: 4, seconds: 12.4 };

  test("a finished subagent reports with its model and effort", () => {
    expect(subagentResult({ ...base, status: "done", answer: "parse is called in a.ts:3 and b.ts:9." })).toBe(
      "The subagent (Gemini Flash) finished in 4 steps, 12 s. Its report:\n\nparse is called in a.ts:3 and b.ts:9.",
    );
    expect(subagentResult({ ...base, status: "done", answer: " " })).toMatch(/without a report/);
    expect(subagentResult({ ...base, steps: 1, status: "done", answer: "x" })).toMatch(/1 step,/);
  });

  test("a failure says why, keeps what it had, and suggests the next move", () => {
    const text = subagentResult({ ...base, status: "failed", error: "no quota", answer: "Half of it." });
    expect(text).toMatch(/^The subagent \(Gemini Flash\) failed after 4 steps, 12 s: no quota\./);
    expect(text).toMatch(/What it had so far:\nHalf of it\./);
    expect(text).toMatch(/Do the work yourself, or delegate it again with another model\./);
  });

  test("a stop by the user is said plainly", () => {
    expect(subagentResult({ ...base, status: "stopped" })).toBe(
      "The user stopped the subagent (Gemini Flash) before it finished.",
    );
  });

  test("names the fallback that did the work", () => {
    expect(subagentResult({ ...base, status: "done", answer: "x", fallback: "GPT" })).toMatch(
      /^The subagent \(GPT \(fallback for Gemini Flash\)\)/,
    );
  });

  test("a long report is cut and says so", () => {
    const text = subagentResult({ ...base, status: "done", answer: "a".repeat(20_000) });
    expect(text).toMatch(/\[The report was cut at 16000 characters\.\]$/);
    expect(text.length).toBeLessThan(16_300);
  });
});

describe("Limiter", () => {
  test("never runs more than its size at once, and runs all", async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
          done.push(index);
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(limiter.active).toBe(0);
  });

  test("a failed task frees its place", async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
    expect(limiter.active).toBe(0);
  });

  test("a size below one still runs tasks one by one", async () => {
    await expect(new Limiter(0).run(async () => 1)).resolves.toBe(1);
  });
});

describe("subagents in the agent loop", () => {
  const call = (id: string, name: string): ToolCall => ({ id, name, arguments: "{}" });

  function scripted(results: CompletionResult[]): ModelClient {
    let index = 0;
    return {
      async complete() {
        const result = results[index++];
        if (!result) throw new Error("No scripted result.");
        return result;
      },
    };
  }

  test("delegate calls next to each other run at the same time, and their results keep the order", async () => {
    const client = scripted([
      {
        content: "",
        toolCalls: [
          call("1", "read_file"),
          call("2", "delegate"),
          call("3", "delegate"),
          call("4", "delegate"),
          call("5", "read_file"),
        ],
      },
      { content: "Done.", toolCalls: [] },
    ]);
    const log: string[] = [];
    let running = 0;
    let peak = 0;
    const history: ChatMessage[] = [{ role: "user", content: "go" }];
    await runAgent({
      client,
      systemPrompt: "s",
      history,
      tools: [],
      concurrent: (item) => item.name === "delegate",
      executeTool: async (item) => {
        log.push(`start ${item.id}`);
        running++;
        peak = Math.max(peak, running);
        // The first subagent takes the longest, so the order of the results is not the order of the ends.
        await new Promise((resolve) => setTimeout(resolve, item.id === "2" ? 30 : 5));
        running--;
        log.push(`end ${item.id}`);
        return { content: `result ${item.id}` };
      },
      maxSteps: 5,
      meter: new CostMeter(undefined, { maxCostPerTask: 0, maxTokensPerTask: 0 }),
      signal: new AbortController().signal,
    });
    expect(peak).toBe(3);
    expect(log.slice(0, 2)).toEqual(["start 1", "end 1"]);
    expect(log.slice(2, 5).sort()).toEqual(["start 2", "start 3", "start 4"]);
    expect(log.at(-2)).toBe("start 5");
    expect(history.filter((message) => message.role === "tool").map((message) => message.content)).toEqual([
      "result 1",
      "result 2",
      "result 3",
      "result 4",
      "result 5",
    ]);
  });

  test("without the option every call runs alone, as before", async () => {
    let running = 0;
    let peak = 0;
    await runAgent({
      client: scripted([
        { content: "", toolCalls: [call("1", "delegate"), call("2", "delegate")] },
        { content: "Done.", toolCalls: [] },
      ]),
      systemPrompt: "s",
      history: [{ role: "user", content: "go" }],
      tools: [],
      executeTool: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return { content: "ok" };
      },
      maxSteps: 5,
      meter: new CostMeter(undefined, { maxCostPerTask: 0, maxTokensPerTask: 0 }),
      signal: new AbortController().signal,
    });
    expect(peak).toBe(1);
  });
});

describe("the cost of subagents", () => {
  test("their tokens and cost count for the task and its budget", () => {
    const task = new CostMeter({ input: 3, output: 15 }, { maxCostPerTask: 5, maxTokensPerTask: 0 });
    task.add({ inputTokens: 1_000_000, outputTokens: 0 });
    task.lastInputTokens = 1234;
    const subagent = new CostMeter({ input: 0.5, output: 1 }, { maxCostPerTask: 0, maxTokensPerTask: 0 });
    subagent.add({ inputTokens: 2_000_000, outputTokens: 1_000_000 });
    task.absorb(subagent);
    expect(task.tokens).toBe(4_000_000);
    expect(task.cost).toBeCloseTo(3 + 1 + 1);
    expect(task.lastInputTokens).toBe(1234);
    expect(task.exceeded()).toMatch(/reaches the limit/);
  });

  test("a subagent without a price makes the cost unknown, an idle one changes nothing", () => {
    const task = new CostMeter({ input: 1, output: 1 }, { maxCostPerTask: 0, maxTokensPerTask: 0 });
    task.absorb(new CostMeter(undefined, { maxCostPerTask: 0, maxTokensPerTask: 0 }));
    expect(task.cost).toBe(0);
    const unpriced = new CostMeter(undefined, { maxCostPerTask: 0, maxTokensPerTask: 0 });
    unpriced.add({ inputTokens: 10, outputTokens: 10 });
    task.absorb(unpriced);
    expect(task.cost).toBeUndefined();
  });
});

describe("the card of a subagent", () => {
  const message = (overrides: Partial<SubagentMessage>): SubagentMessage => ({
    type: "subagent",
    id: "s1",
    title: "Find callers",
    task: "Find every caller of parse.",
    model: "Gemini Flash",
    status: "running",
    steps: [],
    stepCount: 0,
    ...overrides,
  });

  test("shows the current step while it runs", () => {
    expect(subagentState(message({}))).toBe("Starting…");
    expect(
      subagentState(message({ steps: [{ name: "read_file", summary: "read_file src/a.ts" }], stepCount: 1 })),
    ).toMatch(/^Reading .*src\/a\.ts…$/);
  });

  test("shows the facts when it is over", () => {
    expect(subagentState(message({ status: "done", stepCount: 5, seconds: 12.6 }))).toBe("Done · 5 steps · 13 s");
    expect(subagentState(message({ status: "failed", stepCount: 1, seconds: 0.2 }))).toBe("Failed · 1 step · 1 s");
    expect(subagentState(message({ status: "stopped" }))).toBe("Stopped");
  });

  test("names a fallback model and its switch", () => {
    expect(subagentModel(message({}))).toBe("Gemini Flash");
    expect(subagentModel(message({ fallback: "GPT" }))).toBe("GPT (fallback)");
    expect(
      stepLabel({ name: "fallback", summary: "Gemini Flash has no quota or credit left; GPT goes on" }, false),
    ).toBe("Gemini Flash has no quota or credit left; GPT goes on");
  });
});
