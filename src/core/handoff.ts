import type { ChatMessage } from "./chat";
import { conversationTranscript } from "./compaction";
import type { Decision, HandoffNarrative, JournalFacts } from "./journal";
import type { Plan } from "./plan";
import { redactSecrets } from "./secrets";

/**
 * Handoff notes: a short Markdown file that lets any agent or person continue the work.
 * Facts come from the journal. The meaning (decisions, dead ends, next steps) comes from the model.
 */

export const handoffSchema = "phew-handoff/1";
export const handoffFolder = ".phew/handoff";
export const latestHandoff = `${handoffFolder}/LATEST.md`;

export interface HandoffMeta {
  readonly schema: string;
  readonly title: string;
  readonly status: HandoffNarrative["status"];
  readonly session: string;
  readonly created: string;
  readonly branch?: string;
  readonly head?: string;
  readonly goal?: string;
  readonly check?: { readonly command: string; readonly passed: boolean };
  /** Short SHA-256 of each changed file when the note was written. "deleted" for removed files. */
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly continues?: string;
}

// The request to the model

const narrativeShape = `{
  "title": "short task title, at most 8 words",
  "status": "in-progress" | "done" | "blocked",
  "summary": "2 to 4 sentences: what the task is, where it stands, what is verified",
  "decisions": [{ "id": "D1", "text": "decision — the reason", "status": "active" | "replaced" | "dropped" }],
  "deadEnds": ["what was tried and why it failed or was rejected"],
  "nextSteps": ["concrete action with file paths and commands"],
  "openQuestions": ["question that only the user can answer"],
  "preferences": ["explicit instruction from the user that must still be followed"]
}`;

export function buildHandoffMessages(input: {
  readonly history: readonly ChatMessage[];
  readonly facts: JournalFacts;
  readonly plan: Plan;
}): ChatMessage[] {
  const { facts, plan } = input;
  const context = [
    facts.previous ? `Previous handoff (carry its decisions forward):\n${JSON.stringify(facts.previous)}` : "",
    plan.goal ? `Goal: ${plan.goal}` : "",
    plan.items.length > 0 ? `Plan:\n${plan.items.map((item) => `- [${item.status}] ${item.text}`).join("\n")}` : "",
    facts.files.length > 0 ? `Changed files: ${facts.files.map((file) => file.path).join(", ")}` : "",
    facts.lastCheck ? `Last check: ${facts.lastCheck.command} ${facts.lastCheck.passed ? "passed" : "failed"}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    {
      role: "system",
      content: [
        "You write a handoff note so that another coding agent, possibly a different product, can continue this work without the conversation.",
        "Answer with one JSON object and nothing else, in this shape:",
        narrativeShape,
        "Rules:",
        "- Use only what the conversation shows. Do not invent results. If something was not verified, say so.",
        "- Do not list changed files or commands: Phew adds them from its journal.",
        "- Keep the decisions of the previous handoff with the same ids. Mark them replaced or dropped when they changed. New decisions get the next ids.",
        "- Dead ends save the next agent from repeating them. Include rejected approaches and the reason.",
        "- Next steps are concrete and in order. The first one can start right away.",
        "- Preferences are explicit user instructions such as language, style, or what not to do without asking.",
        "- Write in English, concisely. No secrets.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `${context ? `${context}\n\n` : ""}Conversation:\n\n${conversationTranscript(input.history, 60_000)}`,
    },
  ];
}

const strings = (value: unknown, maximum = 12): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim().slice(0, 500))
        .slice(0, maximum)
    : [];

/** Reads the answer of the model. Falls back to a plain summary when the answer is not valid JSON. */
export function parseNarrative(text: string, fallbackTitle: string, previous?: HandoffNarrative): HandoffNarrative {
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  let value: Record<string, unknown> | undefined;
  if (start >= 0 && end > start) {
    try {
      value = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      value = undefined;
    }
  }
  if (!value) {
    return {
      title: fallbackTitle,
      status: "in-progress",
      summary: body.slice(0, 1500) || "No summary.",
      decisions: previous?.decisions ?? [],
      deadEnds: previous?.deadEnds ?? [],
      nextSteps: [],
      openQuestions: [],
      preferences: previous?.preferences ?? [],
    };
  }
  const decisions: Decision[] = [];
  if (Array.isArray(value.decisions)) {
    for (const item of value.decisions.slice(0, 20)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const textValue = typeof record.text === "string" ? record.text.trim().slice(0, 500) : "";
      if (!textValue) continue;
      const id = typeof record.id === "string" && /^D\d{1,3}$/.test(record.id) ? record.id : `D${decisions.length + 1}`;
      const status = record.status === "replaced" || record.status === "dropped" ? record.status : "active";
      decisions.push({ id, text: textValue, status });
    }
  }
  // Decisions of the previous note that the model forgot stay in the record.
  for (const old of previous?.decisions ?? []) if (!decisions.some((item) => item.id === old.id)) decisions.push(old);
  decisions.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const status = value.status === "done" || value.status === "blocked" ? value.status : "in-progress";
  return {
    title: (typeof value.title === "string" && value.title.trim().slice(0, 80)) || fallbackTitle,
    status,
    summary: (typeof value.summary === "string" && value.summary.trim().slice(0, 1500)) || "No summary.",
    decisions,
    deadEnds: strings(value.deadEnds),
    nextSteps: strings(value.nextSteps),
    openQuestions: strings(value.openQuestions),
    preferences: [...new Set([...strings(value.preferences), ...(previous?.preferences ?? [])])].slice(0, 12),
  };
}

// The note

const yaml = (value: unknown) => JSON.stringify(value);

function frontMatter(meta: HandoffMeta): string {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yaml(value)}`);
  return `---\n${lines.join("\n")}\n---`;
}

