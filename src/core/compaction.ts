import type { ChatMessage } from "./chat";

/** Rough token estimate: about four characters per token for code and English text. */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let characters = 0;
  for (const message of messages) {
    characters += message.content.length;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) characters += call.name.length + call.arguments.length;
    }
    if (message.role === "user") characters += (message.images?.length ?? 0) * 3000;
  }
  return Math.ceil(characters / 4);
}

/** The share of the context window that the last request used, from 0 to 1. */
export function contextUsage(inputTokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.min(1, Math.max(0, inputTokens / contextWindow));
}

/**
 * Splits the history for compaction. The recent part keeps at least `keepRecent` user turns and starts with a
 * user message, so tool results always stay next to their tool calls. Returns undefined when nothing can be compacted.
 */
export function splitForCompaction(
  history: readonly ChatMessage[],
  keepRecent = 2,
): { older: ChatMessage[]; recent: ChatMessage[] } | undefined {
  const userIndexes = history.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (userIndexes.length <= keepRecent) return undefined;
  const cut = userIndexes[userIndexes.length - keepRecent];
  if (cut <= 0) return undefined;
  return { older: history.slice(0, cut), recent: history.slice(cut) };
}

const maximumTranscriptForSummary = 120_000;

/** The request that asks the model to summarize the older part of a conversation. */
export function buildCompactionMessages(older: readonly ChatMessage[]): ChatMessage[] {
  const lines: string[] = [];
  for (const message of older) {
    if (message.role === "user") lines.push(`USER: ${message.content}`);
    else if (message.role === "assistant") {
      if (message.content.trim()) lines.push(`ASSISTANT: ${message.content}`);
      for (const call of message.toolCalls ?? []) lines.push(`TOOL CALL ${call.name}: ${call.arguments.slice(0, 300)}`);
    } else if (message.role === "tool") lines.push(`TOOL RESULT: ${message.content.slice(0, 800)}`);
  }
  let transcript = lines.join("\n");
  if (transcript.length > maximumTranscriptForSummary) {
    transcript = `[Earlier part omitted]\n${transcript.slice(-maximumTranscriptForSummary)}`;
  }
  return [
    {
      role: "system",
      content: [
        "You summarize a coding conversation so that the work can continue with less context.",
        "Keep: the goal, decisions, constraints from the user, files that were read or changed with the important details, commands and their results, open problems, and the next steps.",
        "Drop: greetings, repeated content, and full file contents.",
        "Write concise Markdown with headings. Do not invent details.",
      ].join("\n"),
    },
    { role: "user", content: `Summarize this conversation:\n\n${transcript}` },
  ];
}

/** Replaces the older part of the history with a summary. */
export function applyCompaction(recent: readonly ChatMessage[], summary: string): ChatMessage[] {
  return [
    {
      role: "user",
      content: `Summary of the earlier conversation, made to save context:\n\n${summary.trim()}\n\nContinue from here.`,
    },
    { role: "assistant", content: "Understood. I will continue from this summary." },
    ...recent,
  ];
}
