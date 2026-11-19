import type { ModelOption } from "../shared/protocol";

/** Labels of the model menu: a name without repeats and the details that help to choose. */

export const providerLabels: Readonly<Record<ModelOption["provider"], string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI-compatible",
  gemini: "Gemini",
  vscode: "VS Code",
};

/** The maker of a model, from its name, for the badge: a Claude model through Copilot still shows as Claude. */
export interface ModelMaker {
  readonly badge: string;
  readonly color: string;
  readonly label: string;
}

const makers: readonly [RegExp, ModelMaker][] = [
  [/claude|anthropic|sonnet|opus|haiku/i, { badge: "A", color: "#d97757", label: "Anthropic" }],
  [/gemini|gemma|google/i, { badge: "G", color: "#4285f4", label: "Google" }],
  [/(^|[/:])(gpt|o\d|chatgpt|codex|openai)|gpt-/i, { badge: "O", color: "#10a37f", label: "OpenAI" }],
  [/grok|xai/i, { badge: "X", color: "#8b8b8b", label: "xAI" }],
  [/deepseek/i, { badge: "D", color: "#4d6bfe", label: "DeepSeek" }],
  [/mistral|codestral|devstral|magistral/i, { badge: "M", color: "#fa520f", label: "Mistral" }],
  [/qwen/i, { badge: "Q", color: "#7c5cff", label: "Qwen" }],
  [/llama|meta/i, { badge: "L", color: "#0866ff", label: "Meta" }],
  [/kimi|moonshot/i, { badge: "K", color: "#6b7280", label: "Moonshot" }],
  [/glm|zhipu/i, { badge: "Z", color: "#3b82f6", label: "Zhipu" }],
];

const protocolMakers: Readonly<Record<ModelOption["provider"], ModelMaker>> = {
  anthropic: { badge: "A", color: "#d97757", label: "Anthropic" },
  openai: { badge: "O", color: "#10a37f", label: "OpenAI-compatible" },
  gemini: { badge: "G", color: "#4285f4", label: "Google" },
  vscode: { badge: "VS", color: "#3794ff", label: "VS Code" },
};

/** Who made the model: from the model name first, then from the protocol of the provider. */
export function modelMaker(model: { provider: ModelOption["provider"]; model: string }): ModelMaker {
  if (model.provider === "vscode" && model.model.toLowerCase() === "auto") return protocolMakers.vscode;
  return makers.find(([pattern]) => pattern.test(model.model))?.[1] ?? protocolMakers[model.provider];
}

/** "200K" or "1M". */
export function contextSize(tokens: number | undefined): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

const isAuto = (model: ModelOption) => model.provider === "vscode" && model.model.toLowerCase() === "auto";

/** The name without a repeated model id: "GitHub Copilot · claude-haiku-5.5" shows as "GitHub Copilot". */
export function modelTitle(model: ModelOption): { title: string; detail: string } {
  if (isAuto(model)) return { title: "Auto", detail: "VS Code picks the model for each request" };
  let title = model.name.trim();
  const suffix = ` · ${model.model}`;
  if (title.endsWith(suffix) && title.length > suffix.length) title = title.slice(0, -suffix.length);
  const parts = [title.toLowerCase().includes(model.model.toLowerCase()) ? "" : model.model];
  const provider = providerLabels[model.provider];
  if (!title.toLowerCase().includes(provider.toLowerCase())) parts.push(provider);
  const size = contextSize(model.contextWindow);
  if (size) parts.push(`${size} context`);
  return { title, detail: parts.filter(Boolean).join(" · ") };
}
