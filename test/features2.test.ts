import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { runAgent } from "../src/core/agent";
import type { ChatMessage, CompletionResult, ModelClient } from "../src/core/chat";
import {
  applyCompaction,
  buildCompactionMessages,
  contextUsage,
  estimateTokens,
  splitForCompaction,
} from "../src/core/compaction";
import { CostMeter } from "../src/core/cost";
import { McpClient } from "../src/core/mcp";
import {
  parseMcpFile,
  parseServer,
  resolveServer,
  resolveVariables,
  stripJsonComments,
  usedInputs,
} from "../src/core/mcpConfig";
import { HttpTransport } from "../src/core/mcpHttp";
import {
  authorizationUrl,
  createPkce,
  discover,
  exchangeCode,
  isExpired,
  metadataUrls,
  refreshTokens,
  registerClient,
  resourceMetadataUrl,
} from "../src/core/oauth";
import { parsePlanUpdate, parseQuestion, planProgress, planPrompt } from "../src/core/plan";
import { RootSet } from "../src/core/roots";
import { parseSkill, skillsPrompt, uniqueSkills } from "../src/core/skills";
import {
  anthropicVersion,
  applyAnthropicEvent,
  finishAnthropic,
  newAnthropicState,
  toAnthropic,
} from "../src/providers/anthropic";
import { applyGeminiChunk, finishGemini, newGeminiState } from "../src/providers/gemini";
import { fetchWithRetry, finalError, isQuotaError, parseDuration, postJson, retryAfterMs } from "../src/providers/http";
import { applyChunk, finishState, newStreamState } from "../src/providers/openaiCompatible";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

