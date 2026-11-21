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
    terminalStyleUri: "vscode-webview://x/webview.css",
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

test("accepts an optional chat id for export", () => {
  expect(parseWebviewMessage({ type: "exportChat" })).toEqual({ type: "exportChat" });
  expect(parseWebviewMessage({ type: "exportChat", id: "chat_1" })).toEqual({ type: "exportChat", id: "chat_1" });
  expect(parseWebviewMessage({ type: "exportChat", id: "../x" })).toBeUndefined();
});

test("accepts pinning a chat", () => {
  expect(parseWebviewMessage({ type: "pinChat", id: "c_1", pinned: true })).toEqual({
    type: "pinChat",
    id: "c_1",
    pinned: true,
  });
  expect(parseWebviewMessage({ type: "pinChat", id: "c_1", pinned: "yes" })).toBeUndefined();
});

test("the menus of the input send the context query and the custom modes link", () => {
  expect(parseWebviewMessage({ type: "contextQuery" })).toEqual({ type: "contextQuery" });
  expect(parseWebviewMessage({ type: "editModes", extra: 1 })).toEqual({ type: "editModes" });
});

test("approval levels match the presets and name the differences", async () => {
  const { approvalLevel, approvalPresets, approvalDifferences } = await import("../src/core/approvals");
  expect(approvalLevel(approvalPresets.autopilot)).toBe("autopilot");
  expect(approvalLevel({ review: "editor", commands: "safe", mcp: false })).toBe("custom");
  expect(approvalDifferences({ ...approvalPresets.balanced, commands: "safe" }, approvalPresets.balanced)).toEqual([
    "Commands: All (default: Smart)",
  ]);
  expect(parseWebviewMessage({ type: "setApprovalLevel", level: "careful" })).toEqual({
    type: "setApprovalLevel",
    level: "careful",
  });
  expect(parseWebviewMessage({ type: "setApprovalLevel", level: "yolo" })).toBeUndefined();
});

test("the terminal in the chat reads the result of a command", async () => {
  const { parseCommandResult } = await import("../src/core/commandResult");
  expect(parseCommandResult("$ npm test\n[exit code 1]\nFAIL src/a.test.ts")).toEqual({
    command: "npm test",
    status: "exit code 1",
    exitCode: 1,
    output: "FAIL src/a.test.ts",
  });
  expect(
    parseCommandResult(
      "$ sleep 9\n[cancelled]\n(no output)\nThe user stopped this command. Do not run it again unless the user asks.",
    ).output,
  ).toBe("");
  expect(parseCommandResult("$ cd src\n[exit code 0]\n(no output)\nThe shell is now in src.").output).toBe("");
  expect(parseWebviewMessage({ type: "stopCommand", id: "t_1" })).toEqual({ type: "stopCommand", id: "t_1" });
});

test("the model menu names models without repeats", async () => {
  const { modelTitle, contextSize } = await import("../src/core/modelLabels");
  expect(
    modelTitle({
      id: "a",
      name: "GitHub Copilot · claude-haiku-5.5",
      provider: "openai",
      model: "claude-haiku-5.5",
      active: true,
      contextWindow: 200_000,
    }),
  ).toEqual({ title: "GitHub Copilot", detail: "claude-haiku-5.5 · OpenAI-compatible · 200K context" });
  expect(modelTitle({ id: "b", name: "Auto", provider: "vscode", model: "auto", active: false }).title).toBe("Auto");
  expect(contextSize(1_000_000)).toBe("1M");
  expect(parseWebviewMessage({ type: "useModel", id: "p1" })).toEqual({ type: "useModel", id: "p1" });
});

test("terminal output loses escape codes and redrawn lines", async () => {
  const { cleanTerminalText } = await import("../src/host/commandRunner");
  expect(cleanTerminalText("\u001b[32mok\u001b[0m\r\nprogress 10%\rprogress 100%\n")).toBe("ok\nprogress 100%\n");
});

test.skipIf(process.platform === "win32")("a command remembers its folder between commands", async () => {
  const { runShellCommand } = await import("../src/host/commandRunner");
  const { realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const result = await runShellCommand(`cd ${tmpdir()} && echo hi`, process.cwd(), 10, new AbortController().signal);
  expect(result.output.trim()).toBe("hi");
  expect(result.exitCode).toBe(0);
  expect(result.cwd).toBe(realpathSync(tmpdir()));
  const failed = await runShellCommand("exit 3", process.cwd(), 10, new AbortController().signal);
  expect(failed.exitCode).toBe(3);
});

test.skipIf(process.platform === "win32")(
  "exported variables carry over between commands, like one shell",
  async () => {
    const { runShellCommand } = await import("../src/host/commandRunner");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const envFile = join(tmpdir(), `phew-env-test-${Date.now()}`);
    const signal = new AbortController().signal;
    await runShellCommand("export PHEW_T=7", process.cwd(), 10, signal, undefined, { envFile });
    const next = await runShellCommand('echo "t=$PHEW_T"', process.cwd(), 10, signal, undefined, { envFile });
    expect(next.output.trim()).toBe("t=7");
    let input: { write(text: string): void; end(): void } | undefined;
    const typed = runShellCommand("read name; echo hi $name", process.cwd(), 10, signal, undefined, {
      onInput: (handle) => {
        input = handle;
      },
    });
    input?.write("Ann\n");
    expect((await typed).output.trim()).toBe("hi Ann");
  },
);

test("the input line of a command echoes, edits, and sends like a terminal", async () => {
  const { LineEditor } = await import("../src/core/lineEditor");
  const echoed: string[] = [];
  const sent: string[] = [];
  let stopped = 0;
  let ended = 0;
  const line = new LineEditor({
    echo: (text) => echoed.push(text),
    submit: (text) => sent.push(text),
    interrupt: () => stopped++,
    endOfInput: () => ended++,
  });
  line.feed("yex\u007fs\u001b[A\r");
  expect(sent).toEqual(["yes\n"]);
  expect(echoed.join("")).toBe("yex\b \bs\r\n");
  line.feed("\u0003");
  line.feed("last\u0004");
  expect(stopped).toBe(1);
  expect(sent.at(-1)).toBe("last");
  expect(ended).toBe(1);
});

test("terminal actions of other chats and opening a port are validated", () => {
  expect(parseWebviewMessage({ type: "terminalAction", id: "2", action: "kill", chatId: "c_abc-1" })).toEqual({
    type: "terminalAction",
    id: "2",
    action: "kill",
    chatId: "c_abc-1",
  });
  expect(parseWebviewMessage({ type: "terminalAction", id: "2", action: "show", chatId: "../x" })).toEqual({
    type: "terminalAction",
    id: "2",
    action: "show",
  });
  expect(parseWebviewMessage({ type: "openPort", port: 5173 })).toEqual({ type: "openPort", port: 5173 });
  for (const port of [0, 70000, 3.5, "5173", -1])
    expect(parseWebviewMessage({ type: "openPort", port })).toBeUndefined();
});

test("a click on the plan of the model is a plain message", () => {
  expect(parseWebviewMessage({ type: "checkPlan" })).toEqual({ type: "checkPlan" });
});
