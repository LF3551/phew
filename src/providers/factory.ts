import type { ModelClient, ToolDefinition } from "../core/chat";
import { AnthropicClient, anthropicVersion } from "./anthropic";
import { GeminiClient } from "./gemini";
import { errorMessage, type FetchFunction, httpError, networkError } from "./http";
import { OpenAiCompatibleClient } from "./openaiCompatible";
import { endpoint, type ModelProfile, requestHeaders } from "./profile";

/** Creates the HTTP client of a profile. The `vscode` provider is created by the host. */
export function createHttpClient(
  profile: ModelProfile,
  apiKey: string | undefined,
  fetchFunction: FetchFunction = fetch,
): ModelClient {
  switch (profile.provider) {
    case "anthropic":
      return new AnthropicClient(profile, apiKey, fetchFunction);
    case "gemini":
      return new GeminiClient(profile, apiKey, fetchFunction);
    case "openai":
      return new OpenAiCompatibleClient(profile, apiKey, fetchFunction);
    case "vscode":
      throw new Error("VS Code language models are created by the extension host.");
  }
}

export interface ModelInfo {
  readonly id: string;
  readonly label?: string;
}

/** Loads the models that the provider offers. */
export async function listModels(
  profile: ModelProfile,
  apiKey: string | undefined,
  fetchFunction: FetchFunction = fetch,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const headers = requestHeaders(profile, apiKey);
  let url: string;
  if (profile.provider === "anthropic") {
    url = endpoint(profile.baseUrl, "models", { limit: "1000", ...profile.query });
    headers["anthropic-version"] = profile.headers["anthropic-version"] ?? anthropicVersion;
  } else if (profile.provider === "gemini")
    url = endpoint(profile.baseUrl, "models", { pageSize: "1000", ...profile.query });
  else url = endpoint(profile.baseUrl, "models", profile.query);

  let response: Response;
  try {
    response = await fetchFunction(url, { headers, signal });
  } catch (error) {
    throw networkError(profile.name, url, error);
  }
  const text = await response.text();
  if (!response.ok) throw httpError(profile.name, response.status, text);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${profile.name} returned a model list that is not JSON: ${errorMessage(text).slice(0, 200)}`);
  }
  return parseModelList(profile.provider, data);
}

/** Parses the model list formats of OpenAI-compatible APIs, Anthropic, and Gemini. */
export function parseModelList(provider: ModelProfile["provider"], data: unknown): ModelInfo[] {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const items = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(data)
        ? data
        : [];
  const models: ModelInfo[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (provider === "gemini") {
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
      if (methods.length > 0 && !methods.includes("generateContent")) continue;
      const name = typeof item.name === "string" ? item.name.replace(/^models\//, "") : "";
      if (name) models.push({ id: name, label: typeof item.displayName === "string" ? item.displayName : undefined });
      continue;
    }
    const id =
      typeof item.id === "string"
        ? item.id
        : typeof item.name === "string"
          ? item.name
          : typeof item.model === "string"
            ? item.model
            : "";
    if (!id) continue;
    const label = typeof item.display_name === "string" ? item.display_name : undefined;
    models.push({ id, label });
  }
  const unique = new Map(models.map((model) => [model.id, model]));
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly toolCalling: boolean;
  readonly milliseconds: number;
  readonly message: string;
}

const pingTool: ToolDefinition = {
  name: "ping",
  description: "Connection test. Call this tool once.",
  parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
};

/** Sends a tiny request that also checks whether the model can call tools. */
export async function testConnection(client: ModelClient, signal: AbortSignal): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    const result = await client.complete(
      {
        messages: [
          {
            role: "system",
            content: "You are a connection test. Call the ping tool with the message OK. Do not write text.",
          },
          { role: "user", content: "Run the test." },
        ],
        tools: [pingTool],
        signal,
      },
      () => {},
    );
    const toolCalling = result.toolCalls.some((call) => call.name === "ping");
    return {
      ok: true,
      toolCalling,
      milliseconds: Date.now() - started,
      message: toolCalling
        ? "The model answers and can call tools."
        : "The model answers, but it did not call the test tool. Code mode needs a model with tool calling.",
    };
  } catch (error) {
    return {
      ok: false,
      toolCalling: false,
      milliseconds: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
