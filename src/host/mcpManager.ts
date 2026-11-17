import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import * as os from "node:os";
import * as vscode from "vscode";
import type { ToolDefinition } from "../core/chat";
import { LineBuffer, McpClient, type McpTool, mcpToolName } from "../core/mcp";
import {
  type McpInput,
  type McpServerConfig,
  type McpServerEntry,
  parseMcpFile,
  parseServer,
  resolveServer,
  usedInputs,
} from "../core/mcpConfig";
import { HttpTransport, McpAuthRequiredError } from "../core/mcpHttp";
import {
  authorizationUrl,
  createPkce,
  discover,
  exchangeCode,
  isExpired,
  type OAuthTokens,
  refreshTokens,
  registerClient,
} from "../core/oauth";
import { readSettings, updateSetting } from "./settings";

interface Connection {
  readonly entry: McpServerEntry;
  readonly client: McpClient;
  readonly process?: ChildProcess;
  readonly tools: readonly McpTool[];
}

export interface McpToolBinding {
  readonly definition: ToolDefinition;
  readonly server: string;
  readonly tool: string;
}

export type McpState = "connected" | "failed" | "disabled" | "sign-in" | "not started";

export interface McpServerStatus {
  readonly entry: McpServerEntry;
  readonly state: McpState;
  readonly tools: readonly string[];
  readonly error?: string;
}