describe("context and compaction", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "first".repeat(100) },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "1", content: "file" },
    { role: "assistant", content: "done" },
    { role: "user", content: "second" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "third" },
  ];

  test("estimates and measures the context", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(400) }])).toBe(100);
    expect(contextUsage(50_000, 100_000)).toBe(0.5);
    expect(contextUsage(10, 0)).toBe(0);
  });

  test("splits at a user message and keeps recent turns", () => {
    const split = splitForCompaction(history, 2);
    expect(split?.older).toHaveLength(4);
    expect(split?.recent[0]).toEqual({ role: "user", content: "second" });
    expect(splitForCompaction(history.slice(0, 4), 2)).toBeUndefined();
  });

  test("builds the summary request and applies the summary", () => {
    const messages = buildCompactionMessages(history.slice(0, 4));
    expect(messages[1].content).toContain("TOOL CALL read_file");
    const compacted = applyCompaction([{ role: "user", content: "third" }], "## Goal\nFix it");
    expect(compacted[0].content).toContain("## Goal");
    expect(compacted.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("agent queue", () => {
  test("queued messages continue the task after the model stops", async () => {
    const replies: CompletionResult[] = [
      { content: "First answer.", toolCalls: [] },
      { content: "Also done.", toolCalls: [] },
    ];
    let queued: string[] = [];
    const client: ModelClient = {
      complete: async () => {
        // The user writes while the model works on the first step.
        if (replies.length === 2) queued = ["also update the docs"];
        return replies.shift() as CompletionResult;
      },
    };
    const history: ChatMessage[] = [{ role: "user", content: "start" }];
    const result = await runAgent({
      client,
      systemPrompt: "s",
      history,
      tools: [],
      executeTool: async () => ({ content: "" }),
      maxSteps: 5,
      meter: new CostMeter(undefined, { maxCostPerTask: 0, maxTokensPerTask: 0 }),
      signal: new AbortController().signal,
      beforeStep: async () => {
        for (const text of queued.splice(0)) history.push({ role: "user", content: text });
      },
    });
    expect(result).toMatchObject({ status: "done", steps: 2 });
    expect(history.map((message) => message.content)).toEqual([
      "start",
      "First answer.",
      "also update the docs",
      "Also done.",
    ]);
  });
});

describe("skills, plans, and questions", () => {
  test("parses SKILL.md front matter", () => {
    const skill = parseSkill(
      "---\nname: pdf-tools\ndescription: >\n  Fill PDF forms\n  and merge files.\n---\n# Steps\nUse pdftk.",
      "folder",
    );
    expect(skill).toEqual({
      name: "pdf-tools",
      description: "Fill PDF forms and merge files.",
      body: "# Steps\nUse pdftk.",
    });
    expect(parseSkill('---\ndescription: "Quoted"\n---\nBody', "my-skill")?.name).toBe("my-skill");
    expect(parseSkill("No front matter", "x")).toBeUndefined();
    expect(parseSkill("---\nname: x\n---\n", "x")).toBeUndefined();
    const unique = uniqueSkills([
      { name: "A", description: "1", folder: "/p", source: "p" },
      { name: "a", description: "2", folder: "/u", source: "u" },
    ]);
    expect(unique).toHaveLength(1);
    expect(skillsPrompt(unique)).toContain("- A: 1");
    expect(skillsPrompt([])).toBe("");
  });

  test("validates plan updates and questions", () => {
    const plan = parsePlanUpdate(
      {
        goal: "Ship login",
        items: [{ text: "Write tests", status: "done" }, { text: "Fix bug", status: "in_progress" }, { text: "" }, "x"],
      },
      { items: [] },
    );
    expect(plan.items).toHaveLength(2);
    expect(planProgress(plan)).toEqual({ done: 1, total: 2 });
    expect(planPrompt(plan)).toContain("[x] Write tests");
    expect(parsePlanUpdate({ items: [] }, plan).goal).toBe("Ship login");
    expect(() => parsePlanUpdate({}, plan)).toThrow();
    expect(parseQuestion({ question: "Which DB?", options: ["Postgres", "Postgres", "SQLite", 3] })).toEqual({
      question: "Which DB?",
      options: ["Postgres", "SQLite"],
      allowText: true,
    });
    expect(parseQuestion({ question: "Pick", options: ["a"], allow_text: false }).allowText).toBe(false);
    expect(() => parseQuestion({})).toThrow();
  });
});

describe("several folders", () => {
  const api = path.resolve("ws", "api");
  const web = path.resolve("ws", "web");
  const roots = new RootSet([
    { name: "api", path: api },
    { name: "web", path: web },
  ]);

  test("resolves and shows paths with folder names", () => {
    expect(roots.resolve("web/src/app.ts")).toBe(path.join(web, "src", "app.ts"));
    expect(roots.resolve("src/main.go")).toBe(path.join(api, "src", "main.go"));
    expect(roots.resolve(path.join(web, "x.ts"))).toBe(path.join(web, "x.ts"));
    expect(roots.resolve("../../etc/passwd")).toBeUndefined();
    expect(roots.display(path.join(web, "src", "app.ts"))).toBe("web/src/app.ts");
    expect(roots.describe()).toContain("api/ (commands run here by default)");
    const single = new RootSet([{ name: "api", path: api }]);
    expect(single.display(path.join(api, "a.ts"))).toBe("a.ts");
    expect(
      new RootSet([
        { name: "x", path: api },
        { name: "x", path: web },
      ]).roots[1].name,
    ).toBe("x-2");
  });
});

describe("retries and limits", () => {
  test("parses durations and retry headers", () => {
    expect(parseDuration("1s")).toBe(1000);
    expect(parseDuration("6m0s")).toBe(360_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("1h2m3.5s")).toBe(3_723_500);
    expect(parseDuration("soon")).toBeUndefined();
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "15" }))).toBe(15);
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "3s" }))).toBe(
      3000,
    );
    expect(retryAfterMs(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 7_000)).toBe(3000);
  });

  test("retries rate limits and server errors, then succeeds", async () => {
    const statuses = [429, 503, 200];
    const retries: number[] = [];
    const response = await fetchWithRetry(
      fakeFetch(
        () =>
          new Response(statuses[0] === 200 ? "ok" : "busy", {
            status: statuses.shift(),
            headers: { "retry-after-ms": "1" },
          }),
      ),
      "X",
      "https://x",
      { signal: new AbortController().signal },
      { retries: 3, onRetry: (info) => retries.push(info.attempt) },
    );
    expect(response.status).toBe(200);
    expect(retries).toEqual([2, 3]);
  });

  test("never retries a missing quota and explains it", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await expect(
      postJson(
        fakeFetch(
          () => json({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } }, 429),
          calls,
        ),
        "OpenAI",
        "https://x",
        {},
        {},
        new AbortController().signal,
        { retries: 3 },
      ),
    ).rejects.toThrow(/no quota or credit left/);
    expect(calls).toHaveLength(1);
    expect(isQuotaError(402, "payment required")).toBe(true);
    expect(finalError("X", 429, '{"error":"slow"}', 4).message).toMatch(/rate limit reached after 4 attempts/);
    expect(finalError("X", 529, "", 2).message).toMatch(/overloaded/);
  });

  test("retries network errors and stops on abort", async () => {
    let calls = 0;
    const flaky = fakeFetch(() => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response("ok");
    });
    const response = await fetchWithRetry(
      flaky,
      "X",
      "https://x",
      { signal: new AbortController().signal },
      { retries: 1, maxDelayMs: 1 },
    );
    expect(await response.text()).toBe("ok");
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWithRetry(
        fakeFetch(() => new Response("", { status: 429, headers: { "retry-after-ms": "1000" } })),
        "X",
        "https://x",
        { signal: controller.signal },
        { retries: 2 },
      ),
    ).rejects.toThrow();
  });
});

