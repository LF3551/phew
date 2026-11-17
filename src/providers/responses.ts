import type { ChatMessage, CompletionRequest, CompletionResult, ModelClient, ToolCall } from "../core/chat";
import { type FetchFunction, postJson, readSse } from "./http";
import { endpoint, type ModelProfile, requestHeaders } from "./profile";

type InputItem =
  | { role: "system" | "developer" | "user" | "assistant"; content: ContentPart[] | string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

/** Converts the conversation to the input items of the OpenAI Responses API. */
export function toResponsesInput(messages: readonly ChatMessage[]): { instructions: string; input: InputItem[] } {
  const instructions: string[] = [];
  const input: InputItem[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        instructions.push(message.content);
        break;
      case "user":
        input.push({
          role: "user",
          content: [
            { type: "input_text", text: message.content || " " },
            ...(message.images ?? []).map(
              (image): ContentPart => ({
                type: "input_image",
                image_url: `data:${image.mimeType};base64,${image.data}`,
              }),
            ),
          ],
        });
        break;
      case "assistant":
        if (message.content.trim())
          input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
        for (const call of message.toolCalls ?? []) {
          input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments || "{}" });
        }
        break;
      case "tool":
        input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content || "(empty)" });
        break;
    }
  }
  return { instructions: instructions.join("\n\n"), input };
}

interface ResponsesState {
  content: string;
  reasoning: string;
  calls: Map<string, { id: string; callId: string; name: string; arguments: string; order: number }>;
  usage?: { inputTokens: number; outputTokens: number };
  status?: string;
}

export function newResponsesState(): ResponsesState {
  return { content: "", reasoning: "", calls: new Map() };
}

interface ResponsesEvent {
  type?: string;
  delta?: unknown;
  item_id?: unknown;
  output_index?: unknown;
  item?: { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
  response?: {
    status?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
    error?: { message?: unknown } | null;
  };
  error?: { message?: unknown } | null;
  message?: unknown;
}

/** Applies one streamed event of the Responses API. */
export function applyResponsesEvent(
  state: ResponsesState,
  event: unknown,
  onText: (delta: string) => void,
  onReasoning?: (delta: string) => void,
): void {
  if (typeof event !== "object" || event === null) return;
  const data = event as ResponsesEvent;
  switch (data.type) {
    case "response.output_text.delta":
      if (typeof data.delta === "string") {
        state.content += data.delta;
        onText(data.delta);
      }
      break;
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      if (typeof data.delta === "string") {
        state.reasoning += data.delta;
        onReasoning?.(data.delta);
      }
      break;
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = data.item;
      if (item?.type !== "function_call") break;
      const id = String(item.id ?? item.call_id ?? state.calls.size);
      const existing = state.calls.get(id);
      state.calls.set(id, {
        id,
        callId: String(item.call_id ?? existing?.callId ?? id),
        name: String(item.name ?? existing?.name ?? ""),
        arguments: typeof item.arguments === "string" && item.arguments ? item.arguments : (existing?.arguments ?? ""),
        order: existing?.order ?? Number(data.output_index ?? state.calls.size),
      });
      break;
    }
    case "response.function_call_arguments.delta": {
      const id = String(data.item_id ?? "");
      const call = state.calls.get(id);
      if (call && typeof data.delta === "string") call.arguments += data.delta;
      break;
    }
    case "response.completed":
    case "response.incomplete": {
      state.status = String(data.response?.status ?? "");
      const usage = data.response?.usage;
      if (usage && typeof usage.input_tokens === "number") {
        state.usage = { inputTokens: usage.input_tokens, outputTokens: Number(usage.output_tokens) || 0 };
      }
      break;
    }
    case "response.failed":
    case "error": {
      const message = data.response?.error?.message ?? data.error?.message ?? data.message ?? "unknown error";
      throw new Error(`The model returned an error: ${String(message)}`);
    }
  }
}

export function finishResponses(state: ResponsesState): CompletionResult {
  const toolCalls: ToolCall[] = [...state.calls.values()]
    .sort((a, b) => a.order - b.order)
    .filter((call) => call.name)
    .map((call) => ({ id: call.callId, name: call.name, arguments: call.arguments || "{}" }));
  return {
    content: state.content,
    toolCalls,
    usage: state.usage,
    finishReason: state.status,
    ...(state.reasoning ? { reasoning: { text: state.reasoning } } : {}),
  };
}

/** A client for the OpenAI Responses API (`/responses`), which newer OpenAI models and GitHub Copilot use. */
export class ResponsesClient implements ModelClient {
  constructor(
    private readonly profile: ModelProfile,
    private readonly apiKey: string | undefined,
    private readonly fetchFunction: FetchFunction = fetch,
    private readonly retries = 0,
  ) {}

  body(request: CompletionRequest): Record<string, unknown> {
    const { instructions, input } = toResponsesInput(request.messages);
    return {
      model: this.profile.model,
      input,
      ...(instructions ? { instructions } : {}),
      stream: true,
      store: false,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
      ...(this.profile.temperature !== undefined ? { temperature: this.profile.temperature } : {}),
      ...(this.profile.maxTokens !== undefined ? { max_output_tokens: this.profile.maxTokens } : {}),
      ...this.profile.extraBody,
    };
  }

  async complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
    const response = await postJson(
      this.fetchFunction,
      this.profile.name,
      endpoint(this.profile.baseUrl, "responses", this.profile.query),
      { ...requestHeaders(this.profile, this.apiKey), Accept: "text/event-stream" },
      this.body(request),
      request.signal,
      { retries: this.retries, onRetry: request.onRetry },
    );
    const state = newResponsesState();
    await readSse(response, (event) => applyResponsesEvent(state, event, onText, request.onReasoning));
    return finishResponses(state);
  }
}
