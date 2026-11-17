import { expect, test } from "vitest";
import { LineBuffer, McpClient, mcpToolName } from "../src/core/mcp";
import { SseParser } from "../src/core/sse";

function fakeServer() {
  let listener: (line: string) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const transport = {
    send(line: string) {
      const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
      sent.push(message);
      if (message.id === undefined) return;
      const reply = (result: unknown) =>
        queueMicrotask(() => listener(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })));
      if (message.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: {} });
      else if (message.method === "tools/list" && !message.params?.cursor)
        reply({ tools: [{ name: "a", description: "A", inputSchema: { type: "object" } }], nextCursor: "2" });
      else if (message.method === "tools/list") reply({ tools: [{ name: "b" }] });
      else if (message.method === "tools/call")
        queueMicrotask(() =>
          listener(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -1, message: "nope" } })),
        );
    },
    onLine(next: (line: string) => void) {
      listener = next;
    },
    close() {},
  };
  return { transport, sent };
}

test("initializes, lists tools across pages, and reports errors", async () => {
  const { transport, sent } = fakeServer();
  const client = new McpClient(transport, 1000);
  await client.initialize("1.0.0");
  expect(sent.map((message) => message.method)).toEqual(["initialize", "notifications/initialized"]);
  const tools = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["a", "b"]);
  expect(tools[1].inputSchema).toEqual({ type: "object", properties: {} });
  await expect(client.callTool("a", {})).rejects.toThrow("MCP error: nope");
  client.close();
  await expect(client.listTools()).rejects.toThrow(/closed/);
});

test("builds safe tool names and splits lines", () => {
  expect(mcpToolName("git hub", "create.issue")).toBe("mcp__git_hub__create_issue");
  expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
  const lines: string[] = [];
  const buffer = new LineBuffer((line) => lines.push(line));
  buffer.push('{"a":1}\r\n{"b"');
  buffer.push(":2}\n\n");
  expect(lines).toEqual(['{"a":1}', '{"b":2}']);
});

test("parses server-sent events split across chunks", () => {
  const data: string[] = [];
  const parser = new SseParser((item) => data.push(item));
  parser.push(": comment\nda");
  parser.push("ta: one\r\ndata: two\n\ndata: three");
  parser.flush();
  expect(data).toEqual(["one\ntwo", "three"]);
});
