import { describe, expect, test } from "vitest";
import {
  agentsBlock,
  blockEnd,
  blockStart,
  buildHandoffMessages,
  continuePrompt,
  handoffFileName,
  parseHandoffMeta,
  parseNarrative,
  renderHandoff,
  staleness,
  upsertBlock,
} from "../src/core/handoff";
import { exitCodeOf, factsFromJournal, type JournalEvent, journalLine, parseJournal } from "../src/core/journal";
import { parseWebviewMessage } from "../src/shared/protocol";

const token = `ghp_${"a".repeat(36)}`;

const events: JournalEvent[] = [
  { t: "session", at: 1, session: "s1", title: "Login", branch: "main", head: "abc" },
  { t: "user", at: 2, text: `Fix the login timeout\nmore details ${token}` },
  { t: "tool", at: 3, name: "edit_file", summary: "src/auth.ts", ok: true, file: "src/auth.ts" },
  { t: "tool", at: 4, name: "edit_file", summary: "src/auth.ts", ok: true, file: "src/auth.ts" },
  { t: "tool", at: 5, name: "write_file", summary: "x", ok: false, file: "src/broken.ts" },
  { t: "tool", at: 6, name: "run_command", summary: "npm test", ok: false, command: "npm test", exit: 1 },
  { t: "verify", at: 7, command: "npm test", passed: true, attempt: 2 },
  { t: "task", at: 8, status: "done", files: ["src/auth.ts"] },
];

describe("journal", () => {
  test("lines are redacted, and broken lines are skipped", () => {
    const text = `${events.map(journalLine).join("")}{"broken"\n`;
    expect(text).not.toContain(token);
    const parsed = parseJournal(text);
    expect(parsed).toHaveLength(events.length);
    expect(parsed[0]).toMatchObject({ t: "session", title: "Login" });
  });

  test("facts come only from the journal", () => {
    const facts = factsFromJournal(parseJournal(events.map(journalLine).join("")));
    expect(facts.files).toEqual([{ path: "src/auth.ts", edits: 2 }]);
    expect(facts.commands).toEqual([{ command: "npm test", exit: 1, ok: false }]);
    expect(facts.lastCheck).toEqual({ command: "npm test", passed: true, attempt: 2 });
    expect(facts.tasks).toBe(1);
    expect(facts.requests).toEqual(["Fix the login timeout"]);
  });

  test("exit codes from command output", () => {
    expect(exitCodeOf("$ npm test\n[exit code 1]\nfail")).toBe(1);
    expect(exitCodeOf("$ x\n[timed out]\n")).toBeNull();
    expect(exitCodeOf("no status")).toBeUndefined();
  });
});

