const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

/** A fake OpenAI-compatible server. Tool requests edit math.js; requests without tools get a commit message. */
function startServer() {
  const requests = [];
  let agentStep = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const data = JSON.parse(body);
      requests.push(data);
      let delta;
      if (!data.tools || data.tools.length === 0) {
        delta = {
          content:
            "fix(math): add numbers instead of subtracting\n\nThe add function used minus.\n\nCo-authored-by: Robot <robot@example.com>",
        };
      } else if (agentStep++ === 0) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({ path: "math.js", old_text: "a - b", new_text: "a + b" }),
              },
            },
          ],
        };
      } else delta = { content: "**Problem:** add subtracted.\n**Cause:** wrong operator.\n**Fix:** use +." };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests })));
}

async function run() {
  const extension = vscode.extensions.getExtension("alekseialeinikov.phew");
  assert.ok(extension, "the extension is installed");
  const api = await extension.activate();
  assert.ok(api, "the test API exists in test mode");

  const commands = await vscode.commands.getCommands(true);
  const expected = extension.packageJSON.contributes.commands.map((command) => command.command);
  for (const command of expected) assert.ok(commands.includes(command), `${command} is registered`);

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
      },
    ],
    vscode.ConfigurationTarget.Global,
  );
  await config.update("activeModel", "fake", vscode.ConfigurationTarget.Global);

  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = path.join(folder, "math.js");
  try {
    // Fix, check, and review in the editor.
    await api.run({ text: "Make node check.js pass.", kind: "fix", mode: "code" });
    assert.equal(fs.readFileSync(file, "utf8"), "exports.add = (a, b) => a + b;\n", "the agent fixed the file");
    const agentRequests = requests.filter((item) => item.tools && item.tools.length > 0);
    assert.equal(agentRequests.length, 2, "two model calls and the check passed at once");
    assert.equal(agentRequests[0].model, "fake-model");
    assert.match(agentRequests[0].messages[0].content, /You are Phew/);
    for (const tool of ["edit_file", "search_code", "git_diff", "remember"]) {
      assert.ok(
        agentRequests[0].tools.some((item) => item.function.name === tool),
        `Code mode has ${tool}`,
      );
    }
    assert.match(agentRequests[1].messages.at(-1).content, /Applied the change to math\.js/);
    assert.deepEqual(
      api.reviews.pendingFiles.map((uri) => path.basename(uri.fsPath)),
      ["math.js"],
      "the change waits for review",
    );
    const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", vscode.Uri.file(file));
    assert.ok(
      lenses.some((lens) => lens.command?.title.includes("Keep")),
      "Keep buttons in the editor",
    );

    // The chat is saved.
    const history = await api.sessions.listHistory();
    assert.equal(history.length, 1, "the chat is in the history");
    assert.match(history[0].title, /Make node check/);

    // Commit message with the configured sign-off and without invented co-authors.
    const message = await vscode.commands.executeCommand("phew.generateCommitMessage");
    assert.equal(
      message,
      "fix(math): add numbers instead of subtracting\n\nThe add function used minus.\n\nSigned-off-by: Test User <test@example.com>",
    );

    // Keep the review, then restore the checkpoint.
    await api.reviews.keepAll();
    assert.equal(api.reviews.pendingFiles.length, 0);
    await api.restoreLatest();
    assert.equal(fs.readFileSync(file, "utf8"), "exports.add = (a, b) => a - b;\n", "the checkpoint restored the file");

    // Code index.
    const hits = await api.index.search(vscode.Uri.file(folder), "add function", 5, new AbortController().signal);
    assert.ok(
      hits.some((hit) => hit.path.endsWith("math.js")),
      "the code index finds math.js",
    );

    // Phew it! on errors.
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
    assert.ok(
      actions.some((action) => action.title === "Phew it! Fix with Phew"),
      "Phew it! is offered on errors",
    );
    diagnostics.dispose();

    // A new chat starts empty, and the old chat opens again from the history.
    api.sessions.newSession();
    assert.ok(api.sessions.active.isEmpty);
    await api.sessions.openConversation(history[0].id);
    assert.ok(!api.sessions.active.isEmpty, "the saved chat opens again");

    console.log(
      "PHEW_INTEGRATION_OK: models, fix, check, editor review, history, commit message, checkpoint, index, Phew it!",
    );
  } finally {
    server.close();
  }
}

module.exports = { run };