function list(items: readonly string[], numbered = false): string {
  return items.map((item, index) => `${numbered ? `${index + 1}.` : "-"} ${item.replace(/\n+/g, " ")}`).join("\n");
}

function formatExit(exit: number | null | undefined): string {
  return exit === undefined ? "" : exit === null ? " (did not finish)" : ` (exit ${exit})`;
}

export function renderHandoff(input: {
  readonly meta: HandoffMeta;
  readonly narrative: HandoffNarrative;
  readonly facts: JournalFacts;
  readonly plan: Plan;
  readonly verifyCommand?: string;
}): string {
  const { meta, narrative, facts, plan } = input;
  const statusLabel = { "in-progress": "In progress", done: "Done", blocked: "Blocked" }[narrative.status];
  const check = facts.lastCheck
    ? `last check \`${facts.lastCheck.command}\` ${facts.lastCheck.passed ? "passed" : "failed"}${facts.lastCheck.attempt > 1 ? ` (attempt ${facts.lastCheck.attempt})` : ""}`
    : "no automatic check ran";
  const sections: string[] = [
    frontMatter(meta),
    `# Handoff: ${narrative.title}`,
    "> **For any coding agent:** this note lets you continue this work. First check that it is still true (see **How to verify** and compare the commit and files in the header), then continue with **Next steps**. The **Facts** come from the Phew journal. The other sections are a summary written by the model.",
    `**Status:** ${statusLabel} · ${facts.tasks} ${facts.tasks === 1 ? "task" : "tasks"} · ${check}${meta.branch ? ` · branch \`${meta.branch}\`` : ""}${meta.head ? ` at \`${meta.head.slice(0, 7)}\`` : ""}`,
    `## Summary\n\n${narrative.summary}`,
  ];
  if (plan.goal) sections.push(`## Goal\n\n${plan.goal}`);
  if (narrative.nextSteps.length > 0) sections.push(`## Next steps\n\n${list(narrative.nextSteps, true)}`);
  const active = narrative.decisions.filter((decision) => decision.status === "active");
  const old = narrative.decisions.filter((decision) => decision.status !== "active");
  if (narrative.decisions.length > 0)
    sections.push(
      `## Decisions\n\n${[
        ...active.map((decision) => `- **${decision.id}** ${decision.text}`),
        ...old.map((decision) => `- ~~**${decision.id}** ${decision.text}~~ (${decision.status})`),
      ].join("\n")}`,
    );
  if (narrative.deadEnds.length > 0) sections.push(`## Dead ends: do not repeat\n\n${list(narrative.deadEnds)}`);
  if (narrative.openQuestions.length > 0) sections.push(`## Open questions\n\n${list(narrative.openQuestions)}`);
  if (narrative.preferences.length > 0) sections.push(`## User preferences\n\n${list(narrative.preferences)}`);
  if (plan.items.length > 0)
    sections.push(
      `## Plan\n\n${plan.items.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.text}${item.status === "in_progress" ? " (in progress)" : ""}`).join("\n")}`,
    );
  const facts_: string[] = [];
  if (facts.files.length > 0)
    facts_.push(
      `### Changed files\n\n${facts.files.map((file) => `- \`${file.path}\`${file.edits > 1 ? ` (${file.edits} edits)` : ""}`).join("\n")}`,
    );
  if (facts.commands.length > 0)
    facts_.push(
      `### Commands\n\n${facts.commands.map((command) => `- ${command.ok ? "✓" : "✗"} \`${command.command.replace(/`/g, "'")}\`${formatExit(command.exit)}`).join("\n")}`,
    );
  if (facts.requests.length > 0) facts_.push(`### Requests of the user\n\n${list(facts.requests.slice(-10))}`);
  if (facts_.length > 0) sections.push(`## Facts\n\n${facts_.join("\n\n")}`);
  const verify = input.verifyCommand || facts.lastCheck?.command;
  sections.push(
    `## How to verify\n\n${verify ? `Run \`${verify}\`. ` : ""}${facts.lastCheck ? `It ${facts.lastCheck.passed ? "passed" : "failed"} when this note was written. ` : ""}Compare the current commit with \`head\` and the files with \`fingerprints\` in the header: a difference means someone changed the code after this note.`,
  );
  if (meta.continues) sections.push(`_This session continued from \`${meta.continues}\`._`);
  return `${redactSecrets(sections.join("\n\n")).text}\n`;
}

