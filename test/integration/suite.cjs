const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

/** A fake OpenAI-compatible server that edits math.js and then answers. */
function startServer() {
  const requests = [];
  const replies = [
    {
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
    },
    { content: "**Problem:** add subtracted.\n**Cause:** wrong operator.\n**Fix:** use +." },
  ];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const delta = replies[requests.length - 1] ?? { content: "Done." };
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
  for (const command of ["phew.openChat", "phew.fixProblem", "phew.makeChecksPass", "phew.configureModel"]) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }

  const { server, requests } = await startServer();
  const port = server.address().port;
  const config = vscode.workspace.getConfiguration("phew");
  await config.update("model.baseUrl", `http://127.0.0.1:${port}/v1`, vscode.ConfigurationTarget.Global);
  await config.update("model.name", "fake-model", vscode.ConfigurationTarget.Global);

  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = path.join(folder, "math.js");
  try {
    await api.run({ text: "Make node check.js pass.", kind: "fix", mode: "code" });
    assert.equal(fs.readFileSync(file, "utf8"), "exports.add = (a, b) => a + b;\n", "the agent fixed the file");
    assert.equal(requests.length, 2, "two model calls");
    assert.equal(requests[0].model, "fake-model");
    assert.match(requests[0].messages[0].content, /You are Phew/);
    assert.ok(
      requests[0].tools.some((tool) => tool.function.name === "edit_file"),
      "Code mode has edit tools",
    );
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.match(requests[1].messages.at(-1).content, /Applied the change to math\.js/);

    await api.restoreLatest();
    assert.equal(fs.readFileSync(file, "utf8"), "exports.add = (a, b) => a - b;\n", "the checkpoint restored the file");

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
    console.log("PHEW_INTEGRATION_OK: fix, check, checkpoint restore, Phew it!");
  } finally {
    server.close();
  }
}

module.exports = { run };
