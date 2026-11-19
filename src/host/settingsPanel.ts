import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { describeCommitIdentity } from "../core/commit";
import { apiFor } from "../providers/factory";
import { providerPresets } from "../providers/presets";
import type { CodeIndexManager } from "./codeIndexManager";
import { gitIdentity } from "./git";
import { escapeHtml } from "./html";
import type { MemoryStore } from "./memoryStore";
import { type ModelManager, piCopilotToken, providerNames } from "./models";
import { readSettings, updateSetting } from "./settings";
import type { StatsStore } from "./statsStore";

interface SchemaProperty {
  readonly type?: string | string[];
  readonly enum?: readonly unknown[];
  readonly enumDescriptions?: readonly string[];
  readonly markdownDescription?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: { readonly type?: string };
}

interface Category {
  readonly title: string;
  readonly properties: Record<string, SchemaProperty>;
}

const commands = new Set([
  "phew.addModel",
  "phew.manageModels",
  "phew.testModel",
  "phew.openMemory",
  "phew.rebuildIndex",
  "phew.openWalkthrough",
  "phew.showStats",
  "phew.openChat",
  "phew.manageMcp",
  "phew.editAssistant",
  "phew.showWrapped",
]);

const hiddenKeys = new Set(["phew.models", "phew.activeModel"]);