const oauthKey = (url: string) => `phew.mcp.oauth.${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
const inputKey = (id: string) => `phew.mcp.input.${id}`;

/** Starts MCP servers on demand, exposes their tools, and manages sign-in, tool filters, and logs. */
export class McpManager implements vscode.Disposable {
  private readonly connections = new Map<string, Connection>();
  private readonly failures = new Map<string, { state: McpState; error: string }>();
  private bindings = new Map<string, McpToolBinding>();
  private configKey = "";
  private connecting: Promise<void> | undefined;
  readonly log = vscode.window.createOutputChannel("Phew MCP", { log: true });

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly version: string,
  ) {}

  /** All configured servers. Workspace files are read only in trusted workspaces. */
  async entries(root?: vscode.Uri): Promise<{ servers: McpServerEntry[]; inputs: McpInput[] }> {
    const settings = readSettings(root);
    const servers: McpServerEntry[] = [];
    const inputs: McpInput[] = [];
    for (const [name, value] of Object.entries(settings.mcpServers)) {
      const config = parseServer(value);
      if (config) servers.push({ name, source: "settings", config });
    }
    if (root && vscode.workspace.isTrusted && settings.mcpReadWorkspaceConfigs) {
      for (const [path, source] of [
        [".vscode/mcp.json", ".vscode/mcp.json"],
        [".mcp.json", ".mcp.json"],
      ] as const) {
        try {
          const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, path)));
          const parsed = parseMcpFile(text, source);
          servers.push(...parsed.servers);
          inputs.push(...parsed.inputs);
        } catch {
          // The file does not exist.
        }
      }
    }
    const seen = new Set<string>();
    return {
      servers: servers.filter((server) => {
        if (seen.has(server.name)) return false;
        seen.add(server.name);
        return true;
      }),
      inputs,
    };
  }

  /** Connects to the enabled servers when the configuration changed and returns the enabled tools. */
  async tools(root: vscode.Uri | undefined): Promise<McpToolBinding[]> {
    const { servers, inputs } = await this.entries(root);
    const settings = readSettings(root);
    const enabled = servers.filter((server) => !settings.mcpDisabledServers.includes(server.name));
    const key = JSON.stringify({ enabled, root: root?.fsPath });
    if (key !== this.configKey) {
      if (this.connecting) await this.connecting;
      if (key !== this.configKey) {
        this.connecting = this.reconnect(enabled, inputs, root).finally(() => {
          this.connecting = undefined;
        });
        this.configKey = key;
      }
    }
    if (this.connecting) await this.connecting;
    this.rebuildBindings();
    return [...this.bindings.values()];
  }

  binding(name: string): McpToolBinding | undefined {
    return this.bindings.get(name);
  }

  async call(binding: McpToolBinding, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const connection = this.connections.get(binding.server);
    if (!connection) throw new Error(`The MCP server "${binding.server}" is not connected.`);
    this.log.info(`[${binding.server}] call ${binding.tool}`);
    const result = await connection.client.callTool(binding.tool, args);
    if (result.isError)
      this.log.warn(`[${binding.server}] ${binding.tool} returned an error: ${result.text.slice(0, 300)}`);
    return result;
  }

  async status(root: vscode.Uri | undefined): Promise<McpServerStatus[]> {
    const { servers } = await this.entries(root);
    const disabled = readSettings(root).mcpDisabledServers;
    return servers.map((entry) => {
      if (disabled.includes(entry.name)) return { entry, state: "disabled" as const, tools: [] };
      const connection = this.connections.get(entry.name);
      if (connection) return { entry, state: "connected" as const, tools: connection.tools.map((tool) => tool.name) };
      const failure = this.failures.get(entry.name);
      return failure
        ? { entry, state: failure.state, tools: [], error: failure.error }
        : { entry, state: "not started" as const, tools: [] };
    });
  }

  /** A quick pick to enable servers, choose tools, restart, sign in, and read the logs. */
  async manage(root: vscode.Uri | undefined): Promise<void> {
    await this.tools(root).catch(() => undefined);
    const statuses = await this.status(root);
    type Item = vscode.QuickPickItem & { status?: McpServerStatus; action?: "logs" | "settings" | "file" };
    const icons: Record<McpState, string> = {
      connected: "$(pass-filled)",
      failed: "$(error)",
      disabled: "$(circle-slash)",
      "sign-in": "$(account)",
      "not started": "$(circle-outline)",
    };
    const items: Item[] = [
      ...statuses.map((status) => ({
        label: `${icons[status.state]} ${status.entry.name}`,
        description: `${status.entry.config.type} · ${status.entry.source} · ${status.state}${status.tools.length > 0 ? ` · ${status.tools.length} tools` : ""}`,
        detail: status.error,
        status,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(output) Show MCP logs", action: "logs" },
      { label: "$(json) Add a server in .vscode/mcp.json", action: "file" },
      { label: "$(settings) Add a server in the Phew settings", action: "settings" },
    ];
    if (statuses.length === 0)
      items.unshift({ label: "No MCP servers are configured.", kind: vscode.QuickPickItemKind.Separator });
    const pick = await vscode.window.showQuickPick(items, {
      title: "Phew: MCP servers",
      placeHolder: "Select a server to manage it",
    });
    if (!pick) return;
    if (pick.action === "logs") this.log.show();
    else if (pick.action === "settings")
      await vscode.commands.executeCommand("workbench.action.openSettingsJson", {
        revealSetting: { key: "phew.mcp.servers" },
      });
    else if (pick.action === "file" && root) {
      const uri = vscode.Uri.joinPath(root, ".vscode", "mcp.json");
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(
            '{\n  "servers": {\n    // "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" }\n  }\n}\n',
          ),
        );
      }
      await vscode.window.showTextDocument(uri);
    } else if (pick.status) await this.serverActions(pick.status, root);
  }

  async restartAll(): Promise<void> {
    this.disconnect();
    this.configKey = "";
  }

  dispose(): void {
    this.disconnect();
    this.log.dispose();
  }

  private async serverActions(status: McpServerStatus, root: vscode.Uri | undefined): Promise<void> {
    const name = status.entry.name;
    const settings = readSettings(root);
    const disabled = settings.mcpDisabledServers.includes(name);
    const actions = [
      ...(status.state === "connected" ? [{ label: "$(tools) Choose tools", action: "tools" }] : []),
      { label: disabled ? "$(check) Enable server" : "$(circle-slash) Disable server", action: "toggle" },
      { label: "$(refresh) Restart", action: "restart" },
      ...(status.entry.config.type === "http"
        ? [
            { label: "$(account) Sign in", action: "signin" },
            { label: "$(sign-out) Sign out", action: "signout" },
          ]
        : []),
      { label: "$(output) Show logs", action: "logs" },
    ];
    const pick = await vscode.window.showQuickPick(actions, { title: `Phew: MCP server ${name}` });
    if (!pick) return;
    if (pick.action === "toggle") {
      await updateSetting(
        "mcp.disabledServers",
        disabled ? settings.mcpDisabledServers.filter((item) => item !== name) : [...settings.mcpDisabledServers, name],
      );
      await this.restartAll();
    } else if (pick.action === "restart") await this.restartAll();
    else if (pick.action === "logs") this.log.show();
    else if (pick.action === "signout") {
      if (status.entry.config.type === "http") await this.secrets.delete(oauthKey(status.entry.config.url));
      await this.restartAll();
      void vscode.window.showInformationMessage(`Phew: signed out of ${name}.`);
    } else if (pick.action === "signin" && status.entry.config.type === "http") {
      await this.signIn(status.entry.config.url, null);
      await this.restartAll();
    } else if (pick.action === "tools") {
      const blocked = settings.mcpDisabledTools[name] ?? [];
      const chosen = await vscode.window.showQuickPick(
        status.tools.map((tool) => ({ label: tool, picked: !blocked.includes(tool) })),
        {
          title: `Phew: tools of ${name}`,
          canPickMany: true,
          placeHolder: "Selected tools are available to the agent",
        },
      );
      if (!chosen) return;
      const keep = new Set(chosen.map((item) => item.label));
      await updateSetting("mcp.disabledTools", {
        ...settings.mcpDisabledTools,
        [name]: status.tools.filter((tool) => !keep.has(tool)),
      });
      this.rebuildBindings();
    }
  }

  private disconnect(): void {
    for (const connection of this.connections.values()) {
      connection.client.close();
      connection.process?.kill();
    }
    this.connections.clear();
    this.bindings.clear();
  }

  private rebuildBindings(): void {
    const disabledTools = readSettings().mcpDisabledTools;
    this.bindings = new Map();
    for (const connection of this.connections.values()) {
      const blocked = disabledTools[connection.entry.name] ?? [];
      for (const tool of connection.tools) {
        if (blocked.includes(tool.name)) continue;
        const name = mcpToolName(connection.entry.name, tool.name);
        this.bindings.set(name, {
          server: connection.entry.name,
          tool: tool.name,
          definition: {
            name,
            description: `[MCP ${connection.entry.name}] ${tool.description}`.slice(0, 1000),
            parameters: tool.inputSchema,
          },
        });
      }
    }
  }

  private async reconnect(
    servers: readonly McpServerEntry[],
    inputs: readonly McpInput[],
    root: vscode.Uri | undefined,
  ): Promise<void> {
    this.disconnect();
    this.failures.clear();
    for (const entry of servers) {
      try {
        const config = await this.resolve(entry, inputs, root);
        const connection = await this.connect(entry, config, root);
        this.connections.set(entry.name, connection);
        this.log.info(`[${entry.name}] connected (${entry.config.type}) with ${connection.tools.length} tools.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state: McpState = error instanceof McpAuthRequiredError ? "sign-in" : "failed";
        this.failures.set(entry.name, { state, error: message });
        this.log.error(`[${entry.name}] ${message}`);
        if (state === "sign-in" && entry.config.type === "http") {
          const config = entry.config;
          const answer = await vscode.window.showInformationMessage(
            `Phew: the MCP server "${entry.name}" needs you to sign in.`,
            "Sign In",
          );
          if (answer === "Sign In") {
            await this.signIn(config.url, error instanceof McpAuthRequiredError ? error.wwwAuthenticate : null);
            this.configKey = "";
          }
        }
      }
    }
  }

  /** Resolves variables. Missing `${input:...}` values are asked once and kept in the secret storage. */
  private async resolve(
    entry: McpServerEntry,
    inputs: readonly McpInput[],
    root: vscode.Uri | undefined,
  ): Promise<McpServerConfig> {
    const values: Record<string, string> = {};
    for (const id of usedInputs(entry.config)) {
      let value = await this.secrets.get(inputKey(id));
      if (value === undefined) {
        const input = inputs.find((item) => item.id === id);
        value = await vscode.window.showInputBox({
          title: `Phew: MCP server ${entry.name}`,
          prompt: input?.description ?? id,
          password: input?.password ?? true,
          ignoreFocusOut: true,
        });
        if (value === undefined) throw new Error(`The input "${id}" is missing.`);
        await this.secrets.store(inputKey(id), value);
      }
      values[id] = value;
    }
    return resolveServer(entry.config, {
      workspaceFolder: root?.fsPath,
      userHome: os.homedir(),
      env: process.env,
      inputs: values,
    });
  }

  private async connect(
    entry: McpServerEntry,
    config: McpServerConfig,
    root: vscode.Uri | undefined,
  ): Promise<Connection> {
    if (config.type === "http") {
      const transport = new HttpTransport(
        config.url,
        () => this.httpHeaders(config),
        (message) => this.log.warn(`[${entry.name}] ${message}`),
      );
      const client = new McpClient(transport);
      try {
        await client.initialize(this.version);
        return { entry, client, tools: await client.listTools() };
      } catch (error) {
        client.close();
        throw transport.authError ?? error;
      }
    }
    const child = spawn(config.command, [...config.args], {
      cwd: config.cwd ?? root?.fsPath,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    const listeners: ((line: string) => void)[] = [];
    const lines = new LineBuffer((line) => {
      for (const listener of listeners) listener(line);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => lines.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.log.debug(`[${entry.name}] ${chunk.trim()}`));
    const client = new McpClient({
      send: (line) => child.stdin?.write(`${line}\n`),
      onLine: (listener) => listeners.push(listener),
      close: () => child.stdin?.end(),
    });
    const exited = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(error));
      child.once("exit", (code) => reject(new Error(`The process exited with code ${code}.`)));
    });
    exited.catch(() => undefined);
    try {
      await Promise.race([client.initialize(this.version), exited]);
      const tools = await Promise.race([client.listTools(), exited]);
      return { entry, client, process: child, tools };
    } catch (error) {
      client.close();
      child.kill();
      throw error;
    }
  }

  private async httpHeaders(config: Extract<McpServerConfig, { type: "http" }>): Promise<Record<string, string>> {
    const raw = await this.secrets.get(oauthKey(config.url));
    if (!raw) return { ...config.headers };
    let tokens = JSON.parse(raw) as OAuthTokens;
    if (isExpired(tokens) && tokens.refreshToken) {
      try {
        tokens = await refreshTokens(tokens);
        await this.secrets.store(oauthKey(config.url), JSON.stringify(tokens));
      } catch (error) {
        this.log.warn(`Token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ...config.headers, Authorization: `Bearer ${tokens.accessToken}` };
  }

  /** The OAuth authorization code flow with PKCE and a loopback redirect, forwarded by VS Code in remote windows. */
  private async signIn(url: string, wwwAuthenticate: string | null): Promise<void> {
    const metadata = await discover(url, wwwAuthenticate);
    const state = randomBytes(16).toString("base64url");
    const { verifier, challenge } = createPkce();
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const local = vscode.Uri.parse(`http://127.0.0.1:${port}/callback`);
      const redirectUri = (await vscode.env.asExternalUri(local)).toString(true).replace(/\/$/, "");
      const clientId = await registerClient(metadata, redirectUri);
      const code = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The sign-in timed out.")), 5 * 60_000);
        server.on("request", (request, response) => {
          const query = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).searchParams;
          const ok = query.get("state") === state && query.get("code");
          response.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
          response.end(ok ? "<h2>Phew: signed in. You can close this tab.</h2>" : "<h2>Phew: the sign-in failed.</h2>");
          if (!ok) return;
          clearTimeout(timer);
          resolve(query.get("code") as string);
        });
      });
      await vscode.env.openExternal(
        vscode.Uri.parse(authorizationUrl(metadata, { clientId, redirectUri, challenge, state, resource: url })),
      );
      const tokens = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Phew: waiting for the sign-in in the browser…",
          cancellable: true,
        },
        async (_progress, token) =>
          exchangeCode(metadata, {
            code: await Promise.race([
              code,
              new Promise<string>((_, reject) =>
                token.onCancellationRequested(() => reject(new Error("Sign-in cancelled."))),
              ),
            ]),
            verifier,
            clientId,
            redirectUri,
            resource: url,
          }),
      );
      await this.secrets.store(oauthKey(url), JSON.stringify(tokens));
      this.log.info(`Signed in to ${new URL(url).host}.`);
      void vscode.window.showInformationMessage("Phew: signed in to the MCP server.");
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Phew: MCP sign-in failed. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      server.close();
    }
  }
}
