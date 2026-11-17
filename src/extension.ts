import * as vscode from "vscode";
import { truncateMiddle } from "./core/chat";
import { isMode, modeInfo, modes } from "./core/modes";
import { buildCommandFixRequest, buildFixRequest } from "./core/prompts";
import { DiffContentProvider, diffScheme } from "./host/changes";
import { ChatViewProvider } from "./host/chatView";
import { describeResult, runShellCommand } from "./host/commandRunner";
import { McpManager } from "./host/mcpManager";
import { fileProblemsRequest, fixProblemCommand, PhewItCodeActionProvider, problemContext } from "./host/phewIt";
import { clearApiKey, configureModel } from "./host/providerSetup";
import { AgentSession, type TaskRequest } from "./host/session";
import { readSettings, section } from "./host/settings";
import { StatsStore } from "./host/statsStore";
import { type FailedCommand, TerminalWatcher } from "./host/terminalWatcher";

let session: AgentSession | undefined;
let mcp: McpManager | undefined;

/** A small API for the integration tests. It exists only when VS Code runs the extension in test mode. */
export interface PhewTestApi {
  run(request: TaskRequest): Promise<void>;
  restoreLatest(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): PhewTestApi | undefined {
  const log = vscode.window.createOutputChannel("Phew", { log: true });
  const view = new ChatViewProvider(context.extensionUri, log);
  const diffs = new DiffContentProvider();
  const stats = new StatsStore(context.globalState);
  mcp = new McpManager(log, String(context.extension.packageJSON.version));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "phew.openChat";
  const updateStatus = (busy: boolean) => {
    status.text = busy ? "$(sync~spin) Phew" : "$(sparkle) Phew";
    status.tooltip = busy
      ? "Phew is working. Click to open the chat."
      : `Phew: ${stats.summary(readSettings().minutesPerBug)}`;
  };
  updateStatus(false);
  status.show();

  session = new AgentSession({
    context,
    log,
    post: (message) => view.post(message),
    diffs,
    mcp,
    stats,
    onBusyChange: (busy) => {
      updateStatus(busy);
      void vscode.commands.executeCommand("setContext", "phew.busy", busy);
    },
  });
  view.attach(session);
  const current = session;

  const start = async (request: TaskRequest) => {
    await view.reveal();
    await current.run(request);
  };

  const fixFailedCommand = (failure: FailedCommand) =>
    start({
      text: buildCommandFixRequest(failure.command, failure.exitCode, truncateMiddle(failure.output, 20_000)),
      display: `Phew it! \`${failure.command}\` failed`,
      kind: "fix",
      mode: "code",
    });

  const terminal = new TerminalWatcher((failure) => {
    if (!readSettings().offerTerminalFix || current.busy) return;
    void vscode.window
      .showInformationMessage(`The command "${failure.command.slice(0, 60)}" failed.`, "Phew it!")
      .then((answer) => {
        if (answer === "Phew it!") void fixFailedCommand(failure);
      });
  });

  context.subscriptions.push(
    log,
    status,
    terminal,
    { dispose: () => current.dispose() },
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view),
    vscode.workspace.registerTextDocumentContentProvider(diffScheme, diffs),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new PhewItCodeActionProvider(), {
      providedCodeActionKinds: PhewItCodeActionProvider.kinds,
    }),

    vscode.commands.registerCommand("phew.openChat", () => view.reveal()),
    vscode.commands.registerCommand("phew.newChat", async () => {
      await view.reveal();
      current.newChat();
    }),
    vscode.commands.registerCommand("phew.stop", () => current.stop()),
    vscode.commands.registerCommand("phew.configureModel", async () => {
      if (await configureModel(context.secrets)) current.postState();
    }),
    vscode.commands.registerCommand("phew.clearApiKey", () => clearApiKey(context.secrets)),
    vscode.commands.registerCommand("phew.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
    ),
    vscode.commands.registerCommand("phew.showLog", () => log.show()),
    vscode.commands.registerCommand("phew.showStats", async () => {
      const answer = await vscode.window.showInformationMessage(
        "Phew statistics",
        { modal: true, detail: stats.details(readSettings().minutesPerBug) },
        "Reset",
      );
      if (answer === "Reset") {
        await stats.reset();
        current.postState();
        updateStatus(current.busy);
      }
    }),
    vscode.commands.registerCommand("phew.setMode", async (value?: unknown) => {
      const mode = isMode(value)
        ? value
        : (
            await vscode.window.showQuickPick(
              modes.map((item) => ({
                label: modeInfo[item].label,
                description: modeInfo[item].description,
                mode: item,
              })),
              { title: "Phew: Mode" },
            )
          )?.mode;
      if (mode) await current.setMode(mode);
    }),

