import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ModelClient } from "../core/chat";
import {
  type ConnectionTestResult,
  createHttpClient,
  listModels,
  type ModelInfo,
  testConnection,
} from "../providers/factory";
import { apiKeySecretName, type ProviderPreset, providerPresets, validateBaseUrl } from "../providers/presets";
import {
  type ModelProfile,
  type ParsedProfiles,
  parseProfiles,
  serializeProfile,
  uniqueId,
} from "../providers/profile";
import { readSettings } from "./settings";
import { listVsCodeModels, VsCodeLanguageModelClient } from "./vscodeLmClient";

const section = "phew";

export interface ProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly needsKey: boolean;
  readonly keyUrl?: string;
  readonly keyEnv?: string;
  readonly envFound: boolean;
  readonly askBaseUrl?: string;
  readonly baseUrl: string;
  readonly modelHint: string;
  /** For local servers and VS Code models: true when they are ready. */
  readonly available?: boolean;
  readonly note?: string;
  /** True when the Pi coding agent on this computer has a GitHub Copilot token that Phew can use. */
  readonly piKey?: boolean;
}

/** Reads the GitHub Copilot token of the Pi coding agent, if the user configured one. */
export async function piCopilotToken(): Promise<string | undefined> {
  try {
    const file = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "auth.json");
    const data = JSON.parse(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file))),
    ) as Record<string, { type?: unknown; key?: unknown }>;
    const entry = data["github-copilot"];
    return entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim()
      ? entry.key.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export const providerNames: Readonly<Record<ModelProfile["provider"], string>> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
  gemini: "Gemini",
  vscode: "VS Code",
};

/** Keeps the model profiles, their API keys, and the active model. */
export class ModelManager {
  private reportedErrors = "";

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Profiles come only from the user settings, so a workspace cannot redirect an API key. */
  profiles(): ParsedProfiles {
    const parsed = parseProfiles(vscode.workspace.getConfiguration(section).inspect("models")?.globalValue);
    const errors = parsed.errors.join("\n");
    if (errors && errors !== this.reportedErrors) {
      this.reportedErrors = errors;
      this.log.warn(`Invalid phew.models entries:\n${errors}`);
      void vscode.window.showWarningMessage(`Phew: ${parsed.errors[0]}`, "Edit Models").then((answer) => {
        if (answer) void openModelsJson();
      });
    }
    return parsed;
  }

  active(): ModelProfile | undefined {
    const { profiles } = this.profiles();
    const id = vscode.workspace.getConfiguration(section).get<string>("activeModel");
    return profiles.find((profile) => profile.id === id) ?? profiles[0];
  }

  async apiKey(profile: ModelProfile): Promise<string | undefined> {
    const stored = await this.secrets.get(apiKeySecretName(profile.id));
    if (stored) return stored;
    return profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  }

  async client(profile: ModelProfile): Promise<ModelClient> {
    if (profile.provider === "vscode") return new VsCodeLanguageModelClient(profile.model);
    return createHttpClient(profile, await this.apiKey(profile), fetch, readSettings().maxRetries);
  }

  // A programmatic API for the settings page. It never shows quick picks or input boxes.

