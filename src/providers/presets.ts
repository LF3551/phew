import type { AuthStyle, ProviderKind } from "./profile";

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly group: "Cloud" | "Local" | "Gateway" | "Editor";
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  readonly auth: AuthStyle;
  readonly needsKey: boolean;
  /** Common environment variable with the API key. */
  readonly keyEnv?: string;
  /** Page where the user creates an API key. */
  readonly keyUrl?: string;
  /** Example model. Model names change often, so Phew loads the real list when it can. */
  readonly modelHint: string;
  /** The user must enter or complete the base URL, for example an Azure resource. */
  readonly askBaseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly description: string;
  /** Base URLs to try in order when the user does not change the URL, for example the GitHub Copilot plans. */
  readonly probeBaseUrls?: readonly string[];
}

/**
 * Provider presets. Each preset fills the protocol, the URL, and the auth style.
 * The user can change every field later in the model profile.
 */
export const providerPresets: readonly ProviderPreset[] = [
  {
    id: "copilot",
    label: "GitHub Copilot and other VS Code models",
    group: "Editor",
    provider: "vscode",
    baseUrl: "",
    auth: "none",
    needsKey: false,
    modelHint: "",
    description:
      "Uses models that VS Code already provides, for example with a GitHub Copilot subscription. No API key.",
  },
  {
    id: "copilot-token",
    label: "GitHub Copilot (token)",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.individual.githubcopilot.com",
    probeBaseUrls: [
      "https://api.individual.githubcopilot.com",
      "https://api.business.githubcopilot.com",
      "https://api.enterprise.githubcopilot.com",
    ],
    auth: "bearer",
    needsKey: true,
    keyEnv: "COPILOT_GITHUB_TOKEN",
    keyUrl: "https://github.com/settings/personal-access-tokens/new",
    modelHint: "claude-sonnet-4.5",
    headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
    description:
      "Your GitHub Copilot subscription with a GitHub token (github_pat_…). Phew finds your plan: Individual, Business, or Enterprise.",
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    modelHint: "gpt-4.1",
    description: "GPT and o-series models.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    group: "Cloud",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: "x-api-key",
    needsKey: true,
    keyEnv: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    modelHint: "claude-sonnet-4-5",
    description: "Models through the native Anthropic Messages API.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    group: "Cloud",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: "x-goog-api-key",
    needsKey: true,
    keyEnv: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    modelHint: "gemini-3.8-flash",
    description: "Gemini models through the native Gemini API.",
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
    askBaseUrl: "Your Azure OpenAI endpoint, for example https://my-resource.openai.azure.com/openai/v1",
    auth: "api-key",
    needsKey: true,
    keyEnv: "AZURE_OPENAI_API_KEY",
    modelHint: "your-deployment-name",
    description: "Azure OpenAI deployments. The model name is the deployment name.",
  },
  {
    id: "mistral",
    label: "Mistral",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/api-keys",
    modelHint: "codestral-latest",
    description: "Mistral and Codestral models.",
  },
  {
    id: "xai",
    label: "xAI",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.x.ai/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
    modelHint: "grok-code-fast-1",
    description: "Grok models.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    modelHint: "deepseek-chat",
    description: "DeepSeek models.",
  },
  {
    id: "groq",
    label: "Groq",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    modelHint: "llama-3.3-70b-versatile",
    description: "Very fast inference of open models.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "CEREBRAS_API_KEY",
    modelHint: "qwen-3-coder-480b",
    description: "Very fast inference of open models.",
  },
  {
    id: "together",
    label: "Together AI",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.together.xyz/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "TOGETHER_API_KEY",
    modelHint: "Qwen/Qwen2.5-Coder-32B-Instruct",
    description: "Open models in the cloud.",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    group: "Cloud",
    provider: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "FIREWORKS_API_KEY",
    modelHint: "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
    description: "Open models in the cloud.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "Gateway",
    provider: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: "bearer",
    needsKey: true,
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    modelHint: "anthropic/claude-sonnet-4.5",
    headers: { "HTTP-Referer": "https://github.com/LF3551/phew", "X-Title": "Phew" },
    description: "Hundreds of models from many providers with one key.",
  },
  {
    id: "litellm",
    label: "LiteLLM proxy",
    group: "Gateway",
    provider: "openai",
    baseUrl: "http://localhost:4000/v1",
    askBaseUrl: "The URL of your LiteLLM proxy",
    auth: "bearer",
    needsKey: false,
    modelHint: "gpt-4.1",
    description: "Your own gateway to any provider, including AWS Bedrock and Vertex AI.",
  },
  {
    id: "ollama",
    label: "Ollama",
    group: "Local",
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    auth: "none",
    needsKey: false,
    modelHint: "qwen2.5-coder:14b",
    description: "Local models. Your code stays on your computer.",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    group: "Local",
    provider: "openai",
    baseUrl: "http://localhost:1234/v1",
    auth: "none",
    needsKey: false,
    modelHint: "qwen2.5-coder-14b-instruct",
    description: "Local models. Your code stays on your computer.",
  },
  {
    id: "vllm",
    label: "vLLM or another local server",
    group: "Local",
    provider: "openai",
    baseUrl: "http://localhost:8000/v1",
    askBaseUrl: "The URL of your OpenAI-compatible server",
    auth: "none",
    needsKey: false,
    modelHint: "",
    description: "Any self-hosted server with an OpenAI-compatible API.",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible API",
    group: "Gateway",
    provider: "openai",
    baseUrl: "https://",
    askBaseUrl: "The base URL before /chat/completions",
    auth: "bearer",
    needsKey: true,
    modelHint: "",
    description: "Any other provider with an OpenAI-compatible API.",
  },
];

/** Validates a base URL. Plain HTTP is allowed only for the local computer and private networks. */
export function validateBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a valid URL, for example https://api.openai.com/v1.";
  }
  if (url.username || url.password) return "Do not put credentials in the URL. Phew stores the API key separately.";
  if (/YOUR-RESOURCE/i.test(url.hostname)) return "Replace YOUR-RESOURCE with the name of your resource.";
  if (url.protocol === "https:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateHost =
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "host.docker.internal";
  if (url.protocol === "http:" && privateHost) return undefined;
  return "Use HTTPS. Plain HTTP is allowed only for localhost and private networks.";
}

/** The SecretStorage key of the API key of a model profile. */
export function apiKeySecretName(profileId: string): string {
  return `phew.apiKey.${profileId}`;
}
