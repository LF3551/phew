import type { LineTransport } from "./mcp";
import { SseParser } from "./sse";

export class McpAuthRequiredError extends Error {
  constructor(readonly wwwAuthenticate: string | null) {
    super("The MCP server needs you to sign in.");
    this.name = "McpAuthRequiredError";
  }
}

/**
 * The Streamable HTTP transport of MCP. Each JSON-RPC message is a POST. The response is JSON or a
 * Server-Sent Events stream. The server can assign a session with the `Mcp-Session-Id` header.
 */
export class HttpTransport implements LineTransport {
  private listener: (line: string) => void = () => {};
  private sessionId: string | undefined;
  private closed = false;
  /** Set when the server answered 401. The manager starts the OAuth flow then. */
  authError: McpAuthRequiredError | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: () => Promise<Record<string, string>>,
    private readonly log: (message: string) => void,
    private readonly fetchFunction: typeof fetch = fetch,
  ) {}

  onLine(listener: (line: string) => void): void {
    this.listener = listener;
  }

  send(line: string): void {
    void this.post(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId) {
      void this.headers()
        .then((headers) =>
          this.fetchFunction(this.url, {
            method: "DELETE",
            headers: { ...headers, "Mcp-Session-Id": this.sessionId as string },
          }),
        )
        .catch(() => undefined);
    }
  }

  private fail(line: string, message: string): void {
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (id !== undefined) this.listener(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
    } catch {
      // Not a request.
    }
  }

  private async post(line: string): Promise<void> {
    if (this.closed) return;
    let response: Response;
    try {
      response = await this.fetchFunction(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          ...(await this.headers()),
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: line,
      });
    } catch (error) {
      this.log(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      this.fail(line, `Cannot reach the MCP server: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (response.status === 401) {
      this.authError = new McpAuthRequiredError(response.headers.get("www-authenticate"));
      this.fail(line, this.authError.message);
      return;
    }
    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.log(`HTTP ${response.status}: ${body.slice(0, 300)}`);
      this.fail(line, `The MCP server returned HTTP ${response.status}.`);
      return;
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && response.body) {
      const parser = new SseParser((data) => {
        if (data.trim()) this.listener(data);
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.flush();
      } catch (error) {
        this.log(`Stream failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const text = await response.text();
    if (!text.trim()) return;
    try {
      const data = JSON.parse(text) as unknown;
      for (const message of Array.isArray(data) ? data : [data]) this.listener(JSON.stringify(message));
    } catch {
      this.fail(line, "The MCP server sent an invalid response.");
    }
  }
}
