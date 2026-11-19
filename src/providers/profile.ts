/** The API protocol of a model provider. */
export type ProviderKind = "openai" | "anthropic" | "gemini" | "vscode";

export const providerKinds: readonly ProviderKind[] = ["openai", "anthropic", "gemini", "vscode"];

/** How the API key is sent. */
export type AuthStyle = "bearer" | "api-key" | "x-api-key" | "x-goog-api-key" | "none";

export const authStyles: readonly AuthStyle[] = ["bearer", "api-key", "x-api-key", "x-goog-api-key", "none"];

/** A saved model configuration. Users can keep several profiles and switch between them. */
export interface ModelProfile {
  /** Stable identifier. The API key in the secret storage uses it. */
  readonly id: string;
  /** Display name, for example "Claude Sonnet (work)". */
  readonly name: string;
  readonly provider: ProviderKind;
  /** API base URL. Not used by the `vscode` provider. */
  readonly baseUrl: string;
  /** Model name of the provider, or the model ID of a VS Code language model. */
  readonly model: string;
  readonly auth: AuthStyle;
  /** Environment variable with the API key. The secret storage wins when both exist. */
  readonly apiKeyEnv?: string;
  /**
   * A command that prints the key, for short-lived tokens (`gcloud auth print-access-token`).
   * It wins over the secret storage and the environment variable. Only the user settings can set it.
   */
  readonly apiKeyCommand?: string;
  /**
   * The id of another model that takes over a task when this one runs out of quota or credit, or stays rate
   * limited or overloaded after all retries.
   */
  readonly fallback?: string;
  /** Extra HTTP headers. Do not put secrets here; settings are plain text. */
  readonly headers: Readonly<Record<string, string>>;
  /** Extra URL query parameters, for example `api-version` for Azure. */
  readonly query: Readonly<Record<string, string>>;
  /** Extra JSON fields merged into the request body, for example `reasoning_effort`. */
  readonly extraBody: Readonly<Record<string, unknown>>;
  readonly temperature?: number;
  /** Maximum output tokens. Anthropic needs a value; other providers use their default when empty. */
  readonly maxTokens?: number;
  /** Price in US dollars per one million tokens, for the cost display and budget. */
  readonly price?: { readonly input: number; readonly output: number };
  /** Size of the context window in tokens, for the context meter and automatic compaction. */
  readonly contextWindow?: number;
  /** For OpenAI-compatible providers: Chat Completions (`chat`) or the Responses API (`responses`). */
  readonly api?: "chat" | "responses";
}

export const defaultAuth: Readonly<Record<ProviderKind, AuthStyle>> = {
  openai: "bearer",
  anthropic: "x-api-key",
  gemini: "x-goog-api-key",
  vscode: "none",
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringRecord = (value: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item === "string" || typeof item === "number") result[key] = String(item);
  }
  return result;
};

const finiteNumber = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

/** Turns a display name into a stable profile identifier. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "model";
}

/** Returns an identifier that is not in `existing`. */
export function uniqueId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const slug = slugify(base);
  if (!taken.has(slug)) return slug;
  for (let index = 2; ; index++) if (!taken.has(`${slug}-${index}`)) return `${slug}-${index}`;
}

