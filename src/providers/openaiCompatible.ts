import type { ChatMessage, CompletionRequest, CompletionResult, ModelClient, ToolCall } from "../core/chat";
import { type FetchFunction, httpError, networkError, postJson, readSse } from "./http";
import { endpoint, type ModelProfile, requestHeaders } from "./profile";

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

export function newStreamState(): StreamState {
  return { content: "", calls: new Map() };
}

/** Applies one streamed chunk to the state. */
export function applyChunk(state: StreamState, chunk: unknown, onText: (delta: string) => void): void {
  if (typeof chunk !== "object" || chunk === null) return;
  const data = chunk as {
    choices?: { delta?: Record<string, unknown>; message?: Record<string, unknown>; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
    error?: { message?: unknown } | string;
  };
  if (data.error) {
    const message = typeof data.error === "string" ? data.error : String(data.error.message ?? "unknown error");
    throw new Error(`The model returned an error: ${message}`);
  }
  if (data.usage && typeof data.usage.prompt_tokens === "number") {
    state.usage = {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: typeof data.usage.completion_tokens === "number" ? data.usage.completion_tokens : 0,
    };
  }
  for (const choice of data.choices ?? []) {
    if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      state.content += delta.content;
      onText(delta.content);
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    toolCalls.forEach((raw, position) => {
      const item = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const index = typeof item.index === "number" ? item.index : position;
      const call = state.calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.id === "string" && item.id) call.id = item.id;
      if (typeof item.function?.name === "string") call.name += item.function.name;
      if (typeof item.function?.arguments === "string") call.arguments += item.function.arguments;
      else if (typeof item.function?.arguments === "object" && item.function.arguments !== null) {
        call.arguments = JSON.stringify(item.function.arguments);
      }
      state.calls.set(index, call);
    });
  }
}

export function finishState(state: StreamState): CompletionResult {
  const toolCalls: ToolCall[] = [...state.calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name.length > 0)
    .map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: call.arguments }));
  return { content: state.content, toolCalls, usage: state.usage, finishReason: state.finishReason };
}

/** A client for the OpenAI Chat Completions format with streaming and tools. Many providers implement it. */
export class OpenAiCompatibleClient implements ModelClient {
  private sendUsageOption = true;

  constructor(
    private readonly profile: ModelProfile,
    private readonly apiKey: string | undefined,
    private readonly fetchFunction: FetchFunction = fetch,
  ) {}

  async complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
    const response = await this.post(request);
    const state = newStreamState();
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      // Some servers ignore `stream` and return one JSON object.
      applyChunk(state, await response.json(), onText);
    } else await readSse(response, (data) => applyChunk(state, data, onText));
    return finishState(state);
  }

  /** Builds the request body. Exported for tests through the class. */
  body(request: CompletionRequest, withUsage: boolean): Record<string, unknown> {
    const { profile } = this;
    const officialOpenAi = /(^|\.)api\.openai\.com$/.test(safeHost(profile.baseUrl));
    return {
      model: profile.model,
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
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      ...(profile.maxTokens !== undefined
        ? officialOpenAi
          ? { max_completion_tokens: profile.maxTokens }
          : { max_tokens: profile.maxTokens }
        : {}),
      ...profile.extraBody,
    };
  }

  private async post(request: CompletionRequest): Promise<Response> {
    const url = endpoint(this.profile.baseUrl, "chat/completions", this.profile.query);
    const headers = { ...requestHeaders(this.profile, this.apiKey), Accept: "text/event-stream" };
    const name = this.profile.name;
    if (!this.sendUsageOption)
      return postJson(this.fetchFunction, name, url, headers, this.body(request, false), request.signal);

    let response: Response;
    try {
      response = await this.fetchFunction(url, {
        method: "POST",
        headers,
        body: JSON.stringify(this.body(request, true)),
        signal: request.signal,
      });
    } catch (error) {
      throw networkError(name, url, error);
    }
    if (response.ok) return response;
    const text = await response.text();
    if ((response.status === 400 || response.status === 422) && /stream_options|include_usage/i.test(text)) {
      this.sendUsageOption = false;
      return postJson(this.fetchFunction, name, url, headers, this.body(request, false), request.signal);
    }
    throw httpError(name, response.status, text);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
