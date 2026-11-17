import type { ModelOption } from "../shared/protocol";

/** Labels of the model menu: a name without repeats and the details that help to choose. */

export const providerLabels: Readonly<Record<ModelOption["provider"], string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI-compatible",
  gemini: "Gemini",
  vscode: "VS Code",
};

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
