import { expect, test } from "vitest";
import { groupSummary, toolLabel } from "../src/webview/toolLabels";

test("tools are described in plain words", () => {
  expect(toolLabel("read_file", "read_file src/auth.ts", true)).toBe("Reading src/auth.ts");
  expect(toolLabel("read_file", "read_file src/auth.ts", false)).toBe("Read src/auth.ts");
  expect(toolLabel("run_command", "run_command npm test", true)).toBe("Running npm test");
  expect(toolLabel("update_plan", "update_plan Ship the login fix", false)).toBe("Updated the plan");
  expect(toolLabel("mcp__github__create_issue", "mcp__github__create_issue", true)).toBe("Using create_issue (github)");
  expect(toolLabel("custom", "custom x", false)).toBe("Used custom x");
});

test("a group of tools has one short summary", () => {
  expect(groupSummary(["read_file", "read_file", "search_text", "edit_file", "run_command"])).toBe(
    "Read 2 files, ran 1 search, edited 1 file and ran 1 command",
  );
  expect(groupSummary(["edit_file"])).toBe("Edited 1 file");
  expect(groupSummary(["get_problems", "ask_user"])).toBe("Made 1 check and used 1 tool");
});