/** Validates one profile from the settings. Returns an error message for invalid input. */
export function parseProfile(value: unknown): ModelProfile | string {
  const raw = record(value);
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id))
    return "Each model needs an id with letters, digits, dots, dashes, or underscores.";
  const provider = raw.provider;
  if (typeof provider !== "string" || !(providerKinds as readonly string[]).includes(provider)) {
    return `Model "${id}" needs a provider: ${providerKinds.join(", ")}.`;
  }
  const kind = provider as ProviderKind;
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) return `Model "${id}" needs a model name.`;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "";
  if (kind !== "vscode" && !baseUrl) return `Model "${id}" needs a baseUrl.`;
  const auth =
    typeof raw.auth === "string" && (authStyles as readonly string[]).includes(raw.auth)
      ? (raw.auth as AuthStyle)
      : defaultAuth[kind];
  const price = record(raw.price);
  const input = finiteNumber(price.input, 0, 1_000_000);
  const output = finiteNumber(price.output, 0, 1_000_000);
  const maxTokens = finiteNumber(raw.maxTokens, 1, 10_000_000);
  const contextWindow = finiteNumber(raw.contextWindow, 1000, 100_000_000);
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : model,
    provider: kind,
    baseUrl,
    model,
    auth,
    apiKeyEnv: typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : undefined,
    fallback:
      typeof raw.fallback === "string" &&
      /^[A-Za-z0-9_.-]{1,64}$/.test(raw.fallback.trim()) &&
      raw.fallback.trim() !== id
        ? raw.fallback.trim()
        : undefined,
    apiKeyCommand:
      typeof raw.apiKeyCommand === "string" && raw.apiKeyCommand.trim()
        ? raw.apiKeyCommand.trim().slice(0, 2000)
        : undefined,
    headers: stringRecord(raw.headers),
    query: stringRecord(raw.query),
    extraBody: record(raw.extraBody),
    temperature: finiteNumber(raw.temperature, 0, 2),
    maxTokens: maxTokens === undefined ? undefined : Math.round(maxTokens),
    price: input !== undefined && output !== undefined ? { input, output } : undefined,
    contextWindow: contextWindow === undefined ? undefined : Math.round(contextWindow),
    api: kind === "openai" && raw.api === "responses" ? "responses" : undefined,
  };
}

export interface ParsedProfiles {
  readonly profiles: ModelProfile[];
  readonly errors: string[];
}

/** Validates the `phew.models` setting. Invalid and duplicate entries are reported and skipped. */
export function parseProfiles(value: unknown): ParsedProfiles {
  const profiles: ModelProfile[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const result = parseProfile(item);
    if (typeof result === "string") errors.push(result);
    else if (seen.has(result.id)) errors.push(`The model id "${result.id}" is used more than once.`);
    else {
      seen.add(result.id);
      profiles.push(result);
    }
  }
  return { profiles, errors };
}

/** Converts a profile to the JSON form of the settings and omits empty values. */
export function serializeProfile(profile: ModelProfile): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
  };
  if (profile.baseUrl) result.baseUrl = profile.baseUrl;
  if (profile.auth !== defaultAuth[profile.provider]) result.auth = profile.auth;
  if (profile.apiKeyEnv) result.apiKeyEnv = profile.apiKeyEnv;
  if (profile.apiKeyCommand) result.apiKeyCommand = profile.apiKeyCommand;
  if (profile.fallback) result.fallback = profile.fallback;
  if (Object.keys(profile.headers).length > 0) result.headers = profile.headers;
  if (Object.keys(profile.query).length > 0) result.query = profile.query;
  if (Object.keys(profile.extraBody).length > 0) result.extraBody = profile.extraBody;
  if (profile.temperature !== undefined) result.temperature = profile.temperature;
  if (profile.maxTokens !== undefined) result.maxTokens = profile.maxTokens;
  if (profile.price) result.price = profile.price;
  if (profile.contextWindow) result.contextWindow = profile.contextWindow;
  if (profile.api === "responses") result.api = "responses";
  return result;
}

/** Builds an endpoint URL from the base URL, a path, and query parameters. */
export function endpoint(baseUrl: string, path: string, query: Readonly<Record<string, string>> = {}): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** Builds the HTTP headers of a request, including the API key in the style of the profile. */
export function requestHeaders(profile: ModelProfile, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    switch (profile.auth) {
      case "bearer":
        headers.Authorization = `Bearer ${apiKey}`;
        break;
      case "api-key":
        headers["api-key"] = apiKey;
        break;
      case "x-api-key":
        headers["x-api-key"] = apiKey;
        break;
      case "x-goog-api-key":
        headers["x-goog-api-key"] = apiKey;
        break;
      case "none":
        break;
    }
  }
  return { ...headers, ...profile.headers };
}
