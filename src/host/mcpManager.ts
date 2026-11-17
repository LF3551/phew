import { type ChildProcess, spawn } from "node:child_process";
import type * as vscode from "vscode";
import type { ToolDefinition } from "../core/chat";
import { LineBuffer, McpClient, type McpTool, mcpToolName } from "../core/mcp";
import type { McpServerConfig } from "./settings";

interface Connection {
  readonly server: string;
  readonly client: McpClient;
  readonly process: ChildProcess;
  readonly tools: readonly McpTool[];
}

export interface McpToolBinding {
  readonly definition: ToolDefinition;
  readonly server: string;
  readonly tool: string;
}

/** Starts the configured MCP servers on demand and exposes their tools to the agent. */
export class McpManager {
  private connections = new Map<string, Connection>();
  private bindings = new Map<string, McpToolBinding>();
  private configKey = "";

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly version: string,
  ) {}

  /** Connects to the servers when the configuration changed and returns the tool definitions. */
  async tools(servers: Readonly<Record<string, McpServerConfig>>, cwd: string): Promise<McpToolBinding[]> {
    const key = JSON.stringify(servers);
    if (key !== this.configKey) {
      this.dispose();
      this.configKey = key;
      for (const [name, config] of Object.entries(servers)) {
        try {
          const connection = await this.connect(name, config, cwd);
          this.connections.set(name, connection);
          this.log.info(`MCP server "${name}" connected with ${connection.tools.length} tools.`);
        } catch (error) {
          this.log.error(`MCP server "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.bindings = new Map();
      for (const connection of this.connections.values()) {
        for (const tool of connection.tools) {
          const name = mcpToolName(connection.server, tool.name);
          this.bindings.set(name, {
            server: connection.server,
            tool: tool.name,
            definition: {
              name,
              description: `[MCP ${connection.server}] ${tool.description}`.slice(0, 1000),
              parameters: tool.inputSchema,
            },
          });
        }
      }
    }
    return [...this.bindings.values()];
  }

  binding(name: string): McpToolBinding | undefined {
    return this.bindings.get(name);
  }

  async call(binding: McpToolBinding, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const connection = this.connections.get(binding.server);
    if (!connection) throw new Error(`The MCP server "${binding.server}" is not connected.`);
    return connection.client.callTool(binding.tool, args);
  }

  dispose(): void {
    for (const connection of this.connections.values()) {
      connection.client.close();
      connection.process.kill();
    }
    this.connections.clear();
    this.bindings.clear();
    this.configKey = "";
  }

  private async connect(name: string, config: McpServerConfig, cwd: string): Promise<Connection> {
    const child = spawn(config.command, [...config.args], {
      cwd,
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
    child.stderr?.on("data", (chunk: string) => this.log.debug(`[mcp ${name}] ${chunk.trim()}`));
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
      return { server: name, client, process: child, tools };
    } catch (error) {
      client.close();
      child.kill();
      throw error;
    }
  }
}