describe("reasoning", () => {
  test("OpenAI-compatible reasoning fields", () => {
    const state = newStreamState();
    const thoughts: string[] = [];
    applyChunk(
      state,
      { choices: [{ delta: { reasoning_content: "Let me think." } }] },
      () => {},
      (delta) => thoughts.push(delta),
    );
    applyChunk(
      state,
      { choices: [{ delta: { reasoning: " More.", content: "Answer" } }] },
      () => {},
      (delta) => thoughts.push(delta),
    );
    expect(thoughts.join("")).toBe("Let me think. More.");
    expect(finishState(state).reasoning).toEqual({ text: "Let me think. More." });
  });

  test("Anthropic thinking blocks are kept with their signature and sent back", () => {
    const state = newAnthropicState();
    const thoughts: string[] = [];
    for (const event of [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan the fix." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig==" } },
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "read_file" } },
    ]) {
      applyAnthropicEvent(
        state,
        event,
        () => {},
        (delta) => thoughts.push(delta),
      );
    }
    const result = finishAnthropic(state);
    expect(thoughts).toEqual(["Plan the fix."]);
    expect(result.reasoning).toEqual({ text: "Plan the fix.", signature: "sig==", redacted: ["opaque"] });
    const { messages } = toAnthropic([
      { role: "user", content: "fix" },
      { role: "assistant", content: "", toolCalls: result.toolCalls, reasoning: result.reasoning },
    ]);
    expect(messages[1].content.slice(0, 2)).toEqual([
      { type: "thinking", thinking: "Plan the fix.", signature: "sig==" },
      { type: "redacted_thinking", data: "opaque" },
    ]);
    expect(anthropicVersion).toBe("2023-06-01");
  });

  test("Gemini thought parts", () => {
    const state = newGeminiState();
    const thoughts: string[] = [];
    const text: string[] = [];
    applyGeminiChunk(
      state,
      { candidates: [{ content: { parts: [{ text: "Hmm.", thought: true }, { text: "Answer." }] } }] },
      (delta) => text.push(delta),
      (delta) => thoughts.push(delta),
    );
    expect(thoughts).toEqual(["Hmm."]);
    expect(text).toEqual(["Answer."]);
    expect(finishGemini(state).reasoning).toEqual({ text: "Hmm." });
  });
});

