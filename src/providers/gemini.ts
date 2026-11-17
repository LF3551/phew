import type { ChatMessage, CompletionRequest, CompletionResult, ModelClient, ToolCall } from "../core/chat";
import { argumentsObject, type FetchFunction, postJson, readSse } from "./http";
import { endpoint, type ModelProfile, requestHeaders } from "./profile";

type Part =
  | { text: string; thought?: boolean }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

export interface GeminiContent {
  role: "user" | "model";
  parts: Part[];
}

/** Schema keywords that the Gemini function declaration format accepts. */
const allowedSchemaKeys = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "items",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "anyOf",
  "title",
  "default",
  "propertyOrdering",
]);

/**
 * Converts a JSON Schema to the OpenAPI subset of Gemini.
 * Unsupported keywords are removed and `type: ["string", "null"]` becomes `nullable`.
 */
export function toGeminiSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema) || depth > 20) return { type: "string" };
  const source = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!allowedSchemaKeys.has(key)) continue;
    if (key === "properties" && typeof value === "object" && value !== null) {
      result.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, toGeminiSchema(item, depth + 1)]),
      );
    } else if (key === "items") result.items = toGeminiSchema(value, depth + 1);
    else if (key === "anyOf" && Array.isArray(value))
      result.anyOf = value.map((item) => toGeminiSchema(item, depth + 1));
    else if (key === "type" && Array.isArray(value)) {
      const types = value.filter((item) => item !== "null");
      result.type = types[0] ?? "string";
      if (types.length < value.length) result.nullable = true;
    } else if (key === "enum" && Array.isArray(value)) result.enum = value.map(String);
    else result[key] = value;
  }
  if (result.type === undefined && result.anyOf === undefined) result.type = "string";
  if (result.type === "object" && result.properties === undefined) result.properties = {};
  if (Array.isArray(result.required) && result.properties && typeof result.properties === "object") {
    const names = new Set(Object.keys(result.properties as object));
    result.required = (result.required as unknown[]).filter((name) => typeof name === "string" && names.has(name));
  }
  return result;
}

/** Converts the conversation to the Gemini `contents` format. */
export function toGemini(messages: readonly ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const calls = new Map<string, { name: string; id?: string }>();
  const push = (role: "user" | "model", parts: Part[]) => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    switch (message.role) {
      case "system":
        system.push(message.content);
        break;
      case "user":
        push("user", [
          ...(message.images ?? []).map(
            (image): Part => ({ inlineData: { mimeType: image.mimeType, data: image.data } }),
          ),
          { text: message.content || " " },
        ]);
        break;
      case "assistant": {
        const parts: Part[] = [];
        if (message.content.trim()) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          const providerId = call.id.startsWith("gemini_") ? undefined : call.id;
          calls.set(call.id, { name: call.name, id: providerId });
          parts.push({
            functionCall: {
              name: call.name,
              args: argumentsObject(call.arguments),
              ...(providerId ? { id: providerId } : {}),
            },
            ...(call.signature ? { thoughtSignature: call.signature } : {}),
          });
        }
        push("model", parts.length > 0 ? parts : [{ text: "(no answer)" }]);
        break;
      }
      case "tool": {
        const call = calls.get(message.toolCallId);
        push("user", [
          {
            functionResponse: {
              name: call?.name ?? "tool",
              response: { result: message.content },
              ...(call?.id ? { id: call.id } : {}),
            },
          },
        ]);
        break;
      }
    }
  }
  if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "Continue." }] });
  return { system: system.join("\n\n"), contents };
}

interface GeminiState {
  content: string;
  calls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  finishReason?: string;
}

export function newGeminiState(): GeminiState {
  return { content: "", calls: [], inputTokens: 0, outputTokens: 0 };
}

/** Applies one streamed Gemini response chunk. */
export function applyGeminiChunk(state: GeminiState, chunk: unknown, onText: (delta: string) => void): void {
  if (typeof chunk !== "object" || chunk === null) return;
  const data = chunk as {
    candidates?: { content?: { parts?: Record<string, unknown>[] }; finishReason?: unknown }[];
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown };
    promptFeedback?: { blockReason?: unknown };
    error?: { message?: unknown };
  };
  if (data.error) throw new Error(`Gemini returned an error: ${String(data.error.message ?? "unknown error")}`);
  if (typeof data.promptFeedback?.blockReason === "string") {
    throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}.`);
  }
  if (data.usageMetadata) {
    state.inputTokens = Number(data.usageMetadata.promptTokenCount) || state.inputTokens;
    state.outputTokens =
      (Number(data.usageMetadata.candidatesTokenCount) || 0) + (Number(data.usageMetadata.thoughtsTokenCount) || 0) ||
      state.outputTokens;
  }
  const candidate = data.candidates?.[0];
  if (!candidate) return;
  if (typeof candidate.finishReason === "string") state.finishReason = candidate.finishReason;
  for (const part of candidate.content?.parts ?? []) {
    if (typeof part.text === "string" && part.thought !== true) {
      state.content += part.text;
      onText(part.text);
    }
    const call = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
    if (call && typeof call.name === "string") {
      state.calls.push({
        id:
          typeof call.id === "string" && call.id ? call.id : `gemini_${state.calls.length}_${Date.now().toString(36)}`,
        name: call.name,
        arguments: JSON.stringify(call.args ?? {}),
        ...(typeof part.thoughtSignature === "string" ? { signature: part.thoughtSignature } : {}),
      });
    }
  }
}

export function finishGemini(state: GeminiState): CompletionResult {
  return {
    content: state.content,
    toolCalls: state.calls,
    usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
    finishReason: state.finishReason,
  };
}

/** A client for the native Google Gemini API (generateContent with streaming). */
export class GeminiClient implements ModelClient {
  constructor(
    private readonly profile: ModelProfile,
    private readonly apiKey: string | undefined,
    private readonly fetchFunction: FetchFunction = fetch,
  ) {}

  body(request: CompletionRequest): Record<string, unknown> {
    const { system, contents } = toGemini(request.messages);
    const extra = { ...this.profile.extraBody };
    const generationConfig = {
      ...(this.profile.temperature !== undefined ? { temperature: this.profile.temperature } : {}),
      ...(this.profile.maxTokens !== undefined ? { maxOutputTokens: this.profile.maxTokens } : {}),
      ...((extra.generationConfig as Record<string, unknown> | undefined) ?? {}),
    };
    delete extra.generationConfig;
    return {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(request.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: toGeminiSchema(tool.parameters),
                })),
              },
            ],
          }
        : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...extra,
    };
  }

  async complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
    const model = this.profile.model.replace(/^models\//, "");
    const url = endpoint(this.profile.baseUrl, `models/${encodeURIComponent(model)}:streamGenerateContent`, {
      alt: "sse",
      ...this.profile.query,
    });
    const response = await postJson(
      this.fetchFunction,
      this.profile.name,
      url,
      { ...requestHeaders(this.profile, this.apiKey), Accept: "text/event-stream" },
      this.body(request),
      request.signal,
    );
    const state = newGeminiState();
    await readSse(response, (chunk) => applyGeminiChunk(state, chunk, onText));
    return finishGemini(state);
  }
}
