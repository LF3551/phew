import * as vscode from "vscode";
import { apiKeySecretName, providerPresets, validateBaseUrl } from "../providers/presets";
import { readSettings, section } from "./settings";

/** Guides the user through the provider, the model, and the API key. The key goes to SecretStorage only. */
export async function configureModel(secrets: vscode.SecretStorage): Promise<boolean> {
  const current = readSettings();
  const pick = await vscode.window.showQuickPick(
    [
      ...providerPresets.map((preset) => ({
        label: preset.label,
        description: preset.baseUrl,
        detail: preset.local ? "Runs on your computer. No API key." : undefined,
        preset,
      })),
      { label: "Custom OpenAI-compatible endpoint", description: "Enter a base URL", preset: undefined },
    ],
    { title: "Phew: Choose a model provider", placeHolder: "Provider", ignoreFocusOut: true },
  );
  if (!pick) return false;

  let baseUrl = pick.preset?.baseUrl;
  if (!baseUrl) {
    baseUrl = await vscode.window.showInputBox({
      title: "Phew: Base URL",
      prompt: "The URL before /chat/completions",
      value: current.baseUrl || "https://",
      ignoreFocusOut: true,
      validateInput: validateBaseUrl,
    });
    if (!baseUrl) return false;
  }
  baseUrl = baseUrl.trim().replace(/\/+$/, "");

  const model = await vscode.window.showInputBox({
    title: "Phew: Model",
    prompt: "The model name of the provider. The suggested name is only an example.",
    value: current.baseUrl === baseUrl && current.model ? current.model : (pick.preset?.modelHint ?? ""),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? "Enter a model name." : undefined),
  });
  if (!model) return false;

  const secretName = apiKeySecretName(baseUrl);
  const needsKey = pick.preset ? pick.preset.needsKey : true;
  if (needsKey) {
    const existing = await secrets.get(secretName);
    const key = await vscode.window.showInputBox({
      title: "Phew: API key",
      prompt: existing
        ? "Leave empty to keep the saved key. Phew stores the key in the VS Code secret storage."
        : "Phew stores the key in the VS Code secret storage, not in the settings.",
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return false;
    if (key.trim()) await secrets.store(secretName, key.trim());
    else if (!existing && pick.preset) {
      void vscode.window.showWarningMessage("Phew: no API key is saved. Requests can fail.");
    }
  }

  const config = vscode.workspace.getConfiguration(section);
  await config.update("model.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
  await config.update("model.name", model.trim(), vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`Phew uses ${model.trim()} from ${pick.label}.`);
  return true;
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const { baseUrl } = readSettings();
  if (!baseUrl) return;
  await secrets.delete(apiKeySecretName(baseUrl));
  void vscode.window.showInformationMessage(`Phew removed the API key for ${baseUrl}.`);
}

export function providerLabel(baseUrl: string): string {
  const preset = providerPresets.find((item) => item.baseUrl === baseUrl);
  if (preset) return preset.label.replace(/ \(.*\)$/, "");
  try {
    return new URL(baseUrl).host;
  } catch {
    return "Not configured";
  }
}