  /** Facts about each provider for the setup page: env keys, local servers, and VS Code models. */
  async detectProviders(): Promise<ProviderStatus[]> {
    const vscodeModels = await listVsCodeModels().catch(() => []);
    const local = async (url: string) => {
      try {
        const response = await fetch(`${url}/models`, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return undefined;
        const data = (await response.json()) as { data?: unknown[]; models?: unknown[] };
        return (data.data ?? data.models ?? []).length;
      } catch {
        return undefined;
      }
    };
    return Promise.all(
      providerPresets.map(async (preset) => {
        const status: ProviderStatus = {
          id: preset.id,
          label: preset.label,
          group: preset.group,
          description: preset.description,
          needsKey: preset.needsKey,
          keyUrl: preset.keyUrl,
          keyEnv: preset.keyEnv,
          envFound: !!(preset.keyEnv && process.env[preset.keyEnv]),
          askBaseUrl: preset.askBaseUrl,
          baseUrl: preset.baseUrl,
          modelHint: preset.modelHint,
        };
        if (preset.provider === "vscode")
          return { ...status, available: vscodeModels.length > 0, note: `${vscodeModels.length} models` };
        if (preset.id === "copilot-token") return { ...status, piKey: (await piCopilotToken()) !== undefined };
        if (preset.group === "Local") {
          const count = await local(preset.baseUrl);
          return {
            ...status,
            available: count !== undefined,
            note: count === undefined ? "Not running" : `Running · ${count} models`,
          };
        }
        return status;
      }),
    );
  }

  /** Builds a profile for a preset and the values from the setup page. */
  draftProfile(
    presetId: string,
    options: { baseUrl?: string; apiKeyEnv?: string; model?: string; name?: string; api?: "chat" | "responses" },
  ): ModelProfile {
    const preset = providerPresets.find((item) => item.id === presetId);
    if (!preset) throw new Error("Unknown provider.");
    const baseUrl = (options.baseUrl?.trim() || preset.baseUrl).replace(/\/+$/, "");
    if (preset.provider !== "vscode") {
      const error = validateBaseUrl(baseUrl);
      if (error) throw new Error(error);
    }
    return {
      id: "draft",
      name: options.name?.trim() || preset.label,
      provider: preset.provider,
      baseUrl: preset.provider === "vscode" ? "" : baseUrl,
      model: options.model ?? preset.modelHint,
      auth: preset.auth,
      apiKeyEnv: options.apiKeyEnv,
      headers: preset.headers ?? {},
      query: {},
      extraBody: {},
      ...(options.api === "responses" ? { api: "responses" as const } : {}),
    };
  }

  /**
   * Loads the models of a provider with a key that is not saved yet. For presets with several possible URLs,
   * such as the GitHub Copilot plans, it tries each URL and returns the one that works.
   */
  async modelsFor(
    draft: ModelProfile,
    apiKey: string | undefined,
    probeBaseUrls: readonly string[] = [],
  ): Promise<{ models: ModelInfo[]; baseUrl: string }> {
    if (draft.provider === "vscode") return { models: await listVsCodeModels(), baseUrl: "" };
    const key = apiKey || (draft.apiKeyEnv ? process.env[draft.apiKeyEnv] : undefined);
    const candidates = probeBaseUrls.length > 0 ? probeBaseUrls : [draft.baseUrl];
    let lastError: unknown;
    for (const baseUrl of candidates) {
      try {
        const models = await listModels({ ...draft, baseUrl }, key, fetch, AbortSignal.timeout(20_000));
        return { models, baseUrl };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Saves a new profile, stores the key, makes it active, and tests it. */
  async create(
    draft: ModelProfile,
    apiKey: string | undefined,
    contextWindow?: number,
  ): Promise<{ profile: ModelProfile; test: ConnectionTestResult }> {
    const existing = this.profiles().profiles;
    const name =
      draft.name === providerPresets.find((item) => item.label === draft.name)?.label
        ? `${draft.name} · ${draft.model}`
        : draft.name;
    const profile: ModelProfile = {
      ...draft,
      name,
      id: uniqueId(
        name,
        existing.map((item) => item.id),
      ),
      ...(contextWindow ? { contextWindow } : {}),
    };
    if (apiKey?.trim()) await this.secrets.store(apiKeySecretName(profile.id), apiKey.trim());
    await this.save([...existing, profile]);
    await this.setActive(profile.id);
    this.log.info(`Model added: ${profile.id} (${profile.provider} ${profile.model})`);
    return { profile, test: await this.check(profile) };
  }

  /** Tests a profile and returns the result without a notification. */
  async check(profile: ModelProfile): Promise<ConnectionTestResult> {
    try {
      return await testConnection(await this.client(profile), AbortSignal.timeout(60_000));
    } catch (error) {
      return {
        ok: false,
        toolCalling: false,
        milliseconds: 0,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async hasKey(profile: ModelProfile): Promise<"saved" | "env" | "none"> {
    if (await this.secrets.get(apiKeySecretName(profile.id))) return "saved";
    return profile.apiKeyEnv && process.env[profile.apiKeyEnv] ? "env" : "none";
  }

  async setKey(id: string, key: string): Promise<void> {
    if (key.trim()) await this.secrets.store(apiKeySecretName(id), key.trim());
    else await this.secrets.delete(apiKeySecretName(id));
  }

  async update(id: string, changes: Partial<ModelProfile>): Promise<void> {
    const profile = this.profiles().profiles.find((item) => item.id === id);
    if (!profile) return;
    await this.replace({ ...profile, ...changes, id: profile.id });
  }

  async delete(id: string): Promise<void> {
    await this.secrets.delete(apiKeySecretName(id));
    await this.save(this.profiles().profiles.filter((item) => item.id !== id));
  }

  async setActive(id: string): Promise<void> {
    await vscode.workspace.getConfiguration(section).update("activeModel", id, vscode.ConfigurationTarget.Global);
  }

  /** Quick switch from the chat view and the command palette. */
  async switchModel(): Promise<void> {
    const { profiles } = this.profiles();
    if (profiles.length === 0) {
      await vscode.commands.executeCommand("phew.addModel");
      return;
    }
    const active = this.active();
    type Item = vscode.QuickPickItem & { action: "use" | "add" | "manage"; profile?: ModelProfile };
    const items: Item[] = [
      ...profiles.map((profile) => ({
        label: `${profile.id === active?.id ? "$(check)" : "$(blank)"} ${profile.name}`,
        description: `${providerNames[profile.provider]} · ${profile.model}`,
        action: "use" as const,
        profile,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator, action: "use" },
      { label: "$(add) Connect another model…", action: "add" },
      { label: "$(settings-gear) Manage models…", action: "manage" },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: "Phew: Switch model", placeHolder: "Model" });
    if (!pick) return;
    if (pick.action === "add" || pick.action === "manage") await vscode.commands.executeCommand("phew.addModel");
    else if (pick.profile) await this.setActive(pick.profile.id);
  }

  /** A guided setup: provider, endpoint, key, model from the live list, name, and a connection test. */
  async addModel(): Promise<ModelProfile | undefined> {
    const preset = await pickPreset();
    if (!preset) return undefined;

    let baseUrl = preset.baseUrl;
    if (preset.askBaseUrl) {
      const value = await vscode.window.showInputBox({
        title: `Phew: ${preset.label} URL`,
        prompt: preset.askBaseUrl,
        value: preset.baseUrl,
        ignoreFocusOut: true,
        validateInput: validateBaseUrl,
      });
      if (!value) return undefined;
      baseUrl = value.trim().replace(/\/+$/, "");
    }

    const key = await askForKey(preset);
    if (key === undefined) return undefined;

    const draft: ModelProfile = {
      id: "draft",
      name: preset.label,
      provider: preset.provider,
      baseUrl,
      model: preset.modelHint,
      auth: preset.auth,
      apiKeyEnv: key.env,
      headers: preset.headers ?? {},
      query: {},
      extraBody: {},
    };
    const model = await pickModel(draft, key.value ?? (key.env ? process.env[key.env] : undefined));
    if (!model) return undefined;

    const existing = this.profiles().profiles;
    const name = await vscode.window.showInputBox({
      title: "Phew: Name this model",
      prompt: "The name in the model switcher",
      value:
        preset.provider === "vscode"
          ? model.label?.replace(/ \(.*\)$/, "") || model.id
          : `${preset.label} · ${model.id}`,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "Enter a name."),
    });
    if (!name) return undefined;

    const profile: ModelProfile = {
      ...draft,
      id: uniqueId(
        name,
        existing.map((item) => item.id),
      ),
      name: name.trim(),
      model: model.id,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    };
    if (key.value) await this.secrets.store(apiKeySecretName(profile.id), key.value);
    await this.save([...existing, profile]);
    await this.setActive(profile.id);
    this.log.info(`Model added: ${profile.id} (${profile.provider} ${profile.model})`);
    await this.test(profile);
    return profile;
  }

  /** Lists all models with actions: use, test, edit, change the key, and delete. */
  async manage(): Promise<void> {
    const testButton = { iconPath: new vscode.ThemeIcon("beaker"), tooltip: "Test connection" };
    const editButton = { iconPath: new vscode.ThemeIcon("edit"), tooltip: "Edit" };
    const keyButton = { iconPath: new vscode.ThemeIcon("key"), tooltip: "Set API key" };
    const deleteButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete" };
    type Item = vscode.QuickPickItem & { profile?: ModelProfile; action?: "add" | "json" };

    const quickPick = vscode.window.createQuickPick<Item>();
    quickPick.title = "Phew: Manage models";
    quickPick.placeholder = "Select a model to use it. Use the buttons to test, edit, set the key, or delete.";
    const refresh = () => {
      const active = this.active();
      quickPick.items = [
        { label: "$(add) Add model…", action: "add" },
        { label: "$(json) Edit models in settings.json", action: "json" },
        { label: "Models", kind: vscode.QuickPickItemKind.Separator },
        ...this.profiles().profiles.map((profile) => ({
          label: `${profile.id === active?.id ? "$(check)" : "$(blank)"} ${profile.name}`,
          description: `${providerNames[profile.provider]} · ${profile.model}`,
          detail: profile.baseUrl || undefined,
          profile,
          buttons:
            profile.provider === "vscode"
              ? [testButton, editButton, deleteButton]
              : [testButton, editButton, keyButton, deleteButton],
        })),
      ];
    };
    refresh();
    quickPick.onDidTriggerItemButton(async ({ item, button }) => {
      const profile = item.profile;
      if (!profile) return;
      quickPick.hide();
      if (button === testButton) await this.test(profile);
      else if (button === editButton) await this.edit(profile);
      else if (button === keyButton) await this.changeKey(profile);
      else if (button === deleteButton) await this.remove(profile);
    });
    quickPick.onDidAccept(async () => {
      const item = quickPick.selectedItems[0];
      quickPick.hide();
      if (item?.action === "add") await this.addModel();
      else if (item?.action === "json") await openModelsJson();
      else if (item?.profile) await this.setActive(item.profile.id);
    });
    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  }

  async test(profile: ModelProfile | undefined = this.active()): Promise<void> {
    if (!profile) {
      void vscode.window.showInformationMessage("Phew: add a model first.");
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Phew: testing ${profile.name}…`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        try {
          return await testConnection(await this.client(profile), controller.signal);
        } catch (error) {
          return {
            ok: false,
            toolCalling: false,
            milliseconds: 0,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    this.log.info(`Model test ${profile.id}: ok=${result.ok} tools=${result.toolCalling} ${result.milliseconds} ms`);
    if (result.ok && result.toolCalling) {
      void vscode.window.showInformationMessage(
        `Phew: ${profile.name} works (${result.milliseconds} ms). ${result.message}`,
      );
    } else if (result.ok) {
      void vscode.window.showWarningMessage(
        `Phew: ${profile.name} works, but ${result.message.charAt(0).toLowerCase()}${result.message.slice(1)}`,
      );
    } else {
      const answer = await vscode.window.showErrorMessage(
        `Phew: ${profile.name} failed. ${result.message}`,
        "Edit",
        "Set API Key",
      );
      if (answer === "Edit") await this.edit(profile);
      else if (answer === "Set API Key") await this.changeKey(profile);
    }
  }

  private async edit(profile: ModelProfile): Promise<void> {
    type Field = vscode.QuickPickItem & { field: string };
    const fields: Field[] = [
      { label: "Name", description: profile.name, field: "name" },
      { label: "Model", description: profile.model, field: "model" },
      ...(profile.provider === "vscode"
        ? []
        : [
            { label: "Base URL", description: profile.baseUrl, field: "baseUrl" },
            { label: "API key", description: "Stored in the VS Code secret storage", field: "key" },
            {
              label: "API key from environment variable",
              description: profile.apiKeyEnv ?? "Not set",
              field: "apiKeyEnv",
            },
            { label: "Auth style", description: profile.auth, field: "auth" },
            {
              label: "Temperature",
              description: profile.temperature?.toString() ?? "Provider default",
              field: "temperature",
            },
            {
              label: "Max output tokens",
              description: profile.maxTokens?.toString() ?? "Provider default",
              field: "maxTokens",
            },
            {
              label: "Price per million tokens",
              description: profile.price ? `$${profile.price.input} in / $${profile.price.output} out` : "Not set",
              field: "price",
            },
            { label: "Headers, query, and extra body", description: "Edit in settings.json", field: "json" },
          ]),
    ];
    const pick = await vscode.window.showQuickPick(fields, { title: `Phew: Edit ${profile.name}` });
    if (!pick) return;
    let next: ModelProfile | undefined;
    switch (pick.field) {
      case "name": {
        const value = await vscode.window.showInputBox({ title: "Name", value: profile.name });
        if (value?.trim()) next = { ...profile, name: value.trim() };
        break;
      }
      case "model": {
        const model = await pickModel(profile, await this.apiKey(profile));
        if (model) next = { ...profile, model: model.id };
        break;
      }
      case "baseUrl": {
        const value = await vscode.window.showInputBox({
          title: "Base URL",
          value: profile.baseUrl,
          validateInput: validateBaseUrl,
        });
        if (value) next = { ...profile, baseUrl: value.trim().replace(/\/+$/, "") };
        break;
      }
      case "key":
        await this.changeKey(profile);
        return;
      case "apiKeyEnv": {
        const value = await vscode.window.showInputBox({
          title: "Environment variable with the API key",
          prompt: "Leave empty to remove. A key in the secret storage wins.",
          value: profile.apiKeyEnv ?? "",
          validateInput: (input) =>
            input === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(input) ? undefined : "Use a valid variable name.",
        });
        if (value !== undefined) next = { ...profile, apiKeyEnv: value || undefined };
        break;
      }
      case "auth": {
        const styles = [
          { label: "bearer", description: "Authorization: Bearer KEY (OpenAI and most providers)" },
          { label: "api-key", description: "api-key: KEY (Azure OpenAI)" },
          { label: "x-api-key", description: "x-api-key: KEY (Anthropic)" },
          { label: "x-goog-api-key", description: "x-goog-api-key: KEY (Gemini)" },
          { label: "none", description: "No key" },
        ];
        const value = await vscode.window.showQuickPick(styles, { title: "Auth style" });
        if (value) next = { ...profile, auth: value.label as ModelProfile["auth"] };
        break;
      }
      case "temperature": {
        const value = await vscode.window.showInputBox({
          title: "Temperature (0 to 2). Leave empty for the provider default.",
          value: profile.temperature?.toString() ?? "",
          validateInput: (input) =>
            input === "" || (Number(input) >= 0 && Number(input) <= 2) ? undefined : "Enter 0 to 2.",
        });
        if (value !== undefined) next = { ...profile, temperature: value === "" ? undefined : Number(value) };
        break;
      }
      case "maxTokens": {
        const value = await vscode.window.showInputBox({
          title: "Max output tokens. Leave empty for the default.",
          value: profile.maxTokens?.toString() ?? "",
          validateInput: (input) =>
            input === "" || (Number.isInteger(Number(input)) && Number(input) > 0)
              ? undefined
              : "Enter a whole number.",
        });
        if (value !== undefined) next = { ...profile, maxTokens: value === "" ? undefined : Number(value) };
        break;
      }
      case "price": {
        const value = await vscode.window.showInputBox({
          title: "Price per million tokens in US dollars: input, output",
          prompt: "Example: 3, 15. Check the current prices of your provider. Leave empty to remove.",
          value: profile.price ? `${profile.price.input}, ${profile.price.output}` : "",
          validateInput: (input) =>
            input === "" || /^\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*$/.test(input) ? undefined : "Use the format 3, 15.",
        });
        if (value !== undefined) {
          const [input, output] = value.split(",").map((part) => Number(part.trim()));
          next = { ...profile, price: value === "" ? undefined : { input, output } };
        }
        break;
      }
      case "json":
        await openModelsJson();
        return;
    }
    if (next) {
      await this.replace(next);
      if (["model", "baseUrl", "auth"].includes(pick.field)) await this.test(next);
    }
  }

  private async changeKey(profile: ModelProfile): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: `Phew: API key for ${profile.name}`,
      prompt: "Phew stores the key in the VS Code secret storage. Leave empty to delete the saved key.",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value.trim()) await this.secrets.store(apiKeySecretName(profile.id), value.trim());
    else await this.secrets.delete(apiKeySecretName(profile.id));
    void vscode.window.showInformationMessage(
      `Phew: ${value.trim() ? "saved" : "deleted"} the API key of ${profile.name}.`,
    );
  }

  private async remove(profile: ModelProfile): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Delete the model "${profile.name}" and its saved API key?`,
      { modal: true },
      "Delete",
    );
    if (answer !== "Delete") return;
    await this.secrets.delete(apiKeySecretName(profile.id));
    await this.save(this.profiles().profiles.filter((item) => item.id !== profile.id));
  }

  private async replace(profile: ModelProfile): Promise<void> {
    await this.save(this.profiles().profiles.map((item) => (item.id === profile.id ? profile : item)));
  }

  private async save(profiles: readonly ModelProfile[]): Promise<void> {
    await vscode.workspace
      .getConfiguration(section)
      .update("models", profiles.map(serializeProfile), vscode.ConfigurationTarget.Global);
  }
}

async function openModelsJson(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openSettingsJson", { revealSetting: { key: "phew.models" } });
}

async function pickPreset(): Promise<ProviderPreset | undefined> {
  type Item = vscode.QuickPickItem & { preset?: ProviderPreset };
  const groups: ProviderPreset["group"][] = ["Editor", "Cloud", "Gateway", "Local"];
  const items: Item[] = [];
  for (const group of groups) {
    items.push({ label: group === "Editor" ? "No API key" : group, kind: vscode.QuickPickItemKind.Separator });
    for (const preset of providerPresets.filter((item) => item.group === group)) {
      const env = preset.keyEnv && process.env[preset.keyEnv] ? ` · ${preset.keyEnv} found` : "";
      items.push({
        label: preset.label,
        description: `${providerNames[preset.provider]}${env}`,
        detail: preset.description,
        preset,
      });
    }
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: "Phew: Add a model (1/4) — choose a provider",
    placeHolder: "Type to search, for example Claude, Gemini, Ollama, or Azure",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return pick?.preset;
}

/** Asks how to provide the API key. Returns undefined when the user cancels. */
async function askForKey(preset: ProviderPreset): Promise<{ value?: string; env?: string } | undefined> {
  if (preset.provider === "vscode" || preset.auth === "none") return {};
  type Item = vscode.QuickPickItem & { choice: "enter" | "env" | "open" | "none" };
  const envFound = preset.keyEnv && process.env[preset.keyEnv];
  const items: Item[] = [
    { label: "$(key) Enter the API key", description: "Stored in the VS Code secret storage", choice: "enter" },
    ...(preset.keyEnv
      ? [
          {
            label: `$(terminal) Use the environment variable ${preset.keyEnv}`,
            description: envFound ? "Found" : "Not set in this VS Code window",
            choice: "env" as const,
          },
        ]
      : []),
    ...(preset.keyUrl
      ? [{ label: "$(link-external) Create a key on the provider website", choice: "open" as const }]
      : []),
    ...(!preset.needsKey ? [{ label: "$(circle-slash) No key", choice: "none" as const }] : []),
  ];
  for (;;) {
    const pick = await vscode.window.showQuickPick(items, {
      title: "Phew: Add a model (2/4) — API key",
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.choice === "none") return {};
    if (pick.choice === "env") return { env: preset.keyEnv };
    if (pick.choice === "open" && preset.keyUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(preset.keyUrl));
      continue;
    }
    const value = await vscode.window.showInputBox({
      title: `Phew: ${preset.label} API key`,
      prompt: "Paste the key. Phew stores it in the VS Code secret storage, not in the settings.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : "Paste the key, or press Escape to go back."),
    });
    if (value === undefined) continue;
    return { value: value.trim() };
  }
}

/** Loads the model list from the provider and lets the user pick one or type a name. */
async function pickModel(profile: ModelProfile, apiKey: string | undefined): Promise<ModelInfo | undefined> {
  let models: ModelInfo[] = [];
  let failure: string | undefined;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Phew: loading models…", cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        models =
          profile.provider === "vscode"
            ? await listVsCodeModels()
            : await listModels(profile, apiKey, fetch, controller.signal);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
    },
  );
  if (profile.provider === "vscode" && models.length === 0) {
    void vscode.window.showWarningMessage(
      "Phew: VS Code has no language models. Install and sign in to GitHub Copilot, or choose another provider.",
    );
    return undefined;
  }
  type Item = vscode.QuickPickItem & { model?: ModelInfo; manual?: boolean };
  const items: Item[] = [
    {
      label: "$(edit) Enter a model name…",
      detail: failure ? `Could not load the list: ${failure}` : undefined,
      manual: true,
    },
    ...(models.length > 0 ? [{ label: `${models.length} models`, kind: vscode.QuickPickItemKind.Separator }] : []),
    ...models.map((model) => ({
      label: model.id,
      description: model.label && model.label !== model.id ? model.label : undefined,
      picked: model.id === profile.model,
      model,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Phew: Add a model (3/4) — choose a model",
    placeHolder: models.length > 0 ? "Type to filter" : "Enter the model name",
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!pick) return undefined;
  if (pick.model) return pick.model;
  const value = await vscode.window.showInputBox({
    title: "Phew: Model name",
    prompt: "The exact model name of the provider",
    value: profile.model,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : "Enter a model name."),
  });
  return value ? { id: value.trim() } : undefined;
}
