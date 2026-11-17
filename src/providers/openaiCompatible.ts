import type { ChatMessage, CompletionRequest, CompletionResult, ModelClient, ToolCall } from "../core/chat";
import { redactSecrets } from "../core/secrets";
import { SseParser } from "../core/sse";

export interface OpenAiCompatibleOptions {
  /** Base URL that ends before `/chat/completions`, for example `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly temperature?: number;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

type ApiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export function toApiMessages(messages: readonly ChatMessage[]): ApiMessage[] {
  return messages.map((message): ApiMessage => {
    switch (message.role) {
      case "assistant":
        return {
          role: "assistant",
          content: message.content.length > 0 ? message.content : null,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments || "{}" },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      default:
        return { role: message.role, content: message.content };
    }
  });
}

interface StreamState {
  content: string;
  calls: Map<number, { id: string; name: string; arguments: string }>;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
}

/** Applies one streamed chunk to the state. Exported for tests. */
export function applyChunk(state: StreamState, chunk: unknown, onText: (delta: string) => void): void {
  if (typeof chunk !== "object" || chunk === null) return;
  const data = chunk as {
    choices?: { delta?: Record<string, unknown>; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
    error?: { message?: unknown };
  };
  if (data.error) throw new Error(`The model returned an error: ${String(data.error.message ?? "unknown error")}`);
  if (data.usage && typeof data.usage.prompt_tokens === "number") {
    state.usage = {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: typeof data.usage.completion_tokens === "number" ? data.usage.completion_tokens : 0,
    };
  }
  for (const choice of data.choices ?? []) {
    if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      state.content += delta.content;
      onText(delta.content);
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const raw of toolCalls) {
      const item = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const index = typeof item.index === "number" ? item.index : state.calls.size;
      const call = state.calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.id === "string" && item.id) call.id = item.id;
      if (typeof item.function?.name === "string") call.name += item.function.name;
      if (typeof item.function?.arguments === "string") call.arguments += item.function.arguments;
      state.calls.set(index, call);
    }
  }
}

export function finishState(state: StreamState): CompletionResult {
  const toolCalls: ToolCall[] = [...state.calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name.length > 0)
    .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: call.arguments }));
  return { content: state.content, toolCalls, usage: state.usage, finishReason: state.finishReason };
}

/** A client for any API that implements the OpenAI chat completions format with streaming and tools. */
export class OpenAiCompatibleClient implements ModelClient {
  private sendUsageOption = true;

  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
    const response = await this.post(request);
    if (!response.body) throw new Error("The model response has no body.");
    const state: StreamState = { content: "", calls: new Map() };
    let failure: Error | undefined;
    const parser = new SseParser((data) => {
      if (failure || data.trim() === "[DONE]") return;
      try {
        applyChunk(state, JSON.parse(data), onText);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        if (failure) throw failure;
      }
      parser.push(decoder.decode());
      parser.flush();
    } finally {
      reader.releaseLock();
    }
    if (failure) throw failure;
    return finishState(state);
  }

  private async post(request: CompletionRequest): Promise<Response> {
    const fetchFunction = this.options.fetch ?? fetch;
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const send = (withUsage: boolean) =>
      fetchFunction(url, {
        method: "POST",
        signal: request.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.extraHeaders,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: toApiMessages(request.messages),
          stream: true,
          ...(withUsage ? { stream_options: { include_usage: true } } : {}),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
              }
            : {}),
          ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
        }),
      });

    let response = await send(this.sendUsageOption);
    if (response.status === 400 && this.sendUsageOption) {
      const body = await response.text();
      if (/stream_options|include_usage/i.test(body)) {
        this.sendUsageOption = false;
        response = await send(false);
      } else throw httpError(response.status, body);
    }
    if (!response.ok) throw httpError(response.status, await response.text());
    return response;
  }
}

function httpError(status: number, body: string): Error {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (typeof parsed.error?.message === "string") message = parsed.error.message;
    else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Keep the raw body.
  }
  const hint =
    status === 401 || status === 403
      ? " Check the API key with the Phew: Configure Model command."
      : status === 404
        ? " Check the base URL and the model name."
        : status === 429
          ? " The provider rate limit or quota is reached."
          : "";
  return new Error(`The model request failed with HTTP ${status}: ${redactSecrets(message).text.slice(0, 500)}${hint}`);
}