    vscode.commands.registerCommand(fixProblemCommand, async (uri?: vscode.Uri, diagnostic?: vscode.Diagnostic) => {
      let document: vscode.TextDocument | undefined;
      let problem = diagnostic;
      if (uri instanceof vscode.Uri) document = await vscode.workspace.openTextDocument(uri);
      else {
        const editor = vscode.window.activeTextEditor;
        document = editor?.document;
        if (editor && !problem) {
          const line = editor.selection.active.line;
          const all = vscode.languages.getDiagnostics(editor.document.uri);
          problem = all.find((item) => item.range.start.line <= line && item.range.end.line >= line) ?? all[0];
        }
      }
      if (!document || !problem) {
        void vscode.window.showInformationMessage("Phew: no problem found at the cursor.");
        return;
      }
      const context = problemContext(document, problem);
      await start({
        text: buildFixRequest(context),
        display: `Phew it! ${context.path}:${context.line} — ${context.message.split("\n")[0].slice(0, 160)}`,
        kind: "fix",
        mode: "code",
      });
    }),
    vscode.commands.registerCommand("phew.fixFileProblems", async () => {
      const document = vscode.window.activeTextEditor?.document;
      const request = document && fileProblemsRequest(document);
      if (!request) {
        void vscode.window.showInformationMessage("Phew: the active file has no errors.");
        return;
      }
      await start({ text: request, display: "Phew it! Fix all errors in this file", kind: "fix", mode: "code" });
    }),
    vscode.commands.registerCommand("phew.fixLastCommand", async () => {
      const failure = terminal.lastFailure;
      if (!failure) {
        void vscode.window.showInformationMessage(
          "Phew: no failed terminal command yet. Phew needs terminal shell integration to see commands.",
        );
        return;
      }
      await fixFailedCommand(failure);
    }),
    vscode.commands.registerCommand("phew.makeChecksPass", async () => {
      const settings = readSettings();
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!settings.verifyCommand) {
        const answer = await vscode.window.showInformationMessage(
          "Set the check command first, for example npm test.",
          "Open Setting",
        );
        if (answer) await vscode.commands.executeCommand("workbench.action.openSettings", "phew.verify.command");
        return;
      }
      if (!folder || !vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage("Phew: open a trusted folder to run the checks.");
        return;
      }
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Phew: running ${settings.verifyCommand}`,
          cancellable: true,
        },
        (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return runShellCommand(
            settings.verifyCommand,
            folder.uri.fsPath,
            settings.commandTimeoutSeconds,
            controller.signal,
          );
        },
      );
      if (result.cancelled) return;
      if (result.exitCode === 0) {
        void vscode.window.showInformationMessage("Phew! All checks pass already.");
        return;
      }
      await start({
        text: [
          "The project checks fail. Make them pass.",
          "```",
          truncateMiddle(describeResult(settings.verifyCommand, result), 20_000),
          "```",
        ].join("\n"),
        display: `Phew it! Make \`${settings.verifyCommand}\` pass`,
        kind: "fix",
        mode: "code",
      });
    }),
    vscode.commands.registerCommand("phew.askSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage("Phew: select some code first.");
        return;
      }
      const question = await vscode.window.showInputBox({
        title: "Phew: Ask about the selection",
        value: "Explain this code.",
      });
      if (!question) return;
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      const path = folder ? vscode.workspace.asRelativePath(editor.document.uri, false) : editor.document.fileName;
      const start_ = editor.selection.start.line + 1;
      const code = editor.document.getText(editor.selection);
      await start({
        text: `${question}\n\nCode from ${path}, starting at line ${start_}:\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\``,
        display: `${question} (${path}:${start_})`,
        kind: "chat",
      });
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(section)) {
        current.postState();
        updateStatus(current.busy);
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => current.postState()),
  );

  log.info(`Phew ${context.extension.packageJSON.version} activated.`);
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return { run: (request) => current.run(request), restoreLatest: () => current.restoreLatestForTest() };
}

export function deactivate(): void {
  session?.dispose();
  mcp?.dispose();
  session = undefined;
  mcp = undefined;
}