/** Reads the header of a note. Values are JSON, which is also valid YAML. */
export function parseHandoffMeta(markdown: string): HandoffMeta | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown.replace(/\r\n/g, "\n"));
  if (!match) return undefined;
  const values: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) continue;
    try {
      values[line.slice(0, separator)] = JSON.parse(line.slice(separator + 2));
    } catch {
      values[line.slice(0, separator)] = line.slice(separator + 2);
    }
  }
  if (values.schema !== handoffSchema || typeof values.title !== "string") return undefined;
  return {
    ...(values as unknown as HandoffMeta),
    fingerprints:
      values.fingerprints && typeof values.fingerprints === "object"
        ? (values.fingerprints as Record<string, string>)
        : {},
  };
}

// Freshness

export interface CurrentState {
  readonly branch?: string;
  readonly head?: string;
  /** Commits on the current branch after the head of the note, when Git can tell. */
  readonly commitsSince?: number;
  /** Whether the head of the note is still in the history of the current branch. */
  readonly headReachable?: boolean;
  readonly fingerprints: Readonly<Record<string, string>>;
}

export interface Staleness {
  readonly fresh: boolean;
  readonly notes: readonly string[];
}

/** Compares a note with the current code, so the next agent knows what changed after the note. */
export function staleness(meta: HandoffMeta, current: CurrentState): Staleness {
  const notes: string[] = [];
  if (meta.branch && current.branch && meta.branch !== current.branch)
    notes.push(`The note was written on branch \`${meta.branch}\`; the current branch is \`${current.branch}\`.`);
  if (meta.head && current.head && meta.head !== current.head) {
    if (current.headReachable === false)
      notes.push(
        `The commit of the note (\`${meta.head.slice(0, 7)}\`) is not in the current history: it was rebased, reset, or is on another branch.`,
      );
    else if (current.commitsSince !== undefined && current.commitsSince > 0)
      notes.push(
        `${current.commitsSince} ${current.commitsSince === 1 ? "commit was" : "commits were"} made after the note.`,
      );
  }
  const changed = Object.entries(meta.fingerprints)
    .filter(([path, hash]) => current.fingerprints[path] !== undefined && current.fingerprints[path] !== hash)
    .map(([path]) => `\`${path}\``);
  if (changed.length > 0)
    notes.push(
      `${changed.length === 1 ? "This file changed" : "These files changed"} after the note: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", …" : ""}.`,
    );
  return { fresh: notes.length === 0, notes };
}

