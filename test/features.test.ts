import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { attachmentLabel, extractMentions, formatContext, parseAttachment } from "../src/core/attachments";
import { CheckpointStore } from "../src/core/checkpoints";
import { CodeIndex, chunkFile, cosineSimilarity, formatHits, tokenize } from "../src/core/codeIndex";
import { decideCommand } from "../src/core/commandPolicy";
import {
  adjustAgentGitCommand,
  buildCommitMessages,
  type CommitSettings,
  describeCommitIdentity,
  effectiveIdentity,
  finalizeCommitMessage,
  parseAuthor,
} from "../src/core/commit";
import { buildCompletionMessages, cleanCompletion, parseNextEdit } from "../src/core/completion";
import { conversationToMarkdown, titleFromText } from "../src/core/export";
import { addNote, cleanNote, parseMemory } from "../src/core/memory";
import { builtInModes, canChange, findMode, parseCustomModes } from "../src/core/modes";
import { keepHunk, reviewHunks, undoHunk } from "../src/core/review";
import { toolGroup, toolsForMode } from "../src/core/tools";
import { branchName, isValidBranch, parseWorktreeList, worktreeFolder } from "../src/core/worktree";

describe("editor review", () => {
  const original = "a\nb\nc\nd\n";
  const current = "a\nB\nc\nD\ne\n";

  test("keep moves one hunk into the baseline", () => {
    const next = keepHunk({ original, current }, 0);
    expect(next.current).toBe(current);
    expect(reviewHunks(next)).toHaveLength(1);
    expect(reviewHunks(keepHunk(next, 0))).toHaveLength(0);
  });

  test("undo restores the original lines of one hunk only", () => {
    expect(undoHunk({ original, current }, 0).current).toBe("a\nb\nc\nD\ne\n");
    expect(undoHunk({ original, current }, 1).current).toBe("a\nB\nc\nd\n");
    expect(undoHunk({ original, current }, 9)).toEqual({ original, current });
  });
});

