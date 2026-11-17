export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly needsKey: boolean;
  readonly modelHint: string;
  readonly local?: boolean;
}

/**
 * Common OpenAI-compatible endpoints. The user can change the base URL and the model at any time.
 * Model names change often, so the hints are examples only.
 */
export const providerPresets: readonly ProviderPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true, modelHint: "gpt-4.1" },
  {
    id: "anthropic",
    label: "Anthropic (OpenAI-compatible endpoint)",
    baseUrl: "https://api.anthropic.com/v1",
    needsKey: true,
    modelHint: "claude-sonnet-4-5",
  },
  {
    id: "gemini",
    label: "Google Gemini (OpenAI-compatible endpoint)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    modelHint: "gemini-2.5-flash",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    modelHint: "openai/gpt-4.1",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    modelHint: "llama-3.3-70b-versatile",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
    modelHint: "deepseek-chat",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    modelHint: "qwen2.5-coder:14b",
    local: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    modelHint: "qwen2.5-coder-14b-instruct",
    local: true,
  },
];

/** Validates a base URL. Plain HTTP is allowed only for the local computer. */
export function validateBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a valid URL, for example https://api.openai.com/v1.";
  }
  if (url.username || url.password) return "Do not put credentials in the URL. Phew stores the API key separately.";
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && local) return undefined;
  return "Use HTTPS. Plain HTTP is allowed only for localhost.";
}

/** The SecretStorage key of the API key for a base URL. */
export function apiKeySecretName(baseUrl: string): string {
  return `phew.apiKey:${baseUrl.trim().replace(/\/+$/, "").toLowerCase()}`;
}
