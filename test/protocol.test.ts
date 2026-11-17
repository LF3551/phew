import * as path from "node:path";
import { expect, test } from "vitest";
import { resolveInside, toRelative } from "../src/core/paths";
import { emptyStats, estimatedMinutesSaved, normalizeStats, recordOutcome } from "../src/core/stats";
import { escapeHtml, renderChatHtml } from "../src/host/html";
import { parseWebviewMessage } from "../src/shared/protocol";

test("accepts valid webview messages", () => {
  expect(parseWebviewMessage({ type: "send", text: "  fix  " })).toEqual({
    type: "send",
    text: "fix",
    attachments: [],
  });
  expect(parseWebviewMessage({ type: "setMode", mode: "plan" })).toEqual({ type: "setMode", mode: "plan" });
  expect(parseWebviewMessage({ type: "approve", id: "approval_1", decision: "allow", hunks: [0, 2] })).toEqual({
    type: "approve",
    id: "approval_1",
    decision: "allow",
    hunks: [0, 2],
  });
});

test.each([
  null,
  { type: "send", text: "" },
  { type: "setMode", mode: "Root Mode!" },
  { type: "approve", id: "../x", decision: "allow" },
  { type: "approve", id: "a", decision: "maybe" },
  { type: "approve", id: "a", decision: "allow", hunks: [-1] },
  { type: "restoreCheckpoint", checkpointId: "<script>" },
  { type: "unknown" },
])("rejects invalid webview message %#", (value) => {
  expect(parseWebviewMessage(value)).toBeUndefined();
});

test("keeps paths inside the workspace", () => {
  const root = path.resolve("w");
  expect(resolveInside(root, "src/a.ts")).toBe(path.join(root, "src", "a.ts"));
  expect(resolveInside(root, path.join(root, "b"))).toBe(path.join(root, "b"));
  expect(resolveInside(root, "../etc/passwd")).toBeUndefined();
  expect(resolveInside(root, path.resolve("etc", "passwd"))).toBeUndefined();
  expect(resolveInside(root, "a\0b")).toBeUndefined();
  expect(toRelative(root, path.join(root, "src", "a.ts"))).toBe("src/a.ts");
});

test("the chat page uses a strict policy and escapes values", () => {
  const html = renderChatHtml({
    cspSource: "vscode-webview://x",
    nonce: "n0nce",
    scriptUri: "vscode-webview://x/webview.js",
    styleUri: "vscode-webview://x/chat.css",
    iconUri: '"><script>alert(1)</script>',
  });
  const decoded = html.replaceAll("&#39;", "'");
  expect(decoded).toContain("default-src 'none'");
  expect(decoded).toContain("script-src 'nonce-n0nce'");
  expect(html).not.toMatch(/unsafe-inline|unsafe-eval|https?:\/\//);
  expect(html).not.toContain("<script>alert");
  expect(escapeHtml(`<&"'>`)).toBe("&lt;&amp;&quot;&#39;&gt;");
});

test("statistics survive invalid stored values", () => {
  const stats = normalizeStats({ bugsFixed: 2, tokens: -5, cost: "x" }, 10);
  expect(stats).toEqual({ ...emptyStats(10), bugsFixed: 2 });
  const next = recordOutcome(stats, { success: true, bugFixed: true, filesChanged: 3, tokens: 100, cost: 0.5 });
  expect(next).toMatchObject({ bugsFixed: 3, tasksCompleted: 1, filesChanged: 3, tokens: 100, cost: 0.5 });
  expect(estimatedMinutesSaved(next, 15)).toBe(45);
});

test("new webview messages are validated", () => {
  expect(parseWebviewMessage({ type: "send", text: "", attachments: [{ kind: "problems" }] })).toEqual({
    type: "send",
    text: "",
    attachments: [{ kind: "problems" }],
  });
  expect(parseWebviewMessage({ type: "send", text: "x", attachments: [{ kind: "bad" }] })).toBeUndefined();
  expect(parseWebviewMessage({ type: "send", text: "", attachments: [] })).toBeUndefined();
  expect(parseWebviewMessage({ type: "setApproval", key: "commands", value: "safe" })).toBeDefined();
  expect(parseWebviewMessage({ type: "setApproval", key: "commands", value: "yolo" })).toBeUndefined();
  expect(parseWebviewMessage({ type: "setApproval", key: "mcp", value: "true" })).toBeUndefined();
  expect(parseWebviewMessage({ type: "setMode", mode: "my-mode" })).toEqual({ type: "setMode", mode: "my-mode" });
  expect(parseWebviewMessage({ type: "openConversation", id: "c_1" })).toEqual({ type: "openConversation", id: "c_1" });
  expect(parseWebviewMessage({ type: "openConversation", id: "../x" })).toBeUndefined();
  expect(parseWebviewMessage({ type: "mentionQuery", query: "x".repeat(300) })).toBeUndefined();
});