/** A settings page with all Phew options, the models, the commit identity, the index, and the memory. */
export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly models: ModelManager,
    private readonly index: CodeIndexManager,
    private readonly memory: MemoryStore,
    private readonly stats: StatsStore,
  ) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("phew")) void this.refresh();
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
  }

  /** Opens the settings at a section, and with `provider`, with that provider selected for setup. */
  async show(focus?: string, provider?: string): Promise<void> {
    const preset = providerPresets.find((item) => item.id === provider)?.id;
    if (this.panel) {
      this.panel.reveal();
      if (focus) void this.panel.webview.postMessage({ type: "focus", section: focus });
      if (preset) void this.panel.webview.postMessage({ type: "selectProvider", id: preset });
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel("phew.settings", "Phew Settings", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media, dist, vscode.Uri.joinPath(this.context.extensionUri, "resources")],
      retainContextWhenHidden: false,
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "icon.png");
    const nonce = randomBytes(18).toString("base64url");
    const csp = `default-src 'none'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'`;
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "settings.css")).toString())}">
<title>Phew Settings</title></head><body data-icon="${escapeHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "icon.png")).toString())}"><div id="app" data-focus="${escapeHtml(focus ?? "")}" data-provider="${escapeHtml(preset ?? "")}"></div>
<script nonce="${nonce}" src="${escapeHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, "settings.js")).toString())}"></script>
</body></html>`;
    panel.webview.onDidReceiveMessage((message: unknown) => void this.handle(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel = panel;
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Model setup without quick picks: everything happens on the page. */
  private async handleModels(message: Record<string, unknown>): Promise<boolean> {
    const text = (key: string, max = 2000) =>
      typeof message[key] === "string" && (message[key] as string).length <= max ? (message[key] as string) : undefined;
    const requestId = text("requestId", 64);
    const id = text("id", 64);
    const profile = id ? this.models.profiles().profiles.find((item) => item.id === id) : undefined;
    const preset = providerPresets.find((item) => item.id === text("presetId", 64));
    const endpoints = Array.isArray(message.endpoints)
      ? message.endpoints.filter((item): item is string => typeof item === "string")
      : undefined;
    const draft = () => {
      if (!preset) throw new Error("Choose a provider.");
      return this.models.draftProfile(preset.id, {
        baseUrl: text("baseUrl"),
        apiKeyEnv: message.useEnv === true ? preset.keyEnv : undefined,
        model: text("model", 300),
        name: text("name", 120),
        api: apiFor({ id: "", endpoints }),
      });
    };
    const key = async () => (message.usePi === true ? await piCopilotToken() : text("apiKey", 4000));
    try {
      switch (message.type) {
        case "providers":
          this.post({ type: "providers", items: await this.models.detectProviders() });
          return true;
        case "loadModels": {
          const probe = text("baseUrl") ? [] : (preset?.probeBaseUrls ?? []);
          const result = await this.models.modelsFor(draft(), await key(), probe);
          this.post({ type: "models", requestId, ok: true, models: result.models, baseUrl: result.baseUrl });
          return true;
        }
        case "createModel": {
          const contextWindow = typeof message.contextWindow === "number" ? message.contextWindow : undefined;
          const result = await this.models.create(draft(), await key(), contextWindow);
          this.post({ type: "created", requestId, ok: true, id: result.profile.id, test: result.test });
          await this.refresh();
          return true;
        }
        case "testModel":
          if (profile) this.post({ type: "testResult", id: profile.id, result: await this.models.check(profile) });
          return true;
        case "setKey":
          if (profile) {
            await this.models.setKey(profile.id, text("key", 4000) ?? "");
            await this.refresh();
            this.post({ type: "testResult", id: profile.id, result: await this.models.check(profile) });
          }
          return true;
        case "removeModel":
          if (profile) {
            const answer = await vscode.window.showWarningMessage(
              `Remove "${profile.name}" and its saved API key?`,
              { modal: true },
              "Remove",
            );
            if (answer === "Remove") await this.models.delete(profile.id);
            await this.refresh();
          }
          return true;
        case "updateModel": {
          if (!profile) return true;
          const field = text("field", 40);
          const value = message.value;
          const number = (min: number, max: number) =>
            value === null || value === ""
              ? undefined
              : typeof value === "number" && value >= min && value <= max
                ? value
                : Number.NaN;
          let changes: Partial<typeof profile> | undefined;
          if (field === "name" && typeof value === "string" && value.trim())
            changes = { name: value.trim().slice(0, 120) };
          if (field === "model" && typeof value === "string" && value.trim()) changes = { model: value.trim() };
          if (field === "temperature") changes = { temperature: number(0, 2) };
          if (field === "maxTokens") changes = { maxTokens: number(1, 10_000_000) };
          if (field === "contextWindow") changes = { contextWindow: number(1000, 100_000_000) };
          if (field === "api" && (value === "chat" || value === "responses"))
            changes = { api: value === "responses" ? "responses" : undefined };
          if (field === "price" && (value === null || (typeof value === "object" && value !== null))) {
            const price = value as { input?: unknown; output?: unknown } | null;
            changes = {
              price:
                price &&
                typeof price.input === "number" &&
                typeof price.output === "number" &&
                price.input >= 0 &&
                price.output >= 0
                  ? { input: price.input, output: price.output }
                  : undefined,
            };
          }
          if (!changes || Object.values(changes).some((item) => typeof item === "number" && Number.isNaN(item))) {
            this.post({ type: "error", key: `model:${profile.id}:${field}`, text: "This value is not valid." });
            return true;
          }
          await this.models.update(profile.id, changes);
          return true;
        }
        default:
          return false;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.post({
        type: requestId ? (message.type === "loadModels" ? "models" : "created") : "error",
        requestId,
        ok: false,
        error: reason,
        text: reason,
      });
      return true;
    }
  }

  private async handle(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    if (await this.handleModels(raw as Record<string, unknown>)) return;
    const message = raw as {
      type?: unknown;
      key?: unknown;
      value?: unknown;
      command?: unknown;
      id?: unknown;
      args?: unknown;
    };
    switch (message.type) {
      case "ready":
        await this.refresh();
        return;
      case "set": {
        const key = typeof message.key === "string" ? message.key : "";
        const property = this.properties().get(key);
        if (!property || hiddenKeys.has(key)) return;
        if (!valid(property, message.value)) {
          void this.panel?.webview.postMessage({ type: "error", key, text: "This value is not valid." });
          return;
        }
        await updateSetting(key.slice("phew.".length), message.value);
        return;
      }
      case "reset": {
        const key = typeof message.key === "string" ? message.key : "";
        if (this.properties().has(key) && !hiddenKeys.has(key))
          await updateSetting(key.slice("phew.".length), undefined);
        return;
      }
      case "command":
        if (typeof message.command === "string" && commands.has(message.command)) {
          const args = Array.isArray(message.args)
            ? (message.args as unknown[]).filter((arg): arg is string => typeof arg === "string" && arg.length <= 40)
            : [];
          await vscode.commands.executeCommand(message.command, ...args);
          await this.refresh();
        }
        return;
      case "useModel":
        if (
          typeof message.id === "string" &&
          this.models.profiles().profiles.some((profile) => profile.id === message.id)
        ) {
          await this.models.setActive(message.id);
        }
        return;
      case "openJson":
        await vscode.commands.executeCommand("workbench.action.openSettingsJson");
        return;
    }
  }

  private categories(): Category[] {
    const configuration = this.context.extension.packageJSON.contributes.configuration as Category[];
    return configuration.map((category) => ({
      title: category.title,
      properties: Object.fromEntries(Object.entries(category.properties).filter(([key]) => !hiddenKeys.has(key))),
    }));
  }

  private properties(): Map<string, SchemaProperty> {
    const map = new Map<string, SchemaProperty>();
    for (const category of this.context.extension.packageJSON.contributes.configuration as Category[]) {
      for (const [key, value] of Object.entries(category.properties)) map.set(key, value);
    }
    return map;
  }

  private async refresh(): Promise<void> {
    if (!this.panel) return;
    const config = vscode.workspace.getConfiguration();
    const values: Record<string, unknown> = {};
    const modified: string[] = [];
    for (const key of this.properties().keys()) {
      values[key] = config.get(key);
      const inspect = config.inspect(key);
      if (inspect?.globalValue !== undefined || inspect?.workspaceValue !== undefined) modified.push(key);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const settings = readSettings();
    const active = this.models.active();
    const status = folder ? this.index.status(folder.uri) : undefined;
    void this.panel.webview.postMessage({
      type: "init",
      categories: this.categories(),
      values,
      modified,
      models: await Promise.all(
        this.models.profiles().profiles.map(async (profile) => ({
          id: profile.id,
          name: profile.name,
          provider: providerNames[profile.provider],
          model: profile.model,
          baseUrl: profile.baseUrl,
          active: profile.id === active?.id,
          needsKey: profile.provider !== "vscode" && profile.auth !== "none",
          key: await this.models.hasKey(profile),
          keyEnv: profile.apiKeyEnv,
          temperature: profile.temperature ?? null,
          maxTokens: profile.maxTokens ?? null,
          contextWindow: profile.contextWindow ?? null,
          price: profile.price ?? null,
          api: profile.provider === "openai" ? (profile.api ?? "chat") : null,
        })),
      ),
      identity: folder
        ? describeCommitIdentity(settings.commit, await gitIdentity(folder.uri.fsPath))
        : "Open a folder to see the Git identity.",
      index: status
        ? `${status.files} files, ${status.chunks} chunks${status.building ? ", updating…" : ""}`
        : "No folder",
      memory: folder ? await this.memory.read(folder.uri) : [],
      personalMemory: await this.memory.read(folder?.uri ?? vscode.Uri.file("/"), "personal"),
      stats: this.stats.details(settings.minutesPerBug),
    });
  }
}

function valid(property: SchemaProperty, value: unknown): boolean {
  const types = Array.isArray(property.type) ? property.type : [property.type];
  if (value === null) return types.includes("null");
  if (property.enum) return property.enum.includes(value);
  if (types.includes("boolean") && typeof value === "boolean") return true;
  if ((types.includes("number") || types.includes("integer")) && typeof value === "number" && Number.isFinite(value)) {
    if (types.includes("integer") && !Number.isInteger(value)) return false;
    return (
      (property.minimum === undefined || value >= property.minimum) &&
      (property.maximum === undefined || value <= property.maximum)
    );
  }
  if (types.includes("string") && typeof value === "string") return value.length <= 10_000;
  if (types.includes("array") && Array.isArray(value)) {
    return property.items?.type !== "string" || value.every((item) => typeof item === "string");
  }
  if (types.includes("object") && typeof value === "object" && !Array.isArray(value))
    return JSON.stringify(value).length <= 100_000;
  return false;
}
