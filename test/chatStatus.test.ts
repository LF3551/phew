import { describe, expect, test } from "vitest";
import { chatStatus, failureLine, isStalled, stalledAfterMs } from "../src/core/chatStatus";

const idle = { busy: false, needsApproval: false, stalled: false } as const;

describe("chatStatus", () => {
  test("an idle chat shows its time", () => {
    expect(chatStatus(idle)).toEqual({ kind: "idle", label: "", description: "" });
  });

  test("each state has its label", () => {
    expect(chatStatus({ ...idle, busy: true }).label).toBe("Running");
    expect(chatStatus({ ...idle, needsApproval: true }).label).toBe("Needs input");
    expect(chatStatus({ ...idle, busy: true, stalled: true }).label).toBe("Model quiet");
    expect(chatStatus({ ...idle, busy: true, fallback: "Claude (personal)" }).label).toBe("On Claude (personal)");
    expect(chatStatus({ ...idle, outcome: "failed" }).label).toBe("Failed");
    expect(chatStatus({ ...idle, outcome: "done" }).label).toBe("Done");
  });

  test("the user comes first, then a problem, then work, then the result", () => {
    const everything = {
      busy: true,
      needsApproval: true,
      stalled: true,
      fallback: "GPT",
      outcome: "failed",
    } as const;
    expect(chatStatus(everything).kind).toBe("waiting");
    expect(chatStatus({ ...everything, needsApproval: false }).kind).toBe("stalled");
    expect(chatStatus({ ...everything, needsApproval: false, stalled: false }).kind).toBe("fallback");
    expect(chatStatus({ ...everything, needsApproval: false, stalled: false, fallback: undefined }).kind).toBe(
      "running",
    );
  });

  test("a stall or a fallback only counts while the task runs", () => {
    expect(chatStatus({ ...idle, stalled: true }).kind).toBe("idle");
    expect(chatStatus({ ...idle, fallback: "GPT" }).kind).toBe("idle");
    expect(chatStatus({ ...idle, stalled: true, outcome: "done" }).kind).toBe("done");
  });

  test("a running task hides the result of the last one", () => {
    expect(chatStatus({ ...idle, busy: true, outcome: "failed" }).kind).toBe("running");
  });

  test("every state but idle explains itself for screen readers", () => {
    for (const input of [
      { ...idle, busy: true },
      { ...idle, needsApproval: true },
      { ...idle, busy: true, stalled: true },
      { ...idle, busy: true, fallback: "GPT" },
      { ...idle, outcome: "failed" as const },
      { ...idle, outcome: "done" as const },
    ])
      expect(chatStatus(input).description.length).toBeGreaterThan(5);
  });
});

describe("isStalled", () => {
  const base = { busy: true, modelRequest: true, needsApproval: false, lastEventAt: 0 };

  test("a model request that is quiet for a minute is stalled", () => {
    expect(isStalled({ ...base, now: stalledAfterMs - 1 })).toBe(false);
    expect(isStalled({ ...base, now: stalledAfterMs })).toBe(true);
  });

  test("a long command, a question, or an idle chat is not a stall", () => {
    const late = { ...base, now: stalledAfterMs * 5 };
    expect(isStalled({ ...late, modelRequest: false })).toBe(false);
    expect(isStalled({ ...late, needsApproval: true })).toBe(false);
    expect(isStalled({ ...late, busy: false })).toBe(false);
  });
});

describe("failureLine", () => {
  test("takes the first line with text", () => {
    expect(failureLine("\n  Claude has no quota left.\nDetails follow")).toBe("Claude has no quota left.");
  });

  test("shortens a long reason", () => {
    const line = failureLine("x".repeat(400));
    expect(line).toHaveLength(158);
    expect(line.endsWith("…")).toBe(true);
  });

  test("is empty without a reason", () => {
    expect(failureLine(undefined)).toBe("");
    expect(failureLine("  \n ")).toBe("");
  });
});
