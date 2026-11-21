import * as vscode from "vscode";
import { activityBadge } from "./core/activity";
import type { Attachment } from "./core/attachments";
import { attachmentLabel } from "./core/attachments";
import { truncateMiddle } from "./core/chat";
import { usageCost } from "./core/cost";
import { findMode } from "./core/modes";
import { buildCommandFixRequest, buildFixRequest } from "./core/prompts";
import { MentionProvider } from "./host/attachments";
import { DiffContentProvider, diffScheme } from "./host/changes";
import { ChatPanels, ChatViewProvider } from "./host/chatView";
import { CodeIndexManager } from "./host/codeIndexManager";
import { describeResult, runShellCommand } from "./host/commandRunner";
import { CommitAssistant } from "./host/commitAssistant";
import { CompletionProvider, NextEditPredictor } from "./host/completions";
import { HandoffService } from "./host/handoffs";
import { rememberLog } from "./host/logMemory";
import { McpManager } from "./host/mcpManager";
import { MemoryStore } from "./host/memoryStore";
import { ModelManager } from "./host/models";
import { fileProblemsRequest, fixProblemCommand, PhewItCodeActionProvider, problemContext } from "./host/phewIt";
import { PlanUsageService } from "./host/planUsage";
import { PriceCatalogService } from "./host/priceCatalog";
import { RatingService } from "./host/rating";
import { reportProblem } from "./host/reportProblem";
import { ReviewManager } from "./host/reviewManager";
import type { TaskRequest } from "./host/session";
import { SessionManager } from "./host/sessionManager";
import { readSettings, section } from "./host/settings";
import { SettingsPanel } from "./host/settingsPanel";
import { SkillStore } from "./host/skillStore";
import { StatsStore } from "./host/statsStore";
import { SuggestionProvider } from "./host/suggestions";
import { type FailedCommand, TerminalWatcher } from "./host/terminalWatcher";

/** A small API for the integration tests. It exists only when VS Code runs the extension in test mode. */
export interface PhewTestApi {
  run(request: TaskRequest): Promise<void>;
  restoreLatest(): Promise<void>;
  sessions: SessionManager;
  reviews: ReviewManager;
  index: CodeIndexManager;
  /** The global state of the extension, to set up statistics and the rating state in tests. */
  globalState: vscode.Memento;
  /** The models, to test fallbacks and removing a model. */
  models: ModelManager;
  /** The memory files, to test writes from several chats at once. */
  memory: MemoryStore;
  /** The settings page, to click through it in tests. */
  settings: SettingsPanel;
  /** The prices from the catalog, updated by hand in tests. */
  prices: PriceCatalogService;
  /** The text of a bug report, without the editor and the questions. */
  reportProblem(description: string): Promise<string | undefined>;
}

