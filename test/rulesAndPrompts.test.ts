import { expect, test } from "vitest";
import { buildCommandFixRequest, buildFixRequest, buildSystemPrompt } from "../src/core/prompts";
import { combineRules } from "../src/core/rules";

test("combines rules, skips empty and duplicate files, and respects the limit", () => {
  const combined = combineRules(
    [
      { path: "AGENTS.md", content: "Use tabs." },
      { path: ".cursorrules", content: "Use tabs." },
      { path: "CLAUDE.md", content: "   " },
      { path: ".clinerules", content: "x".repeat(100) },
    ],
    60,
  );
  expect(combined).toContain("### AGENTS.md\nUse tabs.");
  expect(combined).not.toContain(".cursorrules");
  expect(combined).toContain("[Rules truncated]");
});

test("the system prompt depends on the mode and includes rules", () => {
  const base = { workspaceName: "app", platform: "linux", shell: "bash", date: "2026-01-01", rules: "" };
  expect(buildSystemPrompt({ ...base, mode: "ask" })).toContain("Ask mode");
  const code = buildSystemPrompt({ ...base, mode: "code", rules: "No any.", verifyCommand: "npm test" });
  expect(code).toContain("Code mode");
  expect(code).toContain("`npm test`");
  expect(code).toContain("No any.");
  expect(code).toContain("**Problem:**");
});

test("fix requests contain the problem and the code", () => {
  const request = buildFixRequest({
    path: "src/a.ts",
    line: 3,
    severity: "error",
    message: "x is not defined",
    source: "ts",
    code: "2304",
    excerpt: "> 3| x();",
  });
  expect(request).toContain("src/a.ts at line 3 (ts 2304)");
  expect(request).toContain("> x is not defined");
  expect(buildCommandFixRequest("npm test", 1, "FAIL")).toContain("exit code 1");
});
