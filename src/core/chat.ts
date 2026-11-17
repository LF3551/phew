import type { Usage } from "./cost";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Arguments as a JSON string, exactly as the model produced them. */
  readonly arguments: string;
}

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

/** A tool in the JSON Schema format that OpenAI-compatible APIs use. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly signal: AbortSignal;
}

export interface CompletionResult {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: Usage;
  readonly finishReason?: string;
}

/** A chat model that supports tool calls. */
export interface ModelClient {
  complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult>;
}

/** Parses tool arguments. Invalid JSON produces an error that the model can read and correct. */
export function parseArguments(call: ToolCall): Record<string, unknown> {
  if (call.arguments.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new Error(`The arguments of ${call.name} are not valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The arguments of ${call.name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function stringArgument(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`The argument "${name}" is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`The argument "${name}" must be a string.`);
  return value;
}

export function numberArgument(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`The argument "${name}" must be a number.`);
  return value;
}

/** Shortens long text and keeps the start and the end, where errors usually are. */
export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 40) / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters omitted …]\n${text.slice(-half)}`;
}

function messageSize(message: ChatMessage): number {
  const calls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
  return message.content.length + calls.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0);
}

/**
 * Removes the oldest messages until the history fits the character budget.
 * The result always starts with a user message, so tool results keep their tool calls.
 */
export function trimHistory(history: readonly ChatMessage[], maximumCharacters: number): ChatMessage[] {
  let total = history.reduce((sum, message) => sum + messageSize(message), 0);
  let start = 0;
  while (total > maximumCharacters && start < history.length - 1) {
    total -= messageSize(history[start]);
    start++;
    while (start < history.length - 1 && history[start].role !== "user") {
      total -= messageSize(history[start]);
      start++;
    }
  }
  return history.slice(start);
}
