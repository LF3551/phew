import type { ChatMessage, CompletionRequest, CompletionResult, ModelClient, ToolCall } from "../core/chat";
import { argumentsObject, type FetchFunction, postJson, readSse } from "./http";
import { endpoint, type ModelProfile, requestHeaders } from "./profile";

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

export const anthropicVersion = "2023-06-01";
export const defaultAnthropicMaxTokens = 8192;

/**
 * Converts the conversation to the Anthropic Messages format.
 * The system prompt is separate, tool results are user content blocks, and roles must alternate.
 */
export function toAnthropic(messages: readonly ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const result: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = result.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else result.push({ role, content: blocks });
  };
  for (const message of messages) {
    switch (message.role) {
      case "system":
        system.push(message.content);
        break;
      case "user":
        push("user", [
          ...(message.images ?? []).map(
            (image): Block => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data },
            }),
          ),
          { type: "text", text: message.content || " " },
        ]);
        break;
      case "tool":
        push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content || "(empty)" }]);
        break;
      case "assistant": {
        const blocks: Block[] = [];
        // Extended thinking with tools needs the signed thinking blocks of the previous turn.
        if (message.reasoning?.signature) {
          blocks.push({ type: "thinking", thinking: message.reasoning.text, signature: message.reasoning.signature });
        }
        for (const data of message.reasoning?.redacted ?? []) blocks.push({ type: "redacted_thinking", data });
        if (message.content.trim()) blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: argumentsObject(call.arguments) });
        }
        push("assistant", blocks.length > 0 ? blocks : [{ type: "text", text: "(no answer)" }]);
        break;
      }
    }
  }
  // The conversation must start with a user message.
  if (result[0]?.role === "assistant") result.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });
  return { system: system.join("\n\n"), messages: result };
}

interface AnthropicState {
  content: string;
  thinking: string;
  signature: string;
  redacted: string[];
  blocks: Map<number, { id: string; name: string; json: string }>;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
}

export function newAnthropicState(): AnthropicState {
  return { content: "", thinking: "", signature: "", redacted: [], blocks: new Map(), inputTokens: 0, outputTokens: 0 };
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: Record<string, unknown> };
  content_block?: { type?: string; id?: unknown; name?: unknown; text?: unknown; data?: unknown };
  delta?: {
    type?: string;
    text?: unknown;
    partial_json?: unknown;
    stop_reason?: unknown;
    thinking?: unknown;
    signature?: unknown;
  };
  usage?: { output_tokens?: unknown };
  error?: { message?: unknown };
}

/** Applies one streamed Anthropic event. */
export function applyAnthropicEvent(
  state: AnthropicState,
  event: unknown,
  onText: (delta: string) => void,
  onReasoning?: (delta: string) => void,
): void {
  if (typeof event !== "object" || event === null) return;
  const data = event as AnthropicEvent;
  switch (data.type) {
    case "message_start": {
      const usage = data.message?.usage ?? {};
      state.inputTokens =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0);
      state.outputTokens = Number(usage.output_tokens) || 0;
      break;
    }
    case "content_block_start": {
      const block = data.content_block ?? {};
      if (block.type === "tool_use") {
        state.blocks.set(Number(data.index), { id: String(block.id ?? ""), name: String(block.name ?? ""), json: "" });
      } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
        state.redacted.push(block.data);
      } else if (block.type === "text" && typeof block.text === "string" && block.text) {
        state.content += block.text;
        onText(block.text);
      }
      break;
    }
    case "content_block_delta": {
      const delta = data.delta ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        state.content += delta.text;
        onText(delta.text);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        state.thinking += delta.thinking;
        onReasoning?.(delta.thinking);
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        state.signature += delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = state.blocks.get(Number(data.index));
        if (block) block.json += delta.partial_json;
      }
      break;
    }
    case "message_delta":
      if (typeof data.delta?.stop_reason === "string") state.stopReason = data.delta.stop_reason;
      if (data.usage?.output_tokens !== undefined) state.outputTokens = Number(data.usage.output_tokens) || 0;
      break;
    case "error":
      throw new Error(`Anthropic returned an error: ${String(data.error?.message ?? "unknown error")}`);
  }
}

export function finishAnthropic(state: AnthropicState): CompletionResult {
  const toolCalls: ToolCall[] = [...state.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => ({ id: block.id, name: block.name, arguments: block.json || "{}" }));
  const reasoning =
    state.thinking || state.redacted.length > 0
      ? {
          text: state.thinking,
          ...(state.signature ? { signature: state.signature } : {}),
          ...(state.redacted.length > 0 ? { redacted: state.redacted } : {}),
        }
      : undefined;
  return {
    content: state.content,
    toolCalls,
    usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
    finishReason: state.stopReason,
    ...(reasoning ? { reasoning } : {}),
  };
}

/** A client for the native Anthropic Messages API. */
export class AnthropicClient implements ModelClient {
  constructor(
    private readonly profile: ModelProfile,
    private readonly apiKey: string | undefined,
    private readonly fetchFunction: FetchFunction = fetch,
    private readonly retries = 0,
  ) {}

  body(request: CompletionRequest): Record<string, unknown> {
    const { system, messages } = toAnthropic(request.messages);
    return {
      model: this.profile.model,
      max_tokens: this.profile.maxTokens ?? defaultAnthropicMaxTokens,
      stream: true,
      ...(system ? { system } : {}),
      messages,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      ...(this.profile.temperature !== undefined ? { temperature: Math.min(this.profile.temperature, 1) } : {}),
      ...this.profile.extraBody,
    };
  }

  async complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
    const headers = {
      ...requestHeaders(this.profile, this.apiKey),
      "anthropic-version": this.profile.headers["anthropic-version"] ?? anthropicVersion,
      Accept: "text/event-stream",
    };
    const response = await postJson(
      this.fetchFunction,
      this.profile.name,
      endpoint(this.profile.baseUrl, "messages", this.profile.query),
      headers,
      this.body(request),
      request.signal,
      { retries: this.retries, onRetry: request.onRetry },
    );
    const state = newAnthropicState();
    await readSse(response, (event) => applyAnthropicEvent(state, event, onText, request.onReasoning));
    return finishAnthropic(state);
  }
}
