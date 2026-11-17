import { expect, test } from "vitest";
import { fileChange, formatDuration, summaryHeadline, summaryTotals } from "../src/core/summary";
import { parseWebviewMessage } from "../src/shared/protocol";

test("line counts per file", () => {
  expect(fileChange("a.ts", "one\ntwo\nthree\n", "one\n2\nthree\nfour\n")).toEqual({
    path: "a.ts",
    kind: "modified",
    added: 2,
    removed: 1,
  });
  expect(fileChange("new.ts", null, "x\ny\n")).toEqual({ path: "new.ts", kind: "added", added: 2, removed: 0 });
  expect(fileChange("old.ts", "x\n", null)).toEqual({ path: "old.ts", kind: "deleted", added: 0, removed: 1 });
  expect(fileChange("same.ts", "x\n", "x\n")).toBeUndefined();
});

test("headlines and totals", () => {
  const files = [
    { path: "a", kind: "modified" as const, added: 12, removed: 3 },
    { path: "b", kind: "added" as const, added: 40, removed: 0 },
  ];
  expect(summaryTotals(files)).toBe("2 files changed, +52 −3");
  expect(
    summaryHeadline({ status: "done", seconds: 42, files, check: { command: "npm test", passed: true, attempts: 1 } }),
  ).toBe("Phew! Done and checked in 42 s");
  expect(summaryHeadline({ status: "done", seconds: 5, files })).toBe("Phew! Done in 5 s");
  expect(summaryHeadline({ status: "aborted", seconds: 75, files })).toBe("Stopped after 1 min 15 s");
  expect(formatDuration(120)).toBe("2 min");
});

test("summary and suggestion messages are validated", () => {
  expect(parseWebviewMessage({ type: "taskAction", action: "keep", checkpointId: "cp_1" })).toBeDefined();
  expect(parseWebviewMessage({ type: "taskAction", action: "delete", checkpointId: "cp_1" })).toBeUndefined();
  expect(parseWebviewMessage({ type: "taskAction", action: "undo", checkpointId: "../x" })).toBeUndefined();
  expect(parseWebviewMessage({ type: "runSuggestion", id: "errors" })).toEqual({ type: "runSuggestion", id: "errors" });
  expect(parseWebviewMessage({ type: "runSuggestion", id: "rm -rf /" })).toBeUndefined();
  expect(parseWebviewMessage({ type: "suggest" })).toEqual({ type: "suggest" });
});
