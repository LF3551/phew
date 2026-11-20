import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../src/core/chat";
import { pruneStaleToolResults } from "../src/core/contextTrim";

/** A task with `steps` steps; each step calls one tool and gets `size` characters back. */
function task(steps: number, size = 20_000, tool = "read_file"): ChatMessage[] {
  const history: ChatMessage[] = [{ role: "user", content: "Fix it." }];
  for (let index = 1; index <= steps; index++) {
    const id = `c${index}`;
    history.push({
      role: "assistant",
      content: "",
      toolCalls: [
        { id, name: tool, arguments: JSON.stringify({ path: `src/file${index}.ts`, command: `npm test ${index}` }) },
      ],
    });
    history.push({ role: "tool", toolCallId: id, content: `${index}:`.padEnd(size, "x") });
  }
  return history;
}

const options = { keepSteps: 4, minChars: 1500, triggerChars: 40_000 };
const toolContents = (history: readonly ChatMessage[]) =>
  history.filter((message) => message.role === "tool").map((message) => message.content);

describe("pruneStaleToolResults", () => {
  test("replaces large old outputs with a note, and keeps the last steps", () => {
    const result = pruneStaleToolResults(task(8), options);
    const contents = toolContents(result.history);
    expect(result.removed).toBe(4);
    expect(contents.slice(0, 4).every((content) => content.startsWith("[Removed to save context:"))).toBe(true);
    expect(contents[0]).toBe(
      "[Removed to save context: the output of read_file src/file1.ts (20,000 characters). Run it again if you need it.]",
    );
    expect(contents.slice(4).every((content) => content.length === 20_000)).toBe(true);
    expect(result.savedChars).toBeGreaterThan(79_000);
  });

  test("waits until enough old output piles up, so the prompt cache keeps working", () => {
    // Two old outputs of 15,000 characters: less than the trigger, nothing changes yet.
    const small = pruneStaleToolResults(task(6, 15_000), options);
    expect(small.removed).toBe(0);
    expect(toolContents(small.history).every((content) => content.length === 15_000)).toBe(true);
    // A third one passes the trigger: all of them go at once.
    expect(pruneStaleToolResults(task(7, 15_000), options).removed).toBe(3);
  });

  test("a second pass right after changes nothing", () => {
    const once = pruneStaleToolResults(task(8), options);
    const twice = pruneStaleToolResults(once.history, options);
    expect(twice.removed).toBe(0);
    expect(twice.history).toEqual(once.history);
  });

  test("small outputs stay", () => {
    expect(pruneStaleToolResults(task(30, 1000), options).removed).toBe(0);
  });

  test("answers of the user, skills, the plan, memory, and reports of subagents stay", () => {
    for (const tool of ["ask_user", "load_skill", "read_skill_file", "update_plan", "remember", "delegate"])
      expect(pruneStaleToolResults(task(8, 20_000, tool), options).removed, tool).toBe(0);
  });

  test("commands name what they ran", () => {
    const result = pruneStaleToolResults(task(8, 20_000, "run_command"), options);
    expect(toolContents(result.history)[0]).toMatch(
      /the output of run_command src\/file1\.ts|the output of run_command npm test 1/,
    );
  });

  test("never changes the given history, the user message, or the calls", () => {
    const history = task(8);
    const before = JSON.stringify(history);
    const result = pruneStaleToolResults(history, options);
    expect(JSON.stringify(history)).toBe(before);
    expect(result.history.filter((message) => message.role !== "tool")).toEqual(
      history.filter((message) => message.role !== "tool"),
    );
  });

  test("a short task has nothing to prune", () => {
    expect(pruneStaleToolResults(task(3), options).removed).toBe(0);
    expect(pruneStaleToolResults([], options).removed).toBe(0);
  });
});