describe("MCP configuration", () => {
  test("reads VS Code and Claude Code formats with comments", () => {
    const vscodeFile = `{
      // GitHub server
      "inputs": [{ "type": "promptString", "id": "token", "description": "GitHub token", "password": true }],
      "servers": {
        "github": { "type": "http", "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer \${input:token}" } },
        "fs": { "type": "stdio", "command": "npx", "args": ["-y", "server-fs", "\${workspaceFolder}"], },
        "broken": { "type": "stdio" }
      }
    }`;
    const parsed = parseMcpFile(vscodeFile, ".vscode/mcp.json");
    expect(parsed.servers.map((server) => server.name)).toEqual(["github", "fs"]);
    expect(parsed.inputs).toEqual([{ id: "token", description: "GitHub token", password: true }]);
    const claude = parseMcpFile(
      '{"mcpServers": {"db": {"command": "db-mcp", "env": {"KEY": "${DB_KEY}"}}, "sse": {"type": "sse", "url": "https://x/sse"}}}',
      ".mcp.json",
    );
    expect(claude.servers.map((server) => server.config.type)).toEqual(["stdio", "http"]);
    expect(parseMcpFile("not json", ".mcp.json").servers).toEqual([]);
    expect(stripJsonComments('{"a": "// not a comment", /* x */ "b": 1,}')).toBe('{"a": "// not a comment",  "b": 1}');
  });

  test("resolves variables and lists the inputs", () => {
    const server = parseServer({ url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${input:token}" } });
    expect(server && usedInputs(server)).toEqual(["token"]);
    const missing = new Set<string>();
    const context = {
      workspaceFolder: "/ws",
      userHome: "/home/a",
      env: { HOST: "example.com" },
      inputs: { token: "t0k" },
    };
    expect(server && resolveServer(server, context, missing)).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t0k" },
    });
    expect(
      resolveVariables(
        "${input:other} ${workspaceFolder} ${env:NONE} ${userHome}",
        { ...context, inputs: {} },
        missing,
      ),
    ).toBe(" /ws  /home/a");
    expect([...missing]).toEqual(["other"]);
  });
});