let disposeAll: (() => void) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<PhewTestApi | undefined> {
  // The log keeps its latest lines for Phew: Report a Problem.
  const { channel: log, recent: recentLog } = rememberLog(vscode.window.createOutputChannel("Phew", { log: true }));
  const diffs = new DiffContentProvider();
  const stats = new StatsStore(context.globalState);
  const rating = new RatingService(context.globalState, stats);
  const models = new ModelManager(context.secrets, log);
  const mcp = new McpManager(context.secrets, String(context.extension.packageJSON.version));
  const skills = new SkillStore();
  const memory = new MemoryStore();
  const mentions = new MentionProvider();
  let sessions: SessionManager | undefined;
  let chatView: ChatViewProvider | undefined;
  const index = new CodeIndexManager(context.globalStorageUri, models, log, () => sessions?.postState());

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "phew.openChat";
  const reviews = new ReviewManager((files) => {
    updateStatus();
    sessions?.postState();
    void files;
  });
  const updateStatus = () => {
    const running = sessions?.runningCount ?? 0;
    const model = sessions?.active?.currentProfile ?? models.active();
    const pending = reviews.pendingFiles.length;
    status.text =
      running > 0
        ? `$(sync~spin) Phew${running > 1 ? ` ${running}` : ""}`
        : pending > 0
          ? `$(sparkle) Phew · ${pending} to review`
          : "$(sparkle) Phew";
    status.tooltip = `Phew · ${model ? model.name : "no model"} · ${stats.summary(readSettings().minutesPerBug)}`;
    status.command = pending > 0 && running === 0 ? "phew.review.next" : "phew.openChat";
  };
  status.show();

  const terminal = new TerminalWatcher((failure) => {
    if (!readSettings().offerTerminalFix || (sessions?.active?.busy ?? false)) return;
    void vscode.window
      .showInformationMessage(`The command "${failure.command.slice(0, 60)}" failed.`, "Phew it!")
      .then((answer) => {
        if (answer === "Phew it!") void fixFailedCommand(failure);
      });
  });
  mentions.lastExecution = () => terminal.lastExecution;

  const handoffs = new HandoffService(context.workspaceState, log, () => sessions?.postState());
  // The plans of the models: checked only when the user clicks the plan of a model with Show plan on.
  const plans = new PlanUsageService(
    (profile) => models.apiKey(profile),
    log,
    async () =>
      (
        await vscode.authentication
          .getSession("github", ["read:user"], { silent: true })
          .then(undefined, () => undefined)
      )?.accessToken,
  );
  const manager = new SessionManager(
    { context, log, diffs, mcp, stats, rating, models, reviews, index, memory, skills, terminal, handoffs, plans },
    (running) => {
      updateStatus();
      chatView?.showActivity(running > 0, activityBadge(manager.activity, readSettings().assistant.name));
      panels?.refreshTitles();
      void vscode.commands.executeCommand("setContext", "phew.busy", running > 0);
    },
  );
  sessions = manager;
  let panels: ChatPanels | undefined;
  const view = new ChatViewProvider(context.extensionUri, log, manager, mentions);
  chatView = view;
  view.onVisible = () => manager.markSeen();
  panels = new ChatPanels(context.extensionUri, log, manager, mentions);
  await manager.initialize();
  updateStatus();

  const settingsPanel = new SettingsPanel(context, models, index, memory, stats, plans);
  // Prices: filled from the public catalog of OpenRouter once a day; a price of the user is never changed.
  const prices = new PriceCatalogService(context.globalState, models, log);
  const updatePrices = () => void prices.apply().catch(() => undefined);
  // Tests update the prices themselves, so the settings never change under them.
  const automatic = context.extensionMode !== vscode.ExtensionMode.Test;
  const firstPrices = automatic ? setTimeout(updatePrices, 5000) : undefined;
  const dailyPrices = automatic ? setInterval(updatePrices, 6 * 60 * 60_000) : undefined;
  context.subscriptions.push({ dispose: () => (clearTimeout(firstPrices), clearInterval(dailyPrices)) });
  // Each answer of a model counts for its month, at its price, for the budget ring.
  models.onUsage = (profile, usage) => {
    const current = models.profiles().profiles.find((item) => item.id === profile.id) ?? profile;
    if (current.price) void stats.recordSpend(current.id, usageCost(usage, current.price));
  };
  const commits = new CommitAssistant(models, log);
  const completions = new CompletionProvider(models);
  const nextEdit = new NextEditPredictor(models, reviews);

  const start = async (request: TaskRequest) => {
    await view.reveal();
    await manager.run(request);
  };

  const fixFailedCommand = (failure: FailedCommand) =>
    start({
      text: buildCommandFixRequest(failure.command, failure.exitCode, truncateMiddle(failure.output, 20_000)),
      display: `Phew it! \`${failure.command}\` failed`,
      kind: "fix",
      mode: "code",
    });

  manager.suggestions = new SuggestionProvider(terminal, start, fixFailedCommand);

  const addToChat = async (attachment: Attachment) => {
    await view.reveal();
    view.post({ type: "addAttachment", attachment, label: attachmentLabel(attachment) });
  };

  const editorSelection = (): Attachment | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const path = vscode.workspace.asRelativePath(editor.document.uri, false);
    if (editor.selection.isEmpty) return { kind: "file", path };
    return {
      kind: "selection",
      path,
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
      text: editor.document.getText(editor.selection),
      language: editor.document.languageId,
    };
  };

  const root = () => manager.active?.root.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;

  context.subscriptions.push(
    log,
    status,
    terminal,
    reviews,
    index,
    settingsPanel,
    panels,
    completions,
    nextEdit,
    manager,
    { dispose: () => mcp.dispose() },
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view),
    vscode.workspace.registerTextDocumentContentProvider(diffScheme, diffs),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, reviews),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, completions),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new PhewItCodeActionProvider(), {
      providedCodeActionKinds: PhewItCodeActionProvider.kinds,
    }),

    // Chat and sessions
    vscode.commands.registerCommand("phew.openChat", () => view.reveal()),
    vscode.commands.registerCommand("phew.newChat", async () => {
      await view.reveal();
      manager.newSession();
    }),
    vscode.commands.registerCommand("phew.stop", () => manager.active?.stop()),
    vscode.commands.registerCommand("phew.showHistory", async () => {
      await view.reveal();
      view.post({ type: "openPanel" });
    }),
    vscode.commands.registerCommand("phew.exportChat", () => manager.exportActive()),
    vscode.commands.registerCommand("phew.openChatInEditor", (id?: unknown) =>
      panels?.open(typeof id === "string" ? id : undefined),
    ),
    vscode.commands.registerCommand("phew.renameChat", () => manager.rename()),
    vscode.commands.registerCommand("phew.compactChat", () => manager.active?.compactNow()),
    vscode.commands.registerCommand("phew.manageMcp", () => mcp.manage(root())),
    vscode.commands.registerCommand("phew.showMcpLogs", () => mcp.log.show()),
    vscode.commands.registerCommand("phew.setMode", async (value?: unknown) => {
      const modes = manager.modes();
      const mode =
        typeof value === "string" && modes.some((item) => item.id === value)
          ? value
          : (
              await vscode.window.showQuickPick(
                modes.map((item) => ({ label: item.name, description: item.description, id: item.id })),
                { title: "Phew: Mode" },
              )
            )?.id;
      if (mode) manager.active?.setMode(findMode(mode, modes).id);
    }),

    // Context
    vscode.commands.registerCommand("phew.addSelectionToChat", async () => {
      const attachment = editorSelection();
      if (attachment) await addToChat(attachment);
    }),
    vscode.commands.registerCommand("phew.addFileToChat", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : uri ? [uri] : [];
      if (targets.length === 0) {
        const attachment = editorSelection();
        if (attachment)
          await addToChat(attachment.kind === "selection" ? { kind: "file", path: attachment.path } : attachment);
        return;
      }
      for (const target of targets)
        await addToChat({ kind: "file", path: vscode.workspace.asRelativePath(target, false) });
    }),
    vscode.commands.registerCommand("phew.addTerminalToChat", async () => {
      const last = terminal.lastExecution;
      if (!last) {
        void vscode.window.showInformationMessage(
          "Phew: no terminal command yet. Phew needs terminal shell integration.",
        );
        return;
      }
      await addToChat({ kind: "terminal", command: last.command, output: truncateMiddle(last.output, 30_000) });
    }),
    vscode.commands.registerCommand("phew.addProblemsToChat", () => addToChat({ kind: "problems" })),

    // Models
    vscode.commands.registerCommand("phew.switchModel", async () => {
      await models.switchModel();
      manager.postState();
    }),
    vscode.commands.registerCommand("phew.addModel", (provider?: unknown) =>
      settingsPanel.show("models", typeof provider === "string" ? provider : undefined),
    ),
    vscode.commands.registerCommand("phew.manageModels", () => settingsPanel.show("models")),
    vscode.commands.registerCommand("phew.addModelQuick", async () => {
      await models.addModel();
      manager.postState();
    }),
    vscode.commands.registerCommand("phew.testModel", () => models.test()),

    // Settings, onboarding, and statistics
    vscode.commands.registerCommand("phew.openSettings", (focus?: string) =>
      settingsPanel.show(typeof focus === "string" ? focus : undefined),
    ),
    vscode.commands.registerCommand("phew.openWalkthrough", () =>
      vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        `${context.extension.id}#phew.gettingStarted`,
        false,
      ),
    ),
    vscode.commands.registerCommand("phew.showLog", () => log.show()),
    vscode.commands.registerCommand("phew.reportProblem", () =>
      reportProblem(models, recentLog, String(context.extension.packageJSON.version)),
    ),
    vscode.commands.registerCommand("phew.showAppearance", async () => {
      await view.reveal();
      view.post({ type: "showAppearance" });
    }),
    vscode.commands.registerCommand("phew.writeHandoff", async () => {
      await view.reveal();
      const session = manager.active ?? manager.newSession();
      await session?.writeHandoff(true);
    }),
    vscode.commands.registerCommand("phew.continueFromHandoff", async (relative?: unknown) => {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) return;
      let target = typeof relative === "string" ? relative : undefined;
      if (!target) {
        const notes = await handoffs.list(root.uri.fsPath);
        if (notes.length === 0) {
          void vscode.window.showInformationMessage(
            "There is no handoff note yet. Use /handoff in a chat to write one.",
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(
          notes.map((note) => ({
            label: note.title,
            description: `${note.status} · ${new Date(note.created).toLocaleString()}`,
            detail: note.path,
            path: note.path,
          })),
          { title: "Continue from a handoff note", placeHolder: "Choose the work to continue" },
        );
        if (!picked) return;
        target = picked.path;
      }
      await view.reveal();
      const session = manager.newSession();
      await session?.continueFrom(target);
    }),
    vscode.commands.registerCommand("phew.updateAgentsFile", async () => {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root || !vscode.workspace.isTrusted) return;
      const written = await handoffs.writeAgentsPointer(root.uri.fsPath);
      void vscode.window.showInformationMessage(
        written.length > 0 ? `Updated ${written.join(", ")}.` : "AGENTS.md already points to the handoff notes.",
      );
    }),
    vscode.commands.registerCommand("phew.editAssistant", async () => {
      await view.reveal();
      view.post({ type: "showOnboarding" });
    }),
    vscode.commands.registerCommand("phew.showWrapped", async (period?: unknown) => {
      await view.reveal();
      view.post(manager.wrappedMessage(period === "month" ? "month" : "week"));
    }),
    vscode.commands.registerCommand("phew.showStats", async () => {
      const answer = await vscode.window.showInformationMessage(
        "Phew statistics",
        { modal: true, detail: stats.details(readSettings().minutesPerBug) },
        "Reset",
      );
      if (answer === "Reset") {
        await stats.reset();
        manager.postState();
        updateStatus();
      }
    }),

    // Review in the editor
    vscode.commands.registerCommand("phew.review.keep", (uri: vscode.Uri, hunk: number) => reviews.keep(uri, hunk)),
    vscode.commands.registerCommand("phew.review.undo", (uri: vscode.Uri, hunk: number) => reviews.undo(uri, hunk)),
    vscode.commands.registerCommand("phew.review.keepFile", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      return target ? reviews.keepFile(target) : undefined;
    }),
    vscode.commands.registerCommand("phew.review.undoFile", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      return target ? reviews.undoFile(target) : undefined;
    }),
    vscode.commands.registerCommand("phew.review.keepAll", () => reviews.keepAll()),
    vscode.commands.registerCommand("phew.review.undoAll", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Undo all changes that are waiting for review?",
        { modal: true },
        "Undo All",
      );
      if (answer) await reviews.undoAll();
    }),
    vscode.commands.registerCommand("phew.review.next", () => reviews.next()),

    // Git
    vscode.commands.registerCommand("phew.generateCommitMessage", (source?: unknown) => commits.generate(source)),
    vscode.commands.registerCommand("phew.commit", (source?: unknown) => commits.commit(source)),
    vscode.commands.registerCommand("phew.showCommitIdentity", () => commits.showIdentity()),
    vscode.commands.registerCommand("phew.newWorktreeAgent", () => manager.newWorktreeAgent()),
    vscode.commands.registerCommand("phew.worktreeActions", () => manager.worktreeActions()),

    // Memory, index, and completions
    vscode.commands.registerCommand("phew.rate", () => rating.answer("rate")),
    vscode.commands.registerCommand("phew.openMemory", async (scope?: unknown) => {
      const target = root();
      if (scope === "personal") await memory.open(target ?? vscode.Uri.file("/"), "personal");
      else if (target) await memory.open(target);
    }),
    vscode.commands.registerCommand("phew.rebuildIndex", async () => {
      const target = root();
      if (!target) return;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Phew: indexing the code…" },
        () => index.rebuild(target),
      );
      void vscode.window.showInformationMessage(`Phew: indexed ${result.files} files (${result.chunks} chunks).`);
    }),
    vscode.commands.registerCommand("phew.toggleAutocomplete", () => completions.toggle()),
    vscode.commands.registerCommand("phew.suggestNextEdit", () => nextEdit.suggest()),

    // Phew it!
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
      const problemInfo = problemContext(document, problem);
      await start({
        text: buildFixRequest(problemInfo),
        display: `Phew it! ${problemInfo.path}:${problemInfo.line} — ${problemInfo.message.split("\n")[0].slice(0, 160)}`,
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
      const folder = root();
      if (!settings.verifyCommand) {
        const answer = await vscode.window.showInformationMessage(
          "Set the check command first, for example npm test.",
          "Open Setting",
        );
        if (answer) await settingsPanel.show("checks");
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
            folder.fsPath,
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
      const attachment = editorSelection();
      if (!attachment) return;
      await addToChat(attachment);
      view.post({ type: "focusInput", text: "Explain this code." });
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(section)) return;
      if (event.affectsConfiguration("phew.modes")) manager.reloadModes();
      if (event.affectsConfiguration("phew.autocomplete")) completions.update();
      if (event.affectsConfiguration("phew.mcp")) void mcp.restartAll();
      if (event.affectsConfiguration("phew.models") && automatic) updatePrices();
      manager.postState();
      updateStatus();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await manager.loadWorkspaceModes();
      manager.postState();
    }),
  );

  const welcomeKey = "phew.welcomeShown";
  if (!context.globalState.get(welcomeKey) && context.extensionMode !== vscode.ExtensionMode.Test) {
    await context.globalState.update(welcomeKey, true);
    void vscode.commands.executeCommand("phew.openWalkthrough");
  }

  disposeAll = () => manager.dispose();
  log.info(`Phew ${context.extension.packageJSON.version} activated.`);
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    run: (request) => manager.run(request),
    restoreLatest: () => manager.restoreFirstCheckpointForTest(),
    sessions: manager,
    reviews,
    index,
    globalState: context.globalState,
    models,
    memory: memory,
    settings: settingsPanel,
    prices,
    reportProblem: (description: string) =>
      reportProblem(models, recentLog, String(context.extension.packageJSON.version), { description }),
  };
}

export function deactivate(): void {
  disposeAll?.();
  disposeAll = undefined;
}
