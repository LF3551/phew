const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The index of the current task: the last user message that is not a queued note. */
function taskIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && !String(message.content).startsWith("(The user sent this")) return index;
  }
  return -1;
}

function taskOf(messages) {
  const index = taskIndex(messages);
  return index >= 0 ? String(messages[index].content) : "";
}

function stepOf(messages) {
  return messages.slice(taskIndex(messages)).filter((message) => message.role === "assistant").length;
}

function lastToolResult(messages) {
  return [...messages].reverse().find((message) => message.role === "tool")?.content ?? "";
}

const call = (name, args) => ({
  tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }],
});

/** A scripted model. Each task has its own steps. */
async function script(data) {
  const messages = data.messages;
  if (!data.tools || data.tools.length === 0) {
    if (/side question/.test(messages[0].content)) return { content: "BTW-ANSWER" };
    if (/summarize a coding conversation/.test(messages[0].content)) return { content: "## Summary\nEarlier work." };
    return {
      content:
        "fix(math): add numbers instead of subtracting\n\nThe add function used minus.\n\nCo-authored-by: Robot <robot@example.com>",
    };
  }
  const task = taskOf(messages);
  const step = stepOf(messages);
  if (task.startsWith("Make node check.js pass")) {
    return step === 0
      ? call("edit_file", { path: "math.js", old_text: "a - b", new_text: "a + b" })
      : { content: "**Fix:** use +." };
  }
  if (task.startsWith("Ask me"))
    return step === 0
      ? call("ask_user", { question: "Which color?", options: ["red", "blue"] })
      : { content: `RESULT ${lastToolResult(messages)}` };
  if (task.startsWith("Use the skill"))
    return step === 0 ? call("load_skill", { name: "greeting" }) : { content: `RESULT ${lastToolResult(messages)}` };
  if (task.startsWith("Use MCP"))
    return step === 0 ? call("mcp__demo__echo", { text: "hi" }) : { content: `RESULT ${lastToolResult(messages)}` };
  if (task.startsWith("List folders"))
    return step === 0 ? call("list_files", { pattern: "**/*.md" }) : { content: `RESULT ${lastToolResult(messages)}` };
  if (task.startsWith("Plan it")) {
    return step === 0
      ? call("update_plan", {
          goal: "Ship it",
          items: [
            { text: "One", status: "done" },
            { text: "Two", status: "in_progress" },
          ],
        })
      : { content: "planned" };
  }
  if (task.startsWith("Slow")) {
    await delay(1500);
    const last = messages[messages.length - 1];
    return { content: /while you were working/.test(last.content) ? `QUEUED-SEEN ${task}` : `SLOW-DONE ${task}` };
  }
  return { content: "Done." };
}

function startServer() {
  const requests = [];
  let mcpSession = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      if (request.url === "/mcp") {
        if (request.method !== "POST") {
          response.writeHead(204).end();
          return;
        }
        const message = JSON.parse(body);
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "echo",
                      description: "Echo text",
                      inputSchema: { type: "object", properties: { text: { type: "string" } } },
                    },
                  ],
                }
              : { content: [{ type: "text", text: `echo: ${message.params.arguments.text}` }] };
        response.writeHead(200, {
          "Content-Type": "application/json",
          ...(message.method === "initialize" ? { "Mcp-Session-Id": `s${++mcpSession}` } : {}),
        });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        return;
      }
      const data = JSON.parse(body);
      requests.push(data);
      const delta = await script(data);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests })));
}

function lastAssistant(session) {
  return [...session.conversation].reverse().find((message) => message.role === "assistant")?.content ?? "";
}

