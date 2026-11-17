import type { ChatMessage } from "./chat";

export interface CompletionContext {
  readonly path: string;
  readonly language: string;
  readonly prefix: string;
  readonly suffix: string;
}

const maxPrefix = 6000;
const maxSuffix = 2000;

/** Builds the messages for an inline completion with a chat model. */
export function buildCompletionMessages(context: CompletionContext): ChatMessage[] {
  const prefix = context.prefix.slice(-maxPrefix);
  const suffix = context.suffix.slice(0, maxSuffix);
  return [
    {
      role: "system",
      content: [
        "You are a code completion engine.",
        "Return only the code that belongs at <CURSOR>. Do not repeat code before or after the cursor.",
        "Do not explain. Do not use code fences. Return an empty answer when nothing fits.",
        "Prefer short completions: finish the current line or the current block.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `File: ${context.path} (${context.language})\n\n${prefix}<CURSOR>${suffix}`,
    },
  ];
}

/** Cleans a completion: removes fences and text that repeats the prefix or the suffix, and limits the lines. */
export function cleanCompletion(raw: string, context: CompletionContext, maxLines: number): string {
  let text = raw.replace(/\r\n/g, "\n");
  const fenced = /^\s*```[\w+#.-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) text = fenced[1];
  text = text.replace(/<CURSOR>/g, "");
  const currentLine = context.prefix.slice(context.prefix.lastIndexOf("\n") + 1);
  if (currentLine.trim() && text.startsWith(currentLine)) text = text.slice(currentLine.length);
  const nextLine = context.suffix.split("\n")[0];
  if (nextLine.trim()) {
    const index = text.indexOf(nextLine.trim());
    if (index > 0 && text.slice(index).trim() === nextLine.trim()) text = text.slice(0, index);
  }
  const suffixStart = context.suffix.trimStart().slice(0, 40);
  if (suffixStart.length >= 8) {
    const overlap = text.indexOf(suffixStart);
    if (overlap > 0) text = text.slice(0, overlap);
  }
  const lines = text.split("\n");
  if (lines.length > maxLines) text = lines.slice(0, maxLines).join("\n");
  return text.trim().length === 0 ? "" : text.replace(/\s+$/, "");
}

export interface RecentEdit {
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

export interface NextEditContext {
  readonly path: string;
  readonly language: string;
  /** Lines of the visible window, with their first line number (1-based). */
  readonly windowStart: number;
  readonly windowLines: readonly string[];
  readonly cursorLine: number;
  readonly recentEdits: readonly RecentEdit[];
}

export interface NextEdit {
  /** First line to replace, 1-based. */
  readonly startLine: number;
  /** Last line to replace, inclusive. `endLine = startLine - 1` inserts before `startLine`. */
  readonly endLine: number;
  readonly replacement: string;
}

/** Builds the messages that predict the next edit from the recent edits. */
export function buildNextEditMessages(context: NextEditContext): ChatMessage[] {
  const window = context.windowLines.map((line, index) => `${context.windowStart + index}| ${line}`).join("\n");
  const edits = context.recentEdits
    .slice(-8)
    .map((edit) => `Line ${edit.line}:\n- ${edit.before.slice(0, 300)}\n+ ${edit.after.slice(0, 300)}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content: [
        "You predict the next edit that a developer will make, based on the edits that they just made.",
        "Typical next edits: the same rename in other places, a matching change in a related line, a missing import, or an updated call site.",
        'Answer with one JSON object: {"startLine": number, "endLine": number, "replacement": string}.',
        "startLine and endLine are the 1-based lines to replace, inclusive. replacement is the new text of those lines.",
        'If no edit is likely, answer {"none": true}. Do not explain.',
      ].join("\n"),
    },
    {
      role: "user",
      content: `File: ${context.path} (${context.language}). Cursor at line ${context.cursorLine}.\n\nRecent edits:\n${edits || "(none)"}\n\nCode:\n${window}`,
    },
  ];
}

/** Parses the predicted edit. Returns undefined for "none" or invalid answers. */
export function parseNextEdit(raw: string, lineCount: number): NextEdit | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  const value = data as { none?: unknown; startLine?: unknown; endLine?: unknown; replacement?: unknown };
  if (value.none === true) return undefined;
  const startLine = Number(value.startLine);
  const endLine = Number(value.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || typeof value.replacement !== "string")
    return undefined;
  if (startLine < 1 || startLine > lineCount + 1 || endLine < startLine - 1 || endLine > lineCount) return undefined;
  return { startLine, endLine, replacement: value.replacement };
}
