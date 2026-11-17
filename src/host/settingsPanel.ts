import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { describeCommitIdentity } from "../core/commit";
import type { CodeIndexManager } from "./codeIndexManager";
import { gitIdentity } from "./git";
import { escapeHtml } from "./html";
import type { MemoryStore } from "./memoryStore";
import { type ModelManager, providerNames } from "./models";
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

  async show(focus?: string): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      if (focus) void this.panel.webview.postMessage({ type: "focus", section: focus });
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
<title>Phew Settings</title></head><body><div id="app" data-focus="${escapeHtml(focus ?? "")}"></div>
<script nonce="${nonce}" src="${escapeHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, "settings.js")).toString())}"></script>
</body></html>`;
    panel.webview.onDidReceiveMessage((message: unknown) => void this.handle(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel = panel;
  }

  private async handle(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as { type?: unknown; key?: unknown; value?: unknown; command?: unknown; id?: unknown };
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
          await vscode.commands.executeCommand(message.command);
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
      case "testModel": {
        const profile = this.models.profiles().profiles.find((item) => item.id === message.id);
        if (profile) await this.models.test(profile);
        return;
      }
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
      models: this.models.profiles().profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        detail: `${providerNames[profile.provider]} · ${profile.model}${profile.baseUrl ? ` · ${profile.baseUrl}` : ""}`,
        active: profile.id === active?.id,
      })),
      identity: folder
        ? describeCommitIdentity(settings.commit, await gitIdentity(folder.uri.fsPath))
        : "Open a folder to see the Git identity.",
      index: status
        ? `${status.files} files, ${status.chunks} chunks${status.building ? ", updating…" : ""}`
        : "No folder",
      memory: folder ? await this.memory.read(folder.uri) : [],
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