describe("attachments", () => {
  test("validate attachments from the webview", () => {
    expect(parseAttachment({ kind: "file", path: "src/a.ts" })).toEqual({ kind: "file", path: "src/a.ts" });
    expect(
      parseAttachment({ kind: "image", name: "x.png", mimeType: "image/png", data: "iVBORw0KGgo=" }),
    ).toBeDefined();
    expect(parseAttachment({ kind: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" })).toBeUndefined();
    expect(parseAttachment({ kind: "image", mimeType: "image/png", data: "<script>" })).toBeUndefined();
    expect(parseAttachment({ kind: "selection", path: "a", startLine: "x", endLine: 2, text: "" })).toBeUndefined();
    expect(parseAttachment({ kind: "shell", command: "rm" })).toBeUndefined();
    expect(attachmentLabel({ kind: "selection", path: "a.ts", startLine: 2, endLine: 5, text: "" })).toBe("a.ts:2-5");
  });

  test("find typed mentions and ignore emails and decorators", () => {
    expect(extractMentions("look at @src/app.ts and @problems, mail me at a@b.com, @Component(")).toEqual([
      { kind: "file", path: "src/app.ts" },
      { kind: "problems" },
    ]);
    expect(extractMentions("@git @terminal @README.md")).toEqual([
      { kind: "git" },
      { kind: "terminal", output: "" },
      { kind: "file", path: "README.md" },
    ]);
  });

  test("format context with safe fences", () => {
    const context = formatContext([{ title: "a.md", body: "```js\nx\n```", language: "md" }]);
    expect(context).toContain("````md");
    expect(formatContext([])).toBe("");
  });
});

describe("history and export", () => {
  test("titles are short and checkpoints survive serialization", () => {
    expect(titleFromText("   Fix   the login bug  ")).toBe("Fix the login bug");
    expect(titleFromText("word ".repeat(30)).length).toBeLessThanOrEqual(61);
    const store = new CheckpointStore();
    store.begin("one", "first", 5);
    store.record("a.ts", "old");
    store.record("b.ts", null);
    const restored = CheckpointStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    expect(restored.restore("one")).toEqual([
      { path: "a.ts", content: "old" },
      { path: "b.ts", content: null },
    ]);
    expect(CheckpointStore.fromJSON("junk").list()).toEqual([]);
  });

  test("exports a conversation as Markdown", () => {
    const markdown = conversationToMarkdown(
      [
        { role: "user", content: "Fix it" },
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a"}' }] },
        { role: "tool", toolCallId: "1", content: "```\ncode\n```" },
        { role: "assistant", content: "**Fix:** done." },
      ],
      { title: "Bug", model: "M", mode: "Code", date: new Date("2026-01-02T03:04:00Z") },
    );
    expect(markdown).toContain("# Bug");
    expect(markdown).toContain("_Date: 2026-01-02 03:04 · Model: M · Mode: Code_");
    expect(markdown).toContain("## You\n\nFix it");
    expect(markdown).toContain("> Tool: `read_file`");
    expect(markdown).toContain("````\n```\ncode\n```\n````");
    expect(
      conversationToMarkdown([{ role: "tool", toolCallId: "1", content: "x" }], { title: "T", includeTools: false }),
    ).toBe("# T\n");
  });
});

describe("code index", () => {
  test("tokenizes identifiers", () => {
    expect(tokenize("getUserName(user_id) HTTPServer")).toEqual(
      expect.arrayContaining(["getusername", "get", "user", "name", "user_id", "id", "httpserver", "http", "server"]),
    );
  });

  test("chunks files with overlap", () => {
    const chunks = chunkFile("a.ts", Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"), 40, 8);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 40],
      [33, 72],
      [65, 100],
    ]);
  });

  test("ranks relevant code, updates files, and survives serialization", () => {
    const index = new CodeIndex();
    index.setFile(
      "/w/src/auth/login.ts",
      "1",
      "export async function loginUser(email, password) {\n  return verifyPassword(password);\n}",
    );
    index.setFile("/w/src/math.ts", "1", "export const add = (a, b) => a + b;");
    index.setFile("/w/README.md", "1", "This project has a login page.");
    expect(index.search("where is the user login handled")[0].path).toBe("/w/src/auth/login.ts");
    expect(index.search("add numbers")[0].path).toBe("/w/src/math.ts");
    index.setFile("/w/src/math.ts", "2", "export const multiply = (a, b) => a * b;");
    expect(index.search("multiply")[0].path).toBe("/w/src/math.ts");
    expect(index.search("add")).toHaveLength(0);
    const copy = CodeIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
    expect(copy.fileCount).toBe(3);
    expect(copy.stamp("/w/src/math.ts")).toBe("2");
    index.removeFile("/w/README.md");
    expect(index.fileCount).toBe(2);
    expect(formatHits([])).toMatch(/No relevant code/);
  });

  test("mixes in embeddings when vectors exist", () => {
    const index = new CodeIndex();
    index.setFile("a", "1", "alpha", [[1, 0]]);
    index.setFile("b", "1", "beta", [[0, 1]]);
    expect(index.search("unrelated", 2, [0, 1])[0].path).toBe("b");
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
  });
});

describe("commits", () => {
  const settings: CommitSettings = {
    style: "conventional",
    language: "English",
    maxSubjectLength: 72,
    includeBody: true,
    signOff: true,
    gpgSign: "git",
    author: "",
    trailers: ["Refs: #12"],
    instructions: "",
  };

  test("prompt rules and diff redaction", () => {
    const [system, user] = buildCommitMessages(`+ token = "${"ghp_".padEnd(40, "a")}"`, settings, ["fix: x"]);
    expect(system.content).toContain("Conventional Commits");
    expect(system.content).toContain("- fix: x");
    expect(user.content).not.toContain("ghp_aaaa");
  });

  test("the final message removes invented trailers and adds configured ones", () => {
    const message = finalizeCommitMessage(
      "```\nfeat: add login\n\nAdds the login form.\n\nCo-authored-by: Bot <bot@example.com>\n```",
      settings,
      { name: "Alice", email: "alice@example.com" },
    );
    expect(message).toBe(
      "feat: add login\n\nAdds the login form.\n\nRefs: #12\nSigned-off-by: Alice <alice@example.com>",
    );
    expect(
      finalizeCommitMessage("fix: x\n\nbody", { ...settings, includeBody: false, signOff: false, trailers: [] }, {}),
    ).toBe("fix: x");
  });

  test("identity and signing are explained", () => {
    expect(parseAuthor("Bob Smith <bob@example.com>")).toEqual({ name: "Bob Smith", email: "bob@example.com" });
    expect(parseAuthor("bob")).toBeUndefined();
    expect(effectiveIdentity({ ...settings, author: "Bot <bot@x.io>" }, { name: "A", email: "a@x.io" }).source).toBe(
      "phew.commit.author",
    );
    expect(describeCommitIdentity(settings, { name: "A", email: "a@x.io", gpgSign: true, gpgFormat: "ssh" })).toBe(
      "Author: A <a@x.io> from Git configuration. Commits are signed (ssh), with Signed-off-by.",
    );
    expect(describeCommitIdentity({ ...settings, signOff: false, gpgSign: "never" }, {})).toContain("not configured");
  });

  test("agent commit commands get the configured flags", () => {
    const result = adjustAgentGitCommand('git commit -m "x"', {
      ...settings,
      gpgSign: "always",
      author: "Bot <bot@x.io>",
    });
    expect(result.command).toBe('git commit -m "x" --signoff --gpg-sign --author="Bot <bot@x.io>"');
    expect(result.notes).toHaveLength(3);
    expect(adjustAgentGitCommand("git commit -s -m x", settings).command).toBe("git commit -s -m x");
    expect(adjustAgentGitCommand("git status", settings)).toEqual({ command: "git status", notes: [] });
  });
});

describe("memory", () => {
  test("adds clean, unique notes", () => {
    const first = addNote("", "Use pnpm, not npm.");
    expect(first.added).toBe(true);
    expect(parseMemory(first.content)).toEqual(["Use pnpm, not npm."]);
    expect(addNote(first.content, "use PNPM, not npm.").added).toBe(false);
    expect(cleanNote(`key AKIAABCDEFGHIJKLMNOP\nnext`)).toBe("key [REDACTED AWS access key] next");
    expect(cleanNote("   ")).toBeUndefined();
    expect(cleanNote("x".repeat(500))?.length).toBe(300);
  });
});

describe("completion and next edit", () => {
  const context = { path: "a.ts", language: "typescript", prefix: "function add(a, b) {\n  return ", suffix: ";\n}\n" };

  test("builds a prompt with the cursor", () => {
    expect(buildCompletionMessages(context)[1].content).toContain("return <CURSOR>;");
  });

  test("cleans completions", () => {
    expect(cleanCompletion("```ts\na + b\n```", context, 5)).toBe("a + b");
    expect(cleanCompletion("  return a + b", context, 5)).toBe("a + b");
    expect(cleanCompletion("1\n2\n3\n4", context, 2)).toBe("1\n2");
    expect(cleanCompletion("   ", context, 2)).toBe("");
  });

  test("parses next edits safely", () => {
    expect(parseNextEdit('Sure: {"startLine": 2, "endLine": 2, "replacement": "x"}', 5)).toEqual({
      startLine: 2,
      endLine: 2,
      replacement: "x",
    });
    expect(parseNextEdit('{"none": true}', 5)).toBeUndefined();
    expect(parseNextEdit('{"startLine": 9, "endLine": 9, "replacement": "x"}', 5)).toBeUndefined();
    expect(parseNextEdit("no json", 5)).toBeUndefined();
  });
});

describe("modes, tools, and command approval", () => {
  test("custom modes validate and limit tools", () => {
    const { modes, errors } = parseCustomModes([
      { id: "docs", name: "Docs", tools: ["read", "edit", "root"] },
      { id: "code", name: "Again" },
      { id: "Bad Id" },
    ]);
    expect(modes).toHaveLength(1);
    expect([...modes[0].tools]).toEqual(["read", "edit"]);
    expect(errors).toHaveLength(2);
    const tools = toolsForMode(modes[0]).map((tool) => tool.name);
    expect(tools).toContain("edit_file");
    expect(tools).not.toContain("run_command");
    expect(canChange(modes[0])).toBe(true);
    expect(canChange(findMode("review", builtInModes))).toBe(false);
    expect(findMode("unknown", builtInModes).id).toBe("code");
    expect(toolGroup("mcp__x__y")).toBe("mcp");
    expect(toolsForMode(findMode("ask", builtInModes), { index: false }).map((tool) => tool.name)).not.toContain(
      "search_code",
    );
  });

  test("command approval modes", () => {
    const base = { autoApprove: ["npm test"], deny: [] };
    expect(decideCommand("ls -la", { ...base, mode: "safe" }).kind).toBe("allow");
    expect(decideCommand("git push", { ...base, mode: "safe" }).kind).toBe("ask");
    expect(decideCommand("npm test", { ...base, mode: "ask" }).kind).toBe("ask");
    expect(decideCommand("npm test", { ...base, mode: "allowlist" }).kind).toBe("allow");
    // Smart runs read-only commands without an allowlist entry, and asks for the rest.
    expect(decideCommand("ls", { ...base, mode: "allowlist" }).kind).toBe("allow");
    expect(decideCommand("npm install", { ...base, mode: "allowlist" }).kind).toBe("ask");
  });
});

describe("worktrees", () => {
  test("branch names and folders", () => {
    expect(branchName("Add input validation to the signup form!")).toBe("phew/add-input-validation-to-the-signup-form");
    expect(branchName("???", "feature/")).toBe("feature/task");
    expect(isValidBranch("phew/fix-login")).toBe(true);
    expect(isValidBranch("bad..name")).toBe(false);
    expect(isValidBranch("-x")).toBe(false);
    const repo = path.resolve("repo", "app");
    expect(worktreeFolder(repo, "phew/fix")).toBe(path.join(path.dirname(repo), "app.phew-worktrees", "phew-fix"));
    expect(worktreeFolder(repo, "x", "../trees")).toBe(path.join(path.dirname(repo), "trees", "x"));
  });

  test("parses the worktree list", () => {
    expect(
      parseWorktreeList("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/x\nHEAD def\ndetached\n"),
    ).toEqual([
      { path: "/repo", head: "abc", branch: "main" },
      { path: "/tmp/x", head: "def", branch: undefined },
    ]);
  });
});