describe("MCP over HTTP", () => {
  test("initializes, keeps the session id, and reads JSON and SSE responses", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFunction = fakeFetch(async (_url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      const message = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (message.method === "initialize")
        return json({ jsonrpc: "2.0", id: message.id, result: {} }, 200, { "mcp-session-id": "s1" });
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search" }] } })}\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }, calls);
    const transport = new HttpTransport(
      "https://mcp.example.com/mcp",
      async () => ({ Authorization: "Bearer t" }),
      () => {},
      fetchFunction,
    );
    const client = new McpClient(transport, 2000);
    await client.initialize("1.0.0");
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["search"]);
    const headers = calls[2].init.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBe("s1");
    expect(headers.Authorization).toBe("Bearer t");
    expect(headers.Accept).toContain("text/event-stream");
    client.close();
  });

  test("reports that sign-in is needed", async () => {
    const transport = new HttpTransport(
      "https://mcp.example.com/mcp",
      async () => ({}),
      () => {},
      fakeFetch(
        () =>
          new Response("", {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
      ),
    );
    const client = new McpClient(transport, 2000);
    await expect(client.initialize("1")).rejects.toThrow(/sign in/);
    expect(resourceMetadataUrl(transport.authError?.wwwAuthenticate ?? null)).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
  });
});

describe("MCP OAuth", () => {
  test("PKCE and metadata URLs", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(metadataUrls("https://auth.example.com/tenant1")[0]).toBe(
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
    );
    expect(metadataUrls("https://auth.example.com")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  test("discovery, registration, authorization URL, and tokens", async () => {
    const fetchFunction = fakeFetch(async (url, init) => {
      if (url.endsWith("/.well-known/oauth-protected-resource"))
        return json({ authorization_servers: ["https://auth.example.com"] });
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return json({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          scopes_supported: ["mcp"],
        });
      }
      if (url.endsWith("/register")) return json({ client_id: "client-1" }, 201);
      if (url.endsWith("/token")) {
        const form = new URLSearchParams(String(init.body));
        if (form.get("grant_type") === "authorization_code" && form.get("code_verifier") && form.get("resource")) {
          return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
        }
        if (form.get("grant_type") === "refresh_token") return json({ access_token: "access-2", expires_in: 3600 });
        return json({ error: "invalid_grant" }, 400);
      }
      return new Response("", { status: 404 });
    });
    const metadata = await discover("https://mcp.example.com/mcp", null, fetchFunction);
    expect(metadata.token_endpoint).toBe("https://auth.example.com/token");
    const clientId = await registerClient(metadata, "http://127.0.0.1:5000/callback", fetchFunction);
    expect(clientId).toBe("client-1");
    const url = new URL(
      authorizationUrl(metadata, {
        clientId,
        redirectUri: "http://127.0.0.1:5000/callback",
        challenge: "c",
        state: "s",
        resource: "https://mcp.example.com/mcp",
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      code_challenge_method: "S256",
      scope: "mcp",
      resource: "https://mcp.example.com/mcp",
    });
    const tokens = await exchangeCode(
      metadata,
      { code: "code", verifier: "v", clientId, redirectUri: "r", resource: "https://mcp.example.com/mcp" },
      fetchFunction,
    );
    expect(tokens).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", clientId: "client-1" });
    expect(isExpired(tokens)).toBe(false);
    expect(isExpired({ ...tokens, expiresAt: Date.now() + 1000 })).toBe(true);
    const refreshed = await refreshTokens(tokens, fetchFunction);
    expect(refreshed).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });
  });

  test("falls back to the server origin without metadata", async () => {
    const metadata = await discover(
      "https://mcp.example.com/mcp",
      null,
      fakeFetch(() => new Response("", { status: 404 })),
    );
    expect(metadata).toEqual({
      authorization_endpoint: "https://mcp.example.com/authorize",
      token_endpoint: "https://mcp.example.com/token",
      registration_endpoint: "https://mcp.example.com/register",
    });
  });
});

describe("appearance", () => {
  test("only safe colors and fonts reach the view", async () => {
    const { safeColor, safeFontFamily } = await import("../src/core/appearance");
    expect(safeColor("#22B8CF")).toBe("#22B8CF");
    expect(safeColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(safeColor("Teal")).toBe("teal");
    expect(safeColor("red; background: url(x)")).toBe("");
    expect(safeColor(5)).toBe("");
    expect(safeFontFamily("Inter, 'Segoe UI', sans-serif")).toBe("Inter, 'Segoe UI', sans-serif");
    expect(safeFontFamily("x; } body { display: none")).toBe("");
  });

  test("appearance and interrupt messages are validated", async () => {
    const { parseWebviewMessage } = await import("../src/shared/protocol");
    expect(parseWebviewMessage({ type: "setAppearance", key: "style", value: "compact" })).toBeDefined();
    expect(parseWebviewMessage({ type: "setAppearance", key: "style", value: "neon" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "setAppearance", key: "fontSize", value: 99 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "setAppearance", key: "other", value: 1 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "send", text: "now", attachments: [], interrupt: true })).toEqual({
      type: "send",
      text: "now",
      attachments: [],
      interrupt: true,
    });
  });
});

test("a long paste becomes a chip with the number of lines, and the host accepts it", async () => {
  const { isLongPaste, pastedLabel, parseAttachment, attachmentLabel } = await import("../src/core/attachments");
  const log = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
  expect(isLongPaste(log)).toBe(true);
  expect(isLongPaste("short text\nwith two lines")).toBe(false);
  expect(isLongPaste("x".repeat(3001))).toBe(true);
  expect(pastedLabel(`${log}\n\n`)).toBe("Pasted text · 120 lines");
  const parsed = parseAttachment({ kind: "text", name: "Pasted text", text: log });
  expect(parsed).toEqual({ kind: "text", name: "Pasted text", text: log });
  if (parsed) expect(attachmentLabel(parsed)).toBe("Pasted text · 120 lines");
  expect(parseAttachment({ kind: "text", text: "x".repeat(500_001) })).toBeUndefined();
});

test("an earlier chat can be attached by its id", async () => {
  const { parseAttachment, attachmentLabel } = await import("../src/core/attachments");
  const chat = parseAttachment({ kind: "chat", id: "c_m3abc_1", title: "Fix login" });
  expect(chat).toEqual({ kind: "chat", id: "c_m3abc_1", title: "Fix login" });
  if (chat) expect(attachmentLabel(chat)).toBe("Chat: Fix login");
  expect(parseAttachment({ kind: "chat", id: "../../etc", title: "x" })).toBeUndefined();
});