async function run() {
  const extension = vscode.extensions.getExtension("alekseialeinikov.phew");
  assert.ok(extension, "the extension is installed");
  const api = await extension.activate();
  assert.ok(api, "the test API exists in test mode");
  const commands = await vscode.commands.getCommands(true);
  for (const command of extension.packageJSON.contributes.commands.map((item) => item.command)) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }

  const { server, requests } = await startServer();
  const port = server.address().port;
  const config = vscode.workspace.getConfiguration("phew");
  await config.update(
    "models",
    [
      {
        id: "fake",
        name: "Fake",
        provider: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "fake-model",
        auth: "none",
        contextWindow: 200000,
      },
    ],
    vscode.ConfigurationTarget.Global,
  );
  await config.update("activeModel", "fake", vscode.ConfigurationTarget.Global);
  await config.update("mcp.autoApprove", true, vscode.ConfigurationTarget.Global);

  const [mainFolder, secondFolder] = vscode.workspace.workspaceFolders.map((folder) => folder.uri.fsPath);
  fs.writeFileSync(
    path.join(mainFolder, ".vscode", "mcp.json"),
    JSON.stringify({ servers: { demo: { type: "http", url: `http://127.0.0.1:${port}/mcp` } } }),
  );
  const file = path.join(mainFolder, "math.js");
  const sessions = api.sessions;
  try {
    // 1. Fix, check, review in the editor, history, commit message, checkpoint.
    await api.run({ text: "Make node check.js pass.", kind: "fix", mode: "code" });
    assert.equal(fs.readFileSync(file, "utf8"), "exports.add = (a, b) => a + b;\n", "the agent fixed the file");
    const first = requests.find((item) => item.tools?.length > 0);
    for (const tool of ["edit_file", "search_code", "ask_user", "update_plan", "load_skill", "mcp__demo__echo"]) {
      assert.ok(
        first.tools.some((item) => item.function.name === tool),
        `Code mode has ${tool}`,
      );
    }
    assert.match(first.messages[0].content, /greeting: Greets the user/, "skills are in the system prompt");
    assert.match(first.messages[0].content, /second\//, "both folders are in the system prompt");
    assert.deepEqual(
      api.reviews.pendingFiles.map((uri) => path.basename(uri.fsPath)),
      ["math.js"],
    );
    const message = await vscode.commands.executeCommand("phew.generateCommitMessage");
    assert.match(message, /Signed-off-by: Test User <test@example.com>$/);
    assert.doesNotMatch(message, /Co-authored-by/);
    await api.reviews.keepAll();
    await api.restoreLatest();
    assert.equal(fs.readFileSync(file, "utf8"), "exports.add = (a, b) => a - b;\n", "the checkpoint restored the file");
    assert.equal((await sessions.listHistory()).length, 1);

    // 2. A question with buttons.
    sessions.newSession();
    const asking = sessions.active;
    const asked = asking.run({ text: "Ask me a question", kind: "chat", mode: "code" });
    for (let index = 0; index < 50 && !asking.needsApproval; index++) await delay(50);
    assert.ok(asking.needsApproval, "the agent asks the user");
    const question = asking.transcript.all().find((item) => item.type === "approval" && item.kind === "question");
    assert.deepEqual(question.options, ["red", "blue"]);
    asking.broker.answer(question.id, true, undefined, "blue");
    await asked;
    assert.equal(lastAssistant(asking), "RESULT The user answered: blue");

    // 3. Skills, MCP over HTTP, several folders, and the plan.
    await asking.run({ text: "Use the skill", kind: "chat" });
    assert.match(lastAssistant(asking), /HELLO-FROM-SKILL/);
    await asking.run({ text: "Use MCP", kind: "chat" });
    assert.match(lastAssistant(asking), /echo: hi/);
    sessions.newSession();
    await sessions.active.run({ text: "List folders", kind: "chat" });
    assert.match(lastAssistant(sessions.active), /second\/README\.md/);
    sessions.newSession();
    await sessions.active.run({ text: "Plan it", kind: "chat" });
    assert.equal(sessions.active.plan.goal, "Ship it");
    assert.equal(sessions.active.plan.items.length, 2);

    // 4. A queued message reaches the running agent, and /btw answers on the side.
    sessions.newSession();
    const busy = sessions.active;
    const running = busy.run({ text: "Slow task one", kind: "chat", mode: "code" });
    await delay(300);
    assert.ok(busy.busy);
    await busy.submit("please also check the docs");
    assert.equal(busy.queued.length, 1, "the message waits in the queue");
    await busy.submit("/btw what are you doing?");
    await running;
    assert.equal(busy.queued.length, 0);
    assert.match(lastAssistant(busy), /QUEUED-SEEN Slow task one/);
    const btw = busy.transcript.all().find((item) => item.type === "assistantEnd" && item.variant === "btw");
    assert.equal(btw?.text, "BTW-ANSWER");
    assert.ok(
      !busy.conversation.some((item) => item.content.includes("BTW-ANSWER")),
      "/btw does not change the conversation",
    );

    // 4b. Stop and send: the new message stops the running step and runs at once.
    const stopping = busy.run({ text: "Slow task three", kind: "chat" });
    await delay(300);
    await busy.submit("Slow task four", [], true);
    await stopping;
    assert.match(lastAssistant(busy), /SLOW-DONE Slow task four/, "the interrupting message ran");
    assert.ok(!busy.busy);

    // 5. Two chats work at the same time, one in an editor tab.
    await vscode.commands.executeCommand("phew.openChatInEditor");
    const parallel = sessions.createDetached();
    const startedAt = Date.now();
    sessions.newSession();
    const other = sessions.active;
    await Promise.all([
      parallel.run({ text: "Slow task A", kind: "chat" }),
      other.run({ text: "Slow task B", kind: "chat" }),
    ]);
    const elapsed = Date.now() - startedAt;
    assert.match(lastAssistant(parallel), /SLOW-DONE Slow task A/);
    assert.match(lastAssistant(other), /SLOW-DONE Slow task B/);
    assert.ok(elapsed < 2900, `the two chats ran in parallel (${elapsed} ms)`);

    // 6. Rename, per-chat approvals, and the context meter.
    other.rename("Renamed chat");
    assert.equal(other.title, "Renamed chat");
    sessions.setApproval(other, "commands", "safe");
    assert.equal(other.effectiveSettings().commands.mode, "safe");
    assert.equal(sessions.state().approvals.custom, true);
    assert.ok(other.contextState().share > 0, "the context meter has a value");

    // 7. Phew it! on errors.
    const diagnostics = vscode.languages.createDiagnosticCollection("phew-test");
    const document = await vscode.workspace.openTextDocument(file);
    diagnostics.set(document.uri, [
      new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), "Test problem", vscode.DiagnosticSeverity.Error),
    ]);
    const actions = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(0, 0, 0, 5),
    );
    assert.ok(actions.some((action) => action.title === "Phew it! Fix with Phew"));
    diagnostics.dispose();
    void secondFolder;

    console.log(
      "PHEW_INTEGRATION_OK: fix, review, commit, checkpoint, ask_user, skills, MCP HTTP, multi-root, plan, queue, btw, parallel chats, rename, approvals, context, Phew it!",
    );
  } finally {
    server.close();
  }
}

module.exports = { run };
