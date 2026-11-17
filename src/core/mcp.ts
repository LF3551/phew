/** The transport of a JSON-RPC connection, for example the stdin and stdout of a process. */
export interface LineTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  close(): void;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export const mcpProtocolVersion = "2025-06-18";

/** A minimal Model Context Protocol client for the newline-delimited stdio transport. */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly transport: LineTransport,
    private readonly timeoutMs = 30_000,
  ) {
    transport.onLine((line) => this.receive(line));
  }

  async initialize(clientVersion: string): Promise<void> {
    await this.request("initialize", {
      protocolVersion: mcpProtocolVersion,
      capabilities: {},
      clientInfo: { name: "phew", version: clientVersion },
    });
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: unknown[];
        nextCursor?: unknown;
      };
      for (const tool of result.tools ?? []) {
        if (typeof tool !== "object" || tool === null) continue;
        const { name, description, inputSchema } = tool as Record<string, unknown>;
        if (typeof name !== "string") continue;
        tools.push({
          name,
          description: typeof description === "string" ? description : "",
          inputSchema:
            typeof inputSchema === "object" && inputSchema !== null
              ? (inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
        });
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor === "") break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  /** Calls a tool and returns its text content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: unknown[];
      isError?: unknown;
      structuredContent?: unknown;
    };
    const parts: string[] = [];
    for (const item of result.content ?? []) {
      if (typeof item !== "object" || item === null) continue;
      const content = item as Record<string, unknown>;
      if (content.type === "text" && typeof content.text === "string") parts.push(content.text);
      else if (typeof content.type === "string") parts.push(`[${content.type} content]`);
    }
    if (parts.length === 0 && result.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent));
    }
    return { text: parts.join("\n"), isError: result.isError === true };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The MCP server connection closed."));
      this.pending.delete(id);
    }
    this.transport.close();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("The MCP server connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The MCP request ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(method: string): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method }));
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const { id, result, error } = message as Record<string, unknown>;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      const text =
        typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "Unknown error";
      pending.reject(new Error(`MCP error: ${text}`));
    } else pending.resolve(result ?? {});
  }
}

/** Splits a byte stream into lines. */
export class LineBuffer {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }
}

/** Builds the model-facing name of an MCP tool. Names keep only safe characters and fit in 64 characters. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}
