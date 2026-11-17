import { redactSecrets } from "./secrets";

export const maximumMemoryNotes = 100;
export const maximumNoteLength = 300;

/** Reads the notes of a memory file. Each note is a Markdown list item. */
export function parseMemory(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

/** Cleans a note: one line, no secrets, limited length. Returns undefined for an empty note. */
export function cleanNote(note: string): string | undefined {
  const line = redactSecrets(note.replace(/\s+/g, " ").trim()).text;
  if (!line) return undefined;
  return line.length > maximumNoteLength ? `${line.slice(0, maximumNoteLength - 1)}…` : line;
}

/** Adds a note and returns the new file content. Duplicates are skipped and old notes are removed at the limit. */
export function addNote(text: string, note: string): { content: string; added: boolean } {
  const clean = cleanNote(note);
  const notes = parseMemory(text);
  if (!clean || notes.some((item) => item.toLowerCase() === clean.toLowerCase())) {
    return { content: renderMemory(notes), added: false };
  }
  notes.push(clean);
  return { content: renderMemory(notes.slice(-maximumMemoryNotes)), added: true };
}

export function renderMemory(notes: readonly string[]): string {
  return [
    "# Phew project memory",
    "",
    "Durable facts about this project. Phew reads them in every chat. Edit or delete them at any time.",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
  ].join("\n");
}