describe("handoff notes", () => {
  const previous = {
    title: "Login",
    status: "in-progress" as const,
    summary: "s",
    decisions: [
      { id: "D1", text: "Retry with backoff — keeps UI responsive", status: "active" as const },
      { id: "D2", text: "Keep the old API", status: "active" as const },
    ],
    deadEnds: [],
    nextSteps: [],
    openQuestions: [],
    preferences: ["Do not push without asking"],
  };

  test("the narrative keeps earlier decisions and preferences", () => {
    const narrative = parseNarrative(
      '```json\n{"title":"Fix login timeout","status":"blocked","summary":"Two tests fail.","decisions":[{"id":"D2","text":"Use the new API","status":"replaced"},{"id":"D3","text":"Fake timers in tests","status":"active"}],"deadEnds":["Timeout 60 s: hides the bug"],"nextSteps":["Fix test/auth.test.ts:42"],"preferences":["Answer in Russian"]}\n```',
      "Fallback",
      previous,
    );
    expect(narrative.title).toBe("Fix login timeout");
    expect(narrative.status).toBe("blocked");
    expect(narrative.decisions.map((item) => `${item.id}:${item.status}`)).toEqual([
      "D1:active",
      "D2:replaced",
      "D3:active",
    ]);
    expect(narrative.preferences).toEqual(["Answer in Russian", "Do not push without asking"]);
    const fallback = parseNarrative("Not JSON at all", "Fallback", previous);
    expect(fallback).toMatchObject({ title: "Fallback", summary: "Not JSON at all" });
    expect(fallback.decisions).toHaveLength(2);
  });

  test("render and read a note", () => {
    const facts = factsFromJournal(events);
    const narrative = parseNarrative(
      '{"title":"Fix login timeout","status":"in-progress","summary":"Retry added.","nextSteps":["Run npm test"],"deadEnds":["60 s timeout"]}',
      "x",
    );
    const markdown = renderHandoff({
      meta: {
        schema: "phew-handoff/1",
        title: narrative.title,
        status: narrative.status,
        session: "s1",
        created: "2026-11-17T10:00:00.000Z",
        branch: "main",
        head: "abcdef1234",
        fingerprints: { "src/auth.ts": "1234" },
      },
      narrative,
      facts,
      plan: { goal: "Login works on slow networks", items: [{ text: "Add retry", status: "done" }] },
      verifyCommand: "npm test",
    });
    expect(markdown).toContain("# Handoff: Fix login timeout");
    expect(markdown).toContain("## Next steps\n\n1. Run npm test");
    expect(markdown).toContain("## Dead ends: do not repeat");
    expect(markdown).toContain("- `src/auth.ts` (2 edits)");
    expect(markdown).toContain("- ✗ `npm test` (exit 1)");
    expect(markdown).toContain("- [x] Add retry");
    expect(markdown).not.toContain(token);
    const meta = parseHandoffMeta(markdown);
    expect(meta).toMatchObject({
      title: "Fix login timeout",
      head: "abcdef1234",
      fingerprints: { "src/auth.ts": "1234" },
    });
    expect(parseHandoffMeta("# not a note")).toBeUndefined();
  });

  test("staleness finds changes after the note", () => {
    const meta = {
      schema: "phew-handoff/1",
      title: "t",
      status: "in-progress" as const,
      session: "s",
      created: "",
      branch: "main",
      head: "a",
      fingerprints: { "a.ts": "1", "b.ts": "2" },
    };
    expect(staleness(meta, { branch: "main", head: "a", fingerprints: { "a.ts": "1", "b.ts": "2" } }).fresh).toBe(true);
    const stale = staleness(meta, {
      branch: "dev",
      head: "b",
      commitsSince: 2,
      headReachable: true,
      fingerprints: { "a.ts": "9", "b.ts": "2" },
    });
    expect(stale.fresh).toBe(false);
    expect(stale.notes.join(" ")).toContain("branch `main`");
    expect(stale.notes.join(" ")).toContain("2 commits were made");
    expect(stale.notes.join(" ")).toContain("`a.ts`");
    expect(staleness(meta, { head: "c", headReachable: false, fingerprints: {} }).notes[0]).toContain(
      "not in the current history",
    );
    expect(continuePrompt("p.md", "# note", stale)).toContain("Read the changed files");
  });

  test("the AGENTS.md block is inserted once and replaced later", () => {
    const first = upsertBlock("# Rules\n\nUse tabs.\n", agentsBlock(false));
    expect(first.startsWith("# Rules\n\nUse tabs.\n\n<!-- phew:handoff:begin -->")).toBe(true);
    const second = upsertBlock(first, agentsBlock(true));
    expect(second.split(blockStart)).toHaveLength(2);
    expect(second).toContain(".phew/memory.md");
    expect(second.endsWith(`${blockEnd}\n`)).toBe(true);
    expect(upsertBlock("", agentsBlock(false))).toBe(`${agentsBlock(false)}\n`);
  });

  test("file names and the request to the model", () => {
    expect(handoffFileName(new Date(2026, 10, 17), "Fix the Login: timeout!", "s_abc123xyz")).toBe(
      "2026-11-17-fix-the-login-timeout-123xyz.md",
    );
    const messages = buildHandoffMessages({
      history: [{ role: "user", content: "fix it" }],
      facts: factsFromJournal(events),
      plan: { items: [] },
    });
    expect(messages[0].content).toContain("one JSON object");
    expect(messages[1].content).toContain("USER: fix it");
    expect(messages[1].content).toContain("Changed files: src/auth.ts");
  });

  test("the continue message accepts only notes", () => {
    expect(parseWebviewMessage({ type: "continueHandoff" })).toEqual({ type: "continueHandoff" });
    expect(parseWebviewMessage({ type: "continueHandoff", path: ".phew/handoff/a.md" })).toBeDefined();
    expect(parseWebviewMessage({ type: "continueHandoff", path: "../../etc/passwd" })).toBeUndefined();
  });
});

test("the prompt lists the unfinished work of other sessions, the latest note of each, at most three", async () => {
  const { unfinishedWork } = await import("../src/core/handoff");
  const note = (session: string, title: string, status: string, day: string) => ({
    path: `.phew/handoff/${day}-${session}.md`,
    title,
    status,
    created: `2026-11-${day}T10:00:00Z`,
    session,
  });
  const text = unfinishedWork(
    [
      note("a", "Fix login", "in-progress", "10"),
      note("a", "Fix login, part 2", "blocked", "12"),
      note("b", "Add export", "done", "13"),
      note("c", "Speed up tests", "in-progress", "11"),
      note("d", "Current chat", "in-progress", "14"),
      note("e", "Old idea", "in-progress", "01"),
      note("f", "Older idea", "in-progress", "02"),
    ],
    "d",
  );
  expect(text).toContain('"Fix login, part 2" (blocked, 2026-11-12)');
  expect(text).not.toContain('"Fix login" (');
  expect(text).not.toContain("Add export");
  expect(text).not.toContain("Current chat");
  expect(text).toContain("Speed up tests");
  expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
  expect(unfinishedWork([note("b", "Done", "done", "13")], "x")).toBe("");
});
