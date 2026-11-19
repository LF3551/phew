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

/** Several tool calls in one step, such as subagents that run in parallel. */
const calls = (...items) => ({
  tool_calls: items.map(([name, args], index) => ({
    index,
    id: `call_${name}_${index}`,
    function: { name, arguments: JSON.stringify(args) },
  })),
});

/** A subagent: it reads what its task names and reports, or tries what it must not do. */
function subagentScript(messages) {
  const task = taskOf(messages);
  const step = stepOf(messages);
  if (task.startsWith("SUB-EDIT"))
    return step === 0
      ? call("edit_file", { path: "math.js", old_text: "a", new_text: "HACKED" })
      : { content: `BLOCKED ${lastToolResult(messages)}` };
  if (step === 0) return call("read_file", { path: task.startsWith("SUB-B") ? "check.js" : "math.js" });
  const first = lastToolResult(messages)
    .split("\n")
    .find((line) => line.includes("exports") || line.includes("add"));
  return { content: `FOUND-${task.slice(4, 5)} ${first ?? "nothing"}` };
}

/** A scripted model. Each task has its own steps. */
async function script(data) {
  const messages = data.messages;
  if (data.tools?.length > 0 && /You are a subagent of Phew/.test(messages[0].content)) return subagentScript(messages);
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
  if (task.startsWith("Delegate research"))
    return step === 0
      ? calls(
          ["delegate", { title: "Find add", task: "SUB-A: find the add function in math.js" }],
          ["delegate", { title: "Read the check", task: "SUB-B: read check.js", model: "personal" }],
          ["delegate", { title: "Ask the work key", task: "SUB-C: find add with the work key", model: "work" }],
        )
      : {
          content: `RESULT ${messages
            .filter((message) => message.role === "tool")
            .map((message) => message.content)
            .join("\n---\n")}`,
        };
  if (task.startsWith("Delegate an edit"))
    return step === 0
      ? call("delegate", { title: "Try to edit", task: "SUB-EDIT: change math.js" })
      : { content: `RESULT ${lastToolResult(messages)}` };
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
  // Which model got each request, by the first part of its path: "v1" (Fake), "work", or "personal".
  const routed = [];
  // "Hang once" gets no answer on its first request, until Phew stops that request (Retry).
  let hangs = 0;
  // "Go quiet" also gets no answer once, for the quiet model in the list of chats.
  let quiets = 0;
  // Requests of subagents: how many ran at once, and which tools they were offered.
  const subagents = { running: 0, peak: 0, tools: new Set() };
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
      const route = request.url.split("/")[1];
      // The first message of a chat can come in parts, with the context of the project.
      const userText = (data.messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : (message.content ?? []).map((part) => part.text ?? "").join("\n"),
        )
        .join("\n");
      routed.push({ route, text: userText });
      if (route === "work") {
        // The work key has no quota left, the way OpenAI says it.
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ error: { type: "insufficient_quota", message: "You exceeded your current quota." } }),
        );
        return;
      }
      const hangText = typeof lastUser?.content === "string" ? lastUser.content : "";
      if ((hangText.includes("Hang once") && hangs++ === 0) || (hangText.includes("Go quiet") && quiets++ === 0)) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`);
        return;
      }
      requests.push(data);
      const isSubagent = /You are a subagent of Phew/.test(data.messages?.[0]?.content ?? "");
      if (isSubagent) {
        subagents.running++;
        subagents.peak = Math.max(subagents.peak, subagents.running);
        for (const tool of data.tools ?? []) subagents.tools.add(tool.function.name);
        // Long enough for the subagents of one step to overlap.
        await delay(400);
        subagents.running--;
      }
      const delta = await script(data);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, keyedAuth, routed, subagents })),
  );
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

  const { server, requests, keyedAuth, routed, subagents } = await startServer();
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
    assert.match(
      prompt,
      /Project memory, facts saved in earlier chats:\n- add\(\) lives in math\.js \(from math\.js\)\. math\.js changed after this note: check it\.\n- Run node check\.js to test/,
      "memory comes with its source, and a changed source asks for a check",
    );
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

    // @chat: an earlier chat comes to the agent with what was asked and answered there.
    const mentions = await sessions.chatMentions("", undefined);
    const earlier = mentions.find((item) => item.attachment.kind === "chat" && item.attachment.id === forked.id);
    assert.ok(earlier, "@ offers the recent chats");
    assert.ok(
      (await sessions.chatMentions(forked.title.split(" ")[0], undefined)).some(
        (item) => item.attachment.id === forked.id,
      ),
      "@ finds a chat by a word of its title",
    );
    const beforeChat = requests.length;
    sessions.newSession();
    await api.run({ text: "What did we do there?", mode: "ask", attachments: [earlier.attachment] });
    const withChat = requests
      .slice(beforeChat)
      .flatMap((request) => request.messages)
      .find((message) => message.role === "user" && message.content.includes("What did we do there?"));
    assert.match(
      withChat.content,
      /Earlier chat "[^"]*"[\s\S]*User: First question\./,
      "the agent gets the earlier chat",
    );

    const found = await sessions.searchHistory("check.js pass");
    assert.ok(
      found.some((match) => match.snippet.includes("check.js pass")),
      "full-text search finds a chat by its messages",
    );

    console.log("[it] rating");
    // A regular user: 10 tasks on 3 days, the first use 10 days ago. A fix that works is a good moment to ask once.
    const day = 86_400_000;
    const saved = {
      stats: api.globalState.get("phew.stats"),
      activity: api.globalState.get("phew.activity"),
      rating: api.globalState.get("phew.rating"),
    };
    const dayOf = (offset) => new Date(Date.now() - offset * day).toISOString().slice(0, 10);
    await api.globalState.update("phew.stats", {
      tasksCompleted: 10,
      bugsFixed: 4,
      filesChanged: 12,
      tokens: 1000,
      cost: 0,
      firstUse: Date.now() - 10 * day,
    });
    await api.globalState.update(
      "phew.activity",
      [5, 3, 1].map((offset) => ({
        day: dayOf(offset),
        tasks: 3,
        bugs: 1,
        tokens: 100,
        cost: 0,
        verifiedFirstTry: 0,
        nightTasks: 0,
        models: {},
      })),
    );
    await api.globalState.update("phew.rating", undefined);
    // The file changes through the editor, so the open document and the disk agree.
    const setMath = async (text) => {
      const document = await vscode.workspace.openTextDocument(file);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
      await vscode.workspace.applyEdit(edit);
      await document.save();
    };
    await setMath("exports.add = (a, b) => a - b;\n");
    sessions.newSession();
    await api.run({ text: "Make node check.js pass.", kind: "fix", mode: "code" });
    await api.reviews.keepAll();
    assert.equal(api.globalState.get("phew.rating")?.asked, 1, "a task that went well asks for a rating once");
    await setMath("exports.add = (a, b) => a - b;\n");
    sessions.newSession();
    await api.run({ text: "Make node check.js pass.", kind: "fix", mode: "code" });
    await api.reviews.keepAll();
    assert.equal(api.globalState.get("phew.rating")?.asked, 1, "and not again within a month");
    await sessions.answerRating("never");
    assert.equal(api.globalState.get("phew.rating")?.done, "never", "Don't ask again is kept");
    for (const [key, value] of Object.entries({
      "phew.stats": saved.stats,
      "phew.activity": saved.activity,
      "phew.rating": saved.rating,
    }))
      await api.globalState.update(key, value);

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

    console.log("[it] models of chats");
    // Two keys of one provider are two models. Each chat keeps its own model, so chats and windows work in
    // parallel with different keys, and a choice in one never moves another.
    const global = vscode.ConfigurationTarget.Global;
    // A configuration object is a snapshot, so each read takes a fresh one.
    const current = (key) => vscode.workspace.getConfiguration("phew").get(key);
    const baseModels = current("models").filter((model) => model.id !== "work" && model.id !== "personal");
    const setModels = (workFallback) =>
      config.update(
        "models",
        [
          ...baseModels,
          {
            id: "work",
            name: "Claude (work)",
            provider: "openai",
            baseUrl: `http://127.0.0.1:${port}/work/v1`,
            model: "fake-model",
            auth: "none",
            ...(workFallback ? { fallback: workFallback } : {}),
          },
          {
            id: "personal",
            name: "Claude (personal)",
            provider: "openai",
            baseUrl: `http://127.0.0.1:${port}/personal/v1`,
            model: "fake-model",
            auth: "none",
          },
        ],
        global,
      );
    const routesOf = (text) => routed.filter((item) => item.text.includes(text)).map((item) => item.route);
    const notices = (session) =>
      session.transcript
        .all()
        .filter((item) => item.type === "notice")
        .map((item) => item.text);
    await setModels(undefined);
    sessions.newSession();
    const chatA = sessions.active;
    await sessions.useModel("personal");
    // A new chat reuses an empty one, so chat A says something first.
    await chatA.run({ text: "Chat A starts", kind: "chat", mode: "ask" });
    sessions.newSession();
    const chatB = sessions.active;
    assert.notEqual(chatB, chatA, "chat B is a chat of its own");
    await sessions.useModel("fake");
    assert.equal(chatA.chatModelId, "personal", "the menu chose the model of chat A");
    assert.equal(chatB.chatModelId, "fake", "and of chat B, without changing chat A");
    assert.equal(current("activeModel"), "fake", "the last choice is the default for new chats");
    assert.equal(sessions.state().model, "Fake", "the chat shows its own model");
    assert.equal(sessions.state().models.find((model) => model.active)?.id, "fake", "and marks it in the menu");
    await Promise.all([
      chatA.run({ text: "Chat A at work", kind: "chat", mode: "ask" }),
      chatB.run({ text: "Chat B at home", kind: "chat", mode: "ask" }),
    ]);
    assert.deepEqual([...new Set(routesOf("Chat A at work"))], ["personal"], "chat A asked its own model");
    assert.deepEqual([...new Set(routesOf("Chat B at home"))], ["v1"], "chat B asked its own model at the same time");
    // Another window chooses another model: that changes the default, not this chat.
    await config.update("activeModel", "work", global);
    await chatA.run({ text: "Chat A again", kind: "chat", mode: "ask" });
    assert.deepEqual([...new Set(routesOf("Chat A again"))], ["personal"], "chat A keeps its model");
    assert.equal(chatA.toStored().model, "personal", "the model is saved with the chat");
    // A chat without its own model takes the default at its first task, and keeps it.
    await config.update("activeModel", "personal", global);
    sessions.newSession();
    const chatC = sessions.active;
    assert.equal(chatC.chatModelId, undefined, "a new chat has no model of its own yet");
    await chatC.run({ text: "Chat C pins", kind: "chat", mode: "ask" });
    assert.equal(chatC.chatModelId, "personal", "its first task pinned the default");
    await config.update("activeModel", "fake", global);
    assert.equal(chatC.currentProfile?.id, "personal", "a later default does not move it");

    console.log("[it] fallback model");
    // Without a fallback, a key without quota stops the task with a clear message.
    sessions.newSession();
    const broke = sessions.active;
    await sessions.useModel("work");
    await broke.run({ text: "No credit left", kind: "chat", mode: "ask" });
    assert.deepEqual(routesOf("No credit left"), ["work"], "Phew does not retry a missing quota");
    assert.ok(
      notices(broke).some((text) => /no quota or credit left/.test(text)),
      "the chat says that the quota is gone",
    );
    const rowOf = (session) => sessions.summaries().find((row) => row.id === session.id);
    assert.equal(rowOf(broke).outcome, "failed", "the list of chats marks the chat that failed");
    assert.match(broke.failure, /no quota or credit left/, "and knows why, for the notification");
    assert.equal(broke.clearOutcome(), true, "opening the chat clears the mark");
    assert.equal(rowOf(broke).outcome, undefined, "and the list shows its time again");
    // With a fallback, the second key goes on with the same task.
    await setModels("personal");
    sessions.newSession();
    const rescued = sessions.active;
    await sessions.useModel("work");
    await rescued.run({ text: "Fallback please", kind: "chat", mode: "ask" });
    assert.deepEqual(routesOf("Fallback please"), ["work", "personal"], "the fallback got the same request");
    assert.equal(lastAssistant(rescued), "Done.", "the task finished with the fallback model");
    assert.ok(
      notices(rescued).includes("Claude (work) has no quota or credit left. Claude (personal) goes on with the task."),
      "the chat says which model took over and why",
    );
    assert.equal(rescued.chatModelId, "work", "the chat keeps its model and tries it again next time");
    console.log("[it] subagents");
    // The agent gives three research tasks to subagents with different models; they run in parallel, only read,
    // and their reports come back. One model has no quota, so its fallback finishes that subagent.
    sessions.newSession();
    const lead = sessions.active;
    await sessions.useModel("fake");
    const mathBefore = fs.readFileSync(file, "utf8");
    await lead.run({ text: "Delegate research", kind: "chat", mode: "code" });
    const leadRequest = requests.find(
      (request) => request.messages.some((message) => message.content === "Delegate research") && request.tools,
    );
    const delegate = leadRequest.tools.find((tool) => tool.function.name === "delegate");
    assert.ok(delegate, "the agent of a chat has the delegate tool");
    assert.deepEqual(
      delegate.function.parameters.properties.model.enum,
      ["fake", "work", "personal"],
      "and may choose any model of the user for a subagent",
    );
    const cards = lead.transcript.all().filter((item) => item.type === "subagent");
    assert.equal(cards.length, 3, "each subagent has one card, updated in place");
    const cardTitled = (title) => cards.find((item) => item.title === title);
    assert.deepEqual(
      cards.map((item) => item.status),
      ["done", "done", "done"],
      "all three finished",
    );
    assert.equal(cardTitled("Find add").model, "Fake", "without a model, a subagent uses the model of the chat");
    assert.equal(
      cardTitled("Read the check").model,
      "Claude (personal)",
      "a subagent works with the model it was given",
    );
    assert.equal(cardTitled("Ask the work key").fallback, "Claude (personal)", "a subagent falls back like a chat");
    assert.ok(
      cards.every(
        (item) =>
          item.stepCount === 1 &&
          item.steps
            .filter((step) => step.name !== "fallback")
            .map((step) => step.name)
            .join() === "read_file" &&
          /FOUND-/.test(item.report),
      ),
      `the cards show the steps and the reports ${JSON.stringify(cards.map((item) => [item.title, item.stepCount, item.steps, item.report]))}`,
    );
    assert.deepEqual([...new Set(routesOf("SUB-B: read check.js"))], ["personal"], "the requests went to that model");
    assert.deepEqual(routesOf("SUB-C: find add with the work key").slice(0, 2), ["work", "personal"]);
    assert.ok(
      /no quota or credit left; Claude \(personal\) goes on/.test(
        cardTitled("Ask the work key").steps.find((step) => step.name === "fallback")?.summary,
      ),
      "the card of C says why it switched",
    );
    assert.ok(subagents.peak >= 2, `subagents ran in parallel (at most ${subagents.peak} at once)`);
    for (const tool of ["edit_file", "write_file", "run_command", "delegate", "ask_user", "remember", "update_plan"])
      assert.ok(!subagents.tools.has(tool), `a subagent is not offered ${tool}`);
    assert.ok(subagents.tools.has("read_file") && subagents.tools.has("search_text"), "it reads and searches");
    const answer = lastAssistant(lead);
    assert.match(answer, /The subagent \(Fake\) finished in 2 steps[\s\S]*FOUND-A/, "the report of A came back");
    assert.match(answer, /The subagent \(Claude \(personal\)\) finished[\s\S]*FOUND-B/, "and of B");
    assert.match(answer, /Claude \(personal\) \(fallback for Claude \(work\)\)[\s\S]*FOUND-C/, "and of C");
    assert.ok(
      !lead.transcript.all().some((item) => item.type === "tool" && item.name === "delegate"),
      "a subagent shows as its card, not as a tool line",
    );
    // Whatever the model of a subagent asks, it cannot change a file.
    sessions.newSession();
    const tempted = sessions.active;
    await sessions.useModel("fake");
    await tempted.run({ text: "Delegate an edit", kind: "chat", mode: "code" });
    assert.match(lastAssistant(tempted), /BLOCKED Error: a subagent cannot use edit_file\. It only reads\./);
    assert.equal(fs.readFileSync(file, "utf8"), mathBefore, "the file did not change");
    assert.equal(api.reviews.pendingFiles.length, 0, "and nothing waits for review");
    // Subagents can be turned off.
    await vscode.workspace.getConfiguration("phew").update("subagents.enabled", false, global);
    sessions.newSession();
    const plain = sessions.active;
    await sessions.useModel("fake");
    await plain.run({ text: "No helpers today", kind: "chat", mode: "code" });
    const plainRequest = requests.findLast((request) =>
      request.messages.some((message) => message.content === "No helpers today"),
    );
    assert.ok(!plainRequest.tools.some((tool) => tool.function.name === "delegate"), "then the tool is gone");
    await vscode.workspace.getConfiguration("phew").update("subagents.enabled", undefined, global);

    // While a fallback runs the task, the list says so.
    sessions.newSession();
    const slow = sessions.active;
    await sessions.useModel("work");
    const slowRun = slow.run({ text: "Slow fallback", kind: "chat", mode: "ask" });
    let onFallback;
    for (let index = 0; index < 60 && !onFallback; index++) {
      onFallback = rowOf(slow)?.fallback;
      if (!onFallback) await delay(50);
    }
    assert.equal(onFallback, "Claude (personal)", "the list shows the fallback that runs the task");
    await slowRun;
    assert.equal(rowOf(slow).fallback, undefined, "and forgets it when the task ends");
    assert.equal(rowOf(slow).outcome, "done", "the list marks the finished chat");

    console.log("[it] quiet model");
    // A model that sends nothing for a minute: the list marks the chat, and Retry clears it.
    await sessions.useModel("fake");
    sessions.newSession();
    const quiet = sessions.active;
    await sessions.useModel("fake");
    const quietRun = quiet.run({ text: "Go quiet, then answer.", kind: "chat", mode: "ask" });
    await delay(1500);
    sessions.checkStalls();
    assert.ok(!rowOf(quiet)?.stalled, "a short silence is not a stall");
    sessions.checkStalls(Date.now() + 61_000);
    assert.equal(rowOf(quiet)?.stalled, true, "a minute of silence marks the chat");
    assert.equal(quiet.retryRequest(), true, "the request can be sent again");
    await quietRun;
    assert.equal(lastAssistant(quiet), "Done.", "the task finished after Retry");
    assert.ok(!rowOf(quiet)?.stalled, "and the mark is gone");

    console.log("[it] worktree agent with its own model");
    // An agent on its own branch and folder, with the model chosen for it; the chats around keep theirs.
    const branch = `phew/it-model-${Date.now().toString(36)}`;
    const defaultBefore = current("activeModel");
    const agent = await sessions.newWorktreeAgent({ task: "Worktree hello", model: "personal", branch });
    assert.ok(agent, "the worktree agent started");
    try {
      assert.equal(agent.chatModelId, "personal", "the agent has the model chosen for it");
      assert.equal(current("activeModel"), defaultBefore, "the default of other chats did not change");
      for (let index = 0; index < 100 && (agent.busy || !agent.outcome); index++) await delay(100);
      assert.equal(agent.outcome, "done", "the agent finished");
      assert.deepEqual([...new Set(routesOf("Worktree hello"))], ["personal"], "it worked with its own model");
      assert.equal(agent.worktree.branch, branch, "on its own branch");
      assert.ok(fs.existsSync(agent.worktree.path), "in its own folder");
    } finally {
      const git = (...args) =>
        require("node:child_process").execFileSync("git", args, { cwd: agent?.worktree?.repository ?? mainFolder });
      if (agent?.worktree) {
        git("worktree", "remove", "--force", agent.worktree.path);
        git("branch", "-D", branch);
      }
    }
    // Removing a model also removes it as a fallback.
    await api.models.delete("personal");
    const afterDelete = current("models");
    assert.ok(!afterDelete.some((model) => model.id === "personal"), "the model is gone");
    assert.equal(afterDelete.find((model) => model.id === "work").fallback, undefined, "and so is the fallback to it");
    assert.equal(chatA.currentProfile?.id, current("activeModel"), "a chat whose model was removed uses the default");

    console.log("[it] memory from many chats");
    // Many chats save notes at the same moment; none is lost, and no lock stays behind.
    const root = vscode.Uri.file(mainFolder);
    const facts = Array.from(
      { length: 20 },
      (_, index) => `Parallel fact ${index}: service ${index} listens on ${8000 + index}`,
    );
    await Promise.all(facts.map((fact) => api.memory.add(root, fact)));
    const remembered = await api.memory.read(root);
    for (const fact of facts) assert.ok(remembered.includes(fact), `the memory kept "${fact}"`);
    await Promise.all(facts.map((fact) => api.memory.forget(root, fact)));
    const left = await api.memory.read(root);
    assert.ok(!facts.some((fact) => left.includes(fact)), "and forgot each of them");
    assert.ok(!fs.existsSync(path.join(mainFolder, ".phew", "memory.md.lock")), "no lock stays behind");
    await config.update("models", baseModels, global);
    await config.update("activeModel", "fake", global);

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
      "PHEW_INTEGRATION_OK: fix, review, commit, checkpoint, ask_user, skills, MCP HTTP, multi-root, plan, queue, btw, parallel chats, rename, approvals, context, Phew it!, handoff, summary, suggestions, fork and edit, rating, retry, models of chats, fallback, chat status, quiet model, subagents, worktree agent model, memory from many chats, key command",
    );
  } finally {
    server.close();
  }
}

module.exports = { run };