/** The first message of a chat that continues from a note. */
export function continuePrompt(path: string, markdown: string, state: Staleness): string {
  return [
    `Continue the work from the handoff note \`${path}\` below.`,
    state.fresh
      ? "Phew found no changes to the code after the note."
      : `Phew found changes after the note:\n${state.notes.map((note) => `- ${note}`).join("\n")}\nRead the changed files before you rely on the note.`,
    "First check that the note is still true: run the check from **How to verify** if there is one. Then tell me in two or three sentences where the work stands, and continue with the next steps. Follow the user preferences and do not repeat the dead ends.",
    "",
    markdown.trim(),
  ].join("\n");
}

// AGENTS.md

export const blockStart = "<!-- phew:handoff:begin -->";
export const blockEnd = "<!-- phew:handoff:end -->";

export function agentsBlock(hasMemory: boolean): string {
  return [
    blockStart,
    "## Continuing earlier work",
    "",
    `Before you start, read \`${latestHandoff}\` if it exists. It is a short handoff note from the last agent session: the goal, the decisions and why, dead ends not to repeat, and the next steps. Check it against the current code first: its header records the commit and file fingerprints at the time it was written.`,
    ...(hasMemory ? ["", "Durable facts about this project are in `.phew/memory.md`."] : []),
    blockEnd,
  ].join("\n");
}

/** Inserts or replaces the Phew block. The rest of the file stays as it is. */
export function upsertBlock(content: string, block: string): string {
  const start = content.indexOf(blockStart);
  const end = content.indexOf(blockEnd);
  if (start >= 0 && end > start) return content.slice(0, start) + block + content.slice(end + blockEnd.length);
  const trimmed = content.replace(/\s*$/, "");
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/** A file name for a note: date, task, and session. */
export function handoffFileName(date: Date, title: string, session: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const slug =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return `${day}-${slug}-${session.replace(/[^A-Za-z0-9]/g, "").slice(-6)}.md`;
}

/**
 * The unfinished work of other sessions, for the system prompt: the latest note of each session that is not
 * done, newest first, at most three.
 */
export function unfinishedWork(
  notes: readonly { path: string; title: string; status: string; created: string; session?: string }[],
  currentSession: string,
): string {
  const latest = new Map<string, (typeof notes)[number]>();
  for (const note of [...notes].sort((a, b) => b.created.localeCompare(a.created))) {
    const key = note.session ?? note.path;
    if (!latest.has(key)) latest.set(key, note);
  }
  const open = [...latest.values()]
    .filter((note) => note.status !== "done" && note.session !== currentSession)
    .slice(0, 3);
  if (open.length === 0) return "";
  return [
    "Unfinished work from earlier sessions, with handoff notes. If the request of the user continues one of them, read that note first and check it against the code:",
    ...open.map((note) => `- \`${note.path}\`: "${note.title}" (${note.status}, ${note.created.slice(0, 10)})`),
  ].join("\n");
}
