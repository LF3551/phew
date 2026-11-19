import { redactSecrets } from "./secrets";

/**
 * Memory: durable facts that Phew gives the agent in every chat, in plain Markdown files that people can read
 * and edit. Two scopes:
 * - project: `.phew/memory.md`, facts about the code, which a team can keep in Git;
 * - personal: `~/.phew/memory.md`, your preferences for every project.
 * A note may name the file it comes from and the day it was saved, so Phew can tell the agent when that file
 * changed later and the note needs a check.
 */

export const maximumMemoryNotes = 100;
export const maximumNoteLength = 300;

export type MemoryScope = "project" | "personal";

export interface MemoryNote {
  readonly text: string;
  /** The file that the fact comes from, relative to the workspace. */
  readonly source?: string;
  /** The day the note was saved, YYYY-MM-DD. */
  readonly added?: string;
}

const metaPattern = /\s*<!--\s*(.*?)\s*-->\s*$/;

/** Reads the notes of a memory file. Each note is a Markdown list item, with its source and day in a comment. */
export function parseNotes(text: string): MemoryNote[] {
  const notes: MemoryNote[] = [];
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim();
    if (!item) continue;
    const meta = metaPattern.exec(item);
    const body = (meta ? item.slice(0, meta.index) : item).trim();
    if (!body) continue;
    const fields = Object.fromEntries(
      (meta?.[1] ?? "")
        .split(";")
        .map((part) => part.split(":").map((value) => value.trim()))
        .filter((pair) => pair.length >= 2 && pair[0])
        .map(([key, ...rest]) => [key, rest.join(":")]),
    ) as Record<string, string>;
    notes.push({
      text: body,
      ...(fields.source ? { source: fields.source } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(fields.added ?? "") ? { added: fields.added } : {}),
    });
  }
  return notes;
}

/** The texts of the notes, for older callers. */
export function parseMemory(text: string): string[] {
  return parseNotes(text).map((note) => note.text);
}

/** Cleans a note: one line, no secrets, limited length. Returns undefined for an empty note. */
export function cleanNote(note: string): string | undefined {
  const line = redactSecrets(
    note
      .replace(/\s+/g, " ")
      .replace(/<!--|-->/g, "")
      .trim(),
  ).text;
  if (!line) return undefined;
  return line.length > maximumNoteLength ? `${line.slice(0, maximumNoteLength - 1)}…` : line;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Finds a note by its text: the same text, or the one note that contains the given words. */
export function findNote(notes: readonly MemoryNote[], text: string): number {
  const exact = notes.findIndex((note) => same(note.text, text));
  if (exact >= 0) return exact;
  const needle = text.trim().toLowerCase();
  if (needle.length < 4) return -1;
  const matches = notes.flatMap((note, index) => (note.text.toLowerCase().includes(needle) ? [index] : []));
  return matches.length === 1 ? (matches[0] ?? -1) : -1;
}

/**
 * Adds a note, or replaces an older one, and returns the new file content. A duplicate is skipped, and the
 * oldest notes go at the limit.
 */
export function addNote(
  text: string,
  note: string,
  options: { source?: string; added?: string; replaces?: string; scope?: MemoryScope } = {},
): { content: string; added: boolean; replaced: boolean } {
  const clean = cleanNote(note);
  const notes = parseNotes(text);
  const scope = options.scope ?? "project";
  if (!clean) return { content: renderMemory(notes, scope), added: false, replaced: false };
  const entry: MemoryNote = {
    text: clean,
    ...(options.source ? { source: options.source.replace(/[;<>]/g, "").slice(0, 200) } : {}),
    ...(options.added ? { added: options.added } : {}),
  };
  const old = options.replaces ? findNote(notes, options.replaces) : -1;
  if (old >= 0) {
    notes[old] = entry;
    return { content: renderMemory(notes, scope), added: true, replaced: true };
  }
  const duplicate = notes.findIndex((item) => same(item.text, clean));
  if (duplicate >= 0) {
    // Saving a known fact again confirms it: it gets the new source and day.
    notes[duplicate] = entry;
    return { content: renderMemory(notes, scope), added: false, replaced: false };
  }
  notes.push(entry);
  return { content: renderMemory(notes.slice(-maximumMemoryNotes), scope), added: true, replaced: false };
}

/** Removes a note and returns the new content, or undefined when no note matches. */
export function forgetNote(text: string, note: string, scope: MemoryScope = "project"): string | undefined {
  const notes = parseNotes(text);
  const index = findNote(notes, note);
  if (index < 0) return undefined;
  notes.splice(index, 1);
  return renderMemory(notes, scope);
}

export function renderMemory(notes: readonly (MemoryNote | string)[], scope: MemoryScope = "project"): string {
  const header =
    scope === "personal"
      ? [
          "# Phew personal memory",
          "",
          "Your preferences for every project. Phew reads them in every chat. Edit or delete them at any time.",
        ]
      : [
          "# Phew project memory",
          "",
          "Durable facts about this project. Phew reads them in every chat. Edit or delete them at any time.",
        ];
  const line = (note: MemoryNote | string) => {
    if (typeof note === "string") return `- ${note}`;
    const meta = [note.source ? `source: ${note.source}` : "", note.added ? `added: ${note.added}` : ""]
      .filter(Boolean)
      .join("; ");
    return `- ${note.text}${meta ? ` <!-- ${meta} -->` : ""}`;
  };
  return [...header, "", ...notes.map(line), ""].join("\n");
}

/** The state of the source of a note, which the host checks before a chat. */
export type SourceState = "unchanged" | "changed" | "missing";

/** The memory part of the system prompt. */
export function memoryPrompt(
  project: readonly (MemoryNote & { state?: SourceState })[],
  personal: readonly MemoryNote[],
): string {
  const sections: string[] = [];
  if (personal.length > 0)
    sections.push(
      `Personal preferences of the user, for every project:\n${personal.map((note) => `- ${note.text}`).join("\n")}`,
    );
  if (project.length > 0) {
    const lines = project.map((note) => {
      const from = note.source ? ` (from ${note.source})` : "";
      if (note.state === "changed") return `- ${note.text}${from}. ${note.source} changed after this note: check it.`;
      if (note.state === "missing") return `- ${note.text}${from}. ${note.source} no longer exists: check it.`;
      return `- ${note.text}${from}`;
    });
    sections.push(`Project memory, facts saved in earlier chats:\n${lines.join("\n")}`);
  }
  if (sections.length === 0) return "";
  return [
    ...sections,
    "Use remember to save a new durable fact or preference (with replaces to correct an old one), and forget to remove one that is wrong.",
  ].join("\n\n");
}

/** The request of /learn: lessons from this chat, saved only after the user chooses them. */
export function learnRequest(focus: string): string {
  return [
    "Look back at this chat and find what is worth keeping for future chats:",
    "corrections I made, preferences I stated, facts about the project that you had to find out, and steps that finally worked after something failed.",
    focus ? `Focus on: ${focus}` : "",
    "",
    "For each lesson, choose where it belongs:",
    "- project memory: a fact about this code, such as a command, a convention, or a pitfall;",
    "- personal memory: how I like to work, in every project;",
    "- AGENTS.md or a rule file: a rule that the whole team should follow.",
    "",
    "Propose at most five short lessons, each with its place. Do not save anything yet.",
    "Ask me with ask_user which ones to save. Then save the chosen ones: with remember for memory (scope project or personal, and the source file when there is one), or by editing AGENTS.md for team rules.",
    "If the chat has nothing worth keeping, say so and stop.",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}
