import type { ChatMessage, ToolCall } from "./chat";

/**
 * Old tool outputs leave the context. A file read at step 3 or the log of a build at step 5 is sent to the model
 * again at every later step, until the context is full. Phew replaces large outputs older than the last few steps
 * with a short note that says what it was, so the agent can run the tool again when it needs it.
 *
 * It works in batches: only when enough old output has piled up, and then all at once. The start of the
 * conversation then changes once instead of at every step, so the prompt cache of the provider keeps working.
 */

export interface PruneOptions {
  /** The latest steps (assistant turns with tool calls) keep all their outputs. */
  readonly keepSteps: number;
  /** Smaller outputs stay: they cost little, and a note would save nothing. */
  readonly minChars: number;
  /** Prune only when the old outputs together are at least this long. */
  readonly triggerChars: number;
}

export const defaultPruneOptions: PruneOptions = { keepSteps: 4, minChars: 1500, triggerChars: 40_000 };

/** Tools whose output the agent needs for the whole task: answers of the user, skills, the plan, memory, reports. */
const keptTools: ReadonlySet<string> = new Set([
  "ask_user",
  "load_skill",
  "read_skill_file",
  "update_plan",
  "remember",
  "forget",
  "delegate",
]);

const removedMark = "[Removed to save context:";

/** What a tool call was about, in a few words: "read_file src/app.ts" or "run_command npm test". */
function callLabel(call: ToolCall | undefined): string {
  if (!call) return "a tool";
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments || "{}") as unknown;
    if (typeof parsed === "object" && parsed !== null) args = parsed as Record<string, unknown>;
  } catch {
    // The name is enough.
  }
  const value = args.path ?? args.command ?? args.query ?? args.pattern ?? args.terminal;
  const detail = typeof value === "string" ? ` ${value.split("\n")[0]?.slice(0, 80)}` : "";
  return `${call.name}${detail}`;
}

export function pruneStaleToolResults(
  history: readonly ChatMessage[],
  options: PruneOptions = defaultPruneOptions,
): { history: ChatMessage[]; removed: number; savedChars: number } {
  // The first message of the steps that keep everything.
  const steps = history
    .map((message, index) => (message.role === "assistant" && message.toolCalls?.length ? index : -1))
    .filter((index) => index >= 0);
  const boundary = steps.length > options.keepSteps ? (steps[steps.length - options.keepSteps] as number) : 0;
  if (boundary === 0) return { history: [...history], removed: 0, savedChars: 0 };

  const calls = new Map<string, ToolCall>();
  for (const message of history.slice(0, boundary))
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) calls.set(call.id, call);

  const candidates = history
    .slice(0, boundary)
    .map((message, index) => ({ message, index }))
    .filter(
      (item): item is { message: Extract<ChatMessage, { role: "tool" }>; index: number } =>
        item.message.role === "tool" &&
        item.message.content.length >= options.minChars &&
        !item.message.content.startsWith(removedMark) &&
        !keptTools.has(calls.get(item.message.toolCallId)?.name ?? ""),
    );
  const stale = candidates.reduce((sum, item) => sum + item.message.content.length, 0);
  if (stale < options.triggerChars) return { history: [...history], removed: 0, savedChars: 0 };

  const next = [...history];
  let savedChars = 0;
  for (const { message, index } of candidates) {
    const note = `${removedMark} the output of ${callLabel(calls.get(message.toolCallId))} (${message.content.length.toLocaleString("en-US")} characters). Run it again if you need it.]`;
    savedChars += message.content.length - note.length;
    next[index] = { ...message, content: note };
  }
  return { history: next, removed: candidates.length, savedChars };
}
