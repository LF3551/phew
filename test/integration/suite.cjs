const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
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
    if (/write a handoff note/.test(messages[0].content))
      return {
        content: JSON.stringify({
          title: "Integration handoff",
          status: "in-progress",
          summary: "math.js was fixed.",
          decisions: [{ id: "D1", text: "Use + in add — the check expects a sum", status: "active" }],
          deadEnds: ["Changing check.js"],
          nextSteps: ["Run node check.js"],
          preferences: ["Do not push without asking"],
        }),
      };
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
  if (task.startsWith("Shell persists")) {
    const steps = [
      { command: "mkdir -p sub && cd sub && export PHEW_X=42", description: "Make a folder and go there" },
      { command: 'pwd; echo "x=$PHEW_X"', description: "Show the folder" },
      { command: "sh", description: "Open a nested shell, like ssh" },
      { command: "echo inside-$((20+22))", description: "Run a command inside" },
      { command: "exit", description: "Leave the nested shell" },
      {
        command: "python3 -u -m http.server 8790 --bind 127.0.0.1",
        description: "Start a web server",
        terminal: "new",
        background: true,
      },
      { command: "curl -s -o /dev/null localhost:8790/phew-check", description: "Call the server" },
    ];
    if (step < steps.length) return call("run_command", steps[step]);
    if (step === steps.length)
      return call("read_terminal", { terminal: "2", wait_for: "GET /phew-check", timeout_seconds: 10 });
    const results = messages.filter((message) => message.role === "tool").map((message) => message.content);
    return { content: `RESULT ${results.join("\n---\n")}` };
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
  // The keys that requests to /keyed/ carried: the server accepts only the second key of the key command.
  const keyedAuth = [];
  // "Hang once" gets no answer on its first request, until Phew stops that request (Retry).
  let hangs = 0;
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
      if (request.url.startsWith("/keyed/")) {
        keyedAuth.push(request.headers.authorization);
        if (request.headers.authorization !== "Bearer tok-2") {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "The token expired." } }));
          return;
        }
      }
      const data = JSON.parse(body);
      const lastUser = [...(data.messages ?? [])].reverse().find((message) => message.role === "user");
      if (typeof lastUser?.content === "string" && lastUser.content.includes("Hang once") && hangs++ === 0) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`);
        return;
      }
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, keyedAuth })));
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

  const { server, requests, keyedAuth } = await startServer();
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
    console.log("[it] step 1");
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
    assert.match(
      first.messages[0].content,
      /Project overview[\s\S]*About: Integration workspace: A tiny project where Phew fixes math\.js\.[\s\S]*`npm test` → node check\.js/,
      "the agent gets the project brief at the start",
    );
    const prompt = first.messages[0].content;
    assert.match(prompt, /- \.github\/instructions\/math\.instructions\.md: \*\*\/math\.js/, "scoped rules are listed");
    assert.match(prompt, /- lib\/AGENTS\.md: lib\/\*\*/, "a nested AGENTS.md is listed for its folder");
    assert.match(prompt, /- \.cursor\/rules\/release\.mdc: Release checklist/, "a rule by description is listed");
    assert.doesNotMatch(prompt, /MATH-RULE|LIB-RULE|RELEASE-RULE/, "their text is not in the system prompt");
    const ruleCounts = requests.map(
      (request) =>
        request.messages.filter((message) => message.role === "tool" && message.content.includes("MATH-RULE")).length,
    );
    assert.ok(
      ruleCounts.some((count) => count === 1),
      "the rule for math.js comes with the tool result",
    );
    assert.ok(
      ruleCounts.every((count) => count <= 1),
      "and only once in a task",
    );
    assert.deepEqual(
      api.reviews.pendingFiles.map((uri) => path.basename(uri.fsPath)),
      ["math.js"],
    );
    assert.deepEqual(
      sessions.state().reviewList.map((file) => `${file.path} +${file.added} -${file.removed}`),
      ["main/math.js +1 -1"],
      "the list above the input shows the file to review with its lines",
    );
    assert.equal(sessions.reviewUri("file:///etc/passwd"), undefined, "the chat can only name files under review");
    const message = await vscode.commands.executeCommand("phew.generateCommitMessage");
    assert.match(message, /Signed-off-by: Test User <test@example.com>$/);
    assert.doesNotMatch(message, /Co-authored-by/);
    const card = sessions.active.transcript.all().find((item) => item.type === "summary");
    assert.ok(card, "the task ends with a summary card");
    assert.deepEqual(
      card.files.map((item) => `${item.path} +${item.added} -${item.removed}`),
      ["main/math.js +1 -1"],
      "paths are relative to the workspace, with the folder name in a multi-root workspace",
    );
    assert.equal(card.pending, 1, "the card knows the change waits for Keep or Undo");
    await api.reviews.keepAll();
    await api.restoreLatest();
    assert.equal(fs.readFileSync(file, "utf8"), "exports.add = (a, b) => a - b;\n", "the checkpoint restored the file");
    assert.equal((await sessions.listHistory()).length, 1);

    console.log("[it] step 2");
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

    console.log("[it] step 3");
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

    console.log("[it] step 3b");
    // 3b. Commands run in the real terminal of the chat: `cd` and `export` stay for the next command.
    sessions.newSession();
    const shell = sessions.active;
    const shellRun = shell.run({ text: "Shell persists", kind: "chat", mode: "code" });
    let shellDone = false;
    shellRun.then(() => {
      shellDone = true;
    });
    for (let index = 0; index < 600 && !shellDone; index++) {
      const pending = shell.transcript
        .all()
        .filter((item) => item.type === "approval" && item.kind === "command")
        .map((item) => item.id)
        .filter((id) => !shell.transcript.all().some((item) => item.type === "approvalResolved" && item.id === id));
      for (const id of pending) shell.broker.answer(id, true);
      await delay(50);
    }
    await shellRun;
    const shellResult = lastAssistant(shell);
    const tools = shell.transcript
      .all()
      .filter((item) => item.type === "tool" && item.name === "run_command" && item.status !== "running");
    console.log(`[shell] where=${tools.map((item) => item.where).join(",")} result=${JSON.stringify(shellResult)}`);
    const parts = shellResult.replace(/^RESULT /, "").split("\n---\n");
    assert.match(parts[1], /\[exit code 0\]\n\S*\/sub\nx=42/, "cd and export carry over in the real shell");
    assert.match(parts[2], /\[waiting for input\]/, "a nested shell waits for input, like ssh");
    assert.match(parts[3], /inside-42/, "the next command runs inside the nested shell");
    assert.match(parts[4], /\[exit code 0\]/, "exit returns to the shell of the chat with its prompt");
    assert.ok(
      tools.every((item) => item.where === "terminal"),
      "the commands ran in the terminal of the chat",
    );
    assert.match(parts[5], /\[running in the background\]/, "the server keeps running in the background");
    assert.match(parts[6], /\[exit code 0\]/, "the next command runs in another terminal, not in the server");
    assert.match(
      parts[7],
      /^\[terminal 2: a program keeps running\] Found "GET \/phew-check"/,
      "read_terminal waits for the server log",
    );
    assert.equal(shell.terminals.length, 2, "the chat has two terminals");
    assert.ok(
      shell.terminals.some((terminal) => terminal.state === "running" && /http\.server/.test(terminal.command ?? "")),
    );
    shell.terminalAction("2", "kill");
    assert.equal(shell.terminals.length, 1, "closing a terminal removes it");
    assert.ok(
      vscode.window.terminals.some((terminal) => terminal.name.startsWith("Phew")),
      "the chat has its own terminal",
    );

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

    console.log("[it] step 4b");
    // 4b. Stop and send: the new message stops the running step and runs at once.
    const stopping = busy.run({ text: "Slow task three", kind: "chat" });
    await delay(300);
    await busy.submit("Slow task four", [], true);
    await stopping;
    assert.match(lastAssistant(busy), /SLOW-DONE Slow task four/, "the interrupting message ran");
    assert.ok(!busy.busy);

    console.log("[it] step 5");
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

    console.log("[it] step 6");
    // 6. Rename, per-chat approvals, and the context meter.
    other.rename("Renamed chat");
    assert.equal(other.title, "Renamed chat");
    sessions.setApproval(other, "commands", "safe");
    assert.equal(other.effectiveSettings().commands.mode, "safe");
    assert.equal(sessions.state().approvals.custom, true);
    assert.ok(other.contextState().share > 0, "the context meter has a value");

    console.log("[it] step 7");
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
    const suggested = await sessions.suggestions.list();
    assert.equal(suggested[0]?.title, "Fix 1 error in math.js", "the welcome screen offers to fix the errors");
    diagnostics.dispose();
    void secondFolder;

    console.log("[it] step 8");
    // 8. Handoff notes: journal, note, freshness, /continue, and the AGENTS.md pointer.
    fs.writeFileSync(file, "exports.add = (a, b) => a - b;\n");
    sessions.newSession();
    const worker = sessions.active;
    await worker.run({ text: "Make node check.js pass.", kind: "fix", mode: "code" });
    const notePath = await worker.writeHandoff(false);
    assert.match(notePath ?? "", /^\.phew\/handoff\/.+-integration-handoff-.+\.md$/, "the note has a readable name");
    const latest = fs.readFileSync(path.join(mainFolder, ".phew", "handoff", "LATEST.md"), "utf8");
    assert.match(latest, /^---\nschema: "phew-handoff\/1"/);
    assert.match(latest, /# Handoff: Integration handoff/);
    assert.match(latest, /\*\*D1\*\* Use \+ in add/);
    assert.match(latest, /- `math\.js`/, "the changed file comes from the journal");
    assert.match(latest, /## Dead ends: do not repeat\n\n- Changing check\.js/);
    const ignore = fs.readFileSync(path.join(mainFolder, ".phew", ".gitignore"), "utf8");
    assert.match(ignore, /^sessions\/$/m);
    assert.match(ignore, /^handoff\/$/m);
    const journal = fs.readFileSync(path.join(mainFolder, ".phew", "sessions", worker.id, "journal.jsonl"), "utf8");
    assert.match(journal, /"t":"tool","at":\d+,"name":"edit_file"/);
    for (let index = 0; index < 40 && !sessions.state().handoff; index++) await delay(50);
    assert.equal(sessions.state().handoff?.title, "Integration handoff", "the welcome screen offers to continue");

    // Someone changes the code after the note. /continue notices it.
    fs.writeFileSync(file, "exports.add = (a, b) => b + a;\n");
    sessions.newSession();
    const next = sessions.active;
    const before = requests.length;
    await next.submit("/continue");
    const continued = requests.slice(before).find((item) => item.tools?.length > 0);
    const firstUser = continued.messages.find((item) => item.role === "user").content;
    assert.match(firstUser, /Continue the work from the handoff note `\.phew\/handoff\/.+\.md`/);
    assert.match(firstUser, /This file changed after the note: `math\.js`/);
    assert.ok(
      next.transcript.all().some((item) => item.type === "notice" && /math\.js/.test(item.text)),
      "the user sees that the code changed",
    );
    assert.equal(next.title, "Integration handoff");

    await vscode.commands.executeCommand("phew.updateAgentsFile");
    const agents = fs.readFileSync(path.join(mainFolder, "AGENTS.md"), "utf8");
    assert.match(
      agents,
      /<!-- phew:handoff:begin -->[\s\S]*\.phew\/handoff\/LATEST\.md[\s\S]*<!-- phew:handoff:end -->/,
    );

    console.log("[it] fork and edit");
    // Fork from a message: a new chat with the conversation before it; Edit takes this chat back to it.
    sessions.newSession();
    await api.run({ text: "First question.", mode: "ask" });
    await api.run({ text: "Second question.", mode: "ask" });
    const original = sessions.active;
    const users = original.transcript.all().filter((item) => item.type === "user");
    assert.deepEqual(
      users.map((item) => item.text),
      ["First question.", "Second question."],
    );
    const historyLength = original.toStored().history.length;
    await sessions.fork(original, users[1].checkpointId);
    const forked = sessions.active;
    assert.notEqual(forked.id, original.id, "the fork is a new chat");
    assert.match(forked.title, /\(fork\)$/);
    assert.deepEqual(
      forked.toStored().history.map((message) => message.role),
      ["user", "assistant"],
      "the fork keeps the conversation before the message",
    );
    assert.equal(original.toStored().history.length, historyLength, "the original chat stays as it is");
    assert.equal(await original.rewindTo(users[0].checkpointId, true), "First question.");
    assert.equal(original.toStored().history.length, 0, "Edit takes the chat back to before the message");
    assert.ok(!original.transcript.all().some((item) => item.type === "user"));

    const found = await sessions.searchHistory("check.js pass");
    assert.ok(
      found.some((match) => match.snippet.includes("check.js pass")),
      "full-text search finds a chat by its messages",
    );

    console.log("[it] retry");
    // The model says one word and goes quiet; Retry sends the request again, and the task finishes.
    sessions.newSession();
    const hanging = api.run({ text: "Hang once, then answer.", mode: "ask" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(sessions.active.retryRequest(), true, "a model request runs");
    await hanging;
    assert.equal(lastAssistant(sessions.active), "Done.", "the task finished after Retry");
    assert.ok(
      !sessions.active.transcript.all().some((item) => item.type === "assistantDelta" && item.text === "Partial"),
      "the text of the stopped request is gone",
    );

    if (process.platform !== "win32") {
      console.log("[it] key command");
      // A short-lived token from a command: the first one has expired, so Phew runs the command again.
      const counter = path.join(os.tmpdir(), `phew-key-${process.pid}`);
      fs.rmSync(counter, { force: true });
      await config.update(
        "models",
        [
          // The settings of the test profile stay between runs: an old "keyed" model has an old port.
          ...config.get("models").filter((model) => model.id !== "keyed"),
          {
            id: "keyed",
            name: "Keyed",
            provider: "openai",
            baseUrl: `http://127.0.0.1:${port}/keyed/v1`,
            model: "fake-model",
            apiKeyCommand: `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; echo tok-$n`,
          },
        ],
        vscode.ConfigurationTarget.Global,
      );
      await config.update("activeModel", "keyed", vscode.ConfigurationTarget.Global);
      // A chat of its own, so no task of an earlier step is still running in it.
      sessions.newSession();
      await api.run({ text: "Say hello with the keyed model.", mode: "ask" });
      assert.equal(lastAssistant(sessions.active), "Done.", "the task finished with a renewed key");
      assert.deepEqual(keyedAuth.slice(0, 2), ["Bearer tok-1", "Bearer tok-2"], "Phew renewed the key after the 401");
      assert.ok(
        keyedAuth.slice(2).every((auth) => auth === "Bearer tok-2"),
        "later requests reuse the renewed key without running the command again",
      );
      await config.update("activeModel", "fake", vscode.ConfigurationTarget.Global);
      fs.rmSync(counter, { force: true });
    }

    console.log(
      "PHEW_INTEGRATION_OK: fix, review, commit, checkpoint, ask_user, skills, MCP HTTP, multi-root, plan, queue, btw, parallel chats, rename, approvals, context, Phew it!, handoff, summary, suggestions, fork and edit, retry, key command",
    );
  } finally {
    server.close();
  }
}

module.exports = { run };
