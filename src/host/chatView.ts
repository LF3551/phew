import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as vscode from "vscode";
import type { ActivityBadge } from "../core/activity";
import { safeColor } from "../core/appearance";
import { type HostMessage, parseWebviewMessage, type ViewState, type WebviewMessage } from "../shared/protocol";
import type { MentionProvider } from "./attachments";
import { renderChatHtml } from "./html";
import type { ChatViewHandle, SessionManager } from "./sessionManager";
import { clearSetting, readSettings, updateSetting } from "./settings";

function setupWebview(webview: vscode.Webview, extensionUri: vscode.Uri): void {
  const dist = vscode.Uri.joinPath(extensionUri, "dist");
  const media = vscode.Uri.joinPath(extensionUri, "media");
  const resources = vscode.Uri.joinPath(extensionUri, "resources");
  webview.options = { enableScripts: true, localResourceRoots: [dist, media, resources] };
  webview.html = renderChatHtml({
    cspSource: webview.cspSource,
    nonce: randomBytes(18).toString("base64url"),
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css")).toString(),
    terminalStyleUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css")).toString(),
    iconUri: webview.asWebviewUri(vscode.Uri.joinPath(resources, "icon.svg")).toString(),
  });
}

/** Connects one webview to the session manager. The side bar and each editor tab have one controller. */
class ChatController implements ChatViewHandle {
  private ready = false;
  private readonly queue: HostMessage[] = [];
  private readonly readyWaiters: (() => void)[] = [];
  private detach: (() => void) | undefined;

  constructor(
    private readonly sessions: SessionManager,
    private readonly mentions: MentionProvider,
    private readonly log: vscode.LogOutputChannel,
    private webview: vscode.Webview | undefined,
    private readonly isVisible: () => boolean,
    readonly pinnedId?: string,
  ) {
    this.detach = sessions.attach(this);
  }

  get visible(): boolean {
    return this.webview !== undefined && this.isVisible();
  }

  connect(webview: vscode.Webview): void {
    this.webview = webview;
    this.ready = false;
    webview.onDidReceiveMessage((value: unknown) => {
      const message = parseWebviewMessage(value);
      if (!message) {
        this.log.warn("Ignored an invalid message from the chat view.");
        return;
      }
      void this.handle(message).catch((error: unknown) =>
        this.post({ type: "notice", level: "error", text: error instanceof Error ? error.message : String(error) }),
      );
    });
  }

  disconnect(): void {
    this.webview = undefined;
    this.ready = false;
  }

  dispose(): void {
    this.disconnect();
    this.detach?.();
    this.detach = undefined;
  }

  /** Called with each new state, for example to show the chat title in the view title. */
  onState: ((state: ViewState) => void) | undefined;

  post(message: HostMessage): void {
    if (message.type === "state") this.onState?.(message.state);
    if (this.webview && this.ready) void this.webview.postMessage(message);
    else if (["addAttachment", "focusInput", "openPanel"].includes(message.type)) this.queue.push(message);
  }

  waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private session() {
    return this.sessions.sessionFor(this);
  }

  private async handle(message: WebviewMessage): Promise<void> {
    const sessions = this.sessions;
    const session = this.session();
    switch (message.type) {
      case "ready":
        this.ready = true;
        sessions.replay(this);
        await sessions.postSessions(this);
        for (const item of this.queue.splice(0)) this.post(item);
        for (const resolve of this.readyWaiters.splice(0)) resolve();
        return;
      case "send":
        if (session) await session.submit(message.text, message.attachments, message.interrupt === true);
        else await sessions.run({ text: message.text, kind: "chat", attachments: message.attachments });
        return;
      case "stop":
        session?.stop();
        return;
      case "retryRequest":
        if (!session?.retryRequest())
          this.post({ type: "notice", level: "info", text: "No model request is running." });
        return;
      case "setMode":
        session?.setMode(message.mode);
        return;
      case "newChat":
        if (this.pinnedId) await vscode.commands.executeCommand("phew.openChatInEditor");
        else sessions.newSession();
        return;
      case "approve":
        session?.broker.answer(message.id, message.decision === "allow", message.hunks, message.text);
        return;
      case "openDiff":
        session?.broker.openDiff(message.id);
        return;
      case "restoreCheckpoint":
        await session?.restoreCheckpoint(message.checkpointId);
        return;
      case "contextQuery": {
        const root = session?.root.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const options = root ? await this.mentions.contextOptions(root).catch(() => []) : [];
        // The terminals of the chat, so the user can show the agent what happened there.
        for (const snapshot of session?.terminalSnapshots ?? []) {
          const lines = snapshot.output.split("\n");
          options.push({
            id: "terminal",
            label: `Terminal ${snapshot.id} of the chat`,
            detail: `${snapshot.state}${snapshot.command ? ` · ${snapshot.command.split("\n")[0]?.slice(0, 40)}` : ""} · last ${lines.length} lines`,
            attachment: { kind: "terminal", command: `Terminal ${snapshot.id} of the chat`, output: snapshot.output },
            chip: `Terminal ${snapshot.id}`,
          });
        }
        this.post({ type: "contextOptions", options });
        return;
      }
      case "mentionQuery": {
        const root = session?.root.uri;
        if (!root) return;
        const items = await this.mentions.suggest(root, message.query, readSettings());
        this.post({ type: "mentions", query: message.query, items });
        return;
      }
      case "setAppearance": {
        const keys = {
          style: "appearance.style",
          accentColor: "appearance.accentColor",
          fontSize: "chat.fontSize",
          timestamps: "appearance.timestamps",
          clock: "appearance.clock",
          mascot: "appearance.mascot",
        } as const;
        const value = message.key === "accentColor" ? safeColor(message.value) : message.value;
        await updateSetting(keys[message.key], value === "" || value === null ? undefined : value);
        // A fixed color of your messages would hide the new accent, so the messages follow the accent again.
        if (message.key === "accentColor") await clearSetting("appearance.userBubbleColor");
        return;
      }
      case "resetAppearance":
        for (const key of [
          "appearance.style",
          "appearance.accentColor",
          "chat.fontSize",
          "appearance.timestamps",
          "appearance.clock",
          "appearance.mascot",
        ] as const)
          await updateSetting(key, undefined);
        await clearSetting("appearance.userBubbleColor");
        return;
      case "setApproval":
        sessions.setApproval(session, message.key, message.value);
        return;
      case "resetApprovals":
        await sessions.saveApprovalsAsDefault(session);
        return;
      case "removeQueued":
        session?.removeQueued(message.id);
        return;
      case "compact":
        await session?.compactNow();
        return;
      case "saveAssistant":
        await sessions.introduceAssistant(message);
        return;
      case "reviewFile": {
        // Only a file that is under review: the webview cannot name any other file.
        const uri = sessions.reviewUri(message.uri);
        if (!uri) return;
        if (message.action === "open") await vscode.window.showTextDocument(uri, { preview: false });
        else
          await vscode.commands.executeCommand(
            message.action === "keep" ? "phew.review.keepFile" : "phew.review.undoFile",
            uri,
          );
        return;
      }
      case "reviewAll":
        await vscode.commands.executeCommand(message.action === "keep" ? "phew.review.keepAll" : "phew.review.undoAll");
        return;
      case "taskAction":
        await sessions.taskAction(session, message.action, message.checkpointId);
        return;
      case "suggest":
        this.post({ type: "suggestions", items: (await sessions.suggestions?.list()) ?? [] });
        return;
      case "runSuggestion":
        await sessions.suggestions?.run(message.id);
        return;
      case "continueHandoff": {
        const target = session?.isEmpty && !session.busy ? session : sessions.newSession();
        await target?.continueFrom(message.path);
        return;
      }
      case "dismissWhatsNew":
        await sessions.dismissWhatsNew();
        return;
      case "skipOnboarding":
        await sessions.introduceAssistant();
        return;
      case "showWrapped":
        this.post(sessions.wrappedMessage(message.period));
        return;
      case "copyText":
        // The webview could not write to the clipboard, for example without focus.
        await vscode.env.clipboard.writeText(message.text);
        return;
      case "saveImage": {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(folder, message.fileName),
          filters: { Images: ["png"] },
        });
        if (!target) return;
        const bytes = Buffer.from(message.dataUrl.slice(message.dataUrl.indexOf(",") + 1), "base64");
        await vscode.workspace.fs.writeFile(target, bytes);
        this.post({ type: "notice", level: "info", text: `Saved ${vscode.workspace.asRelativePath(target)}.` });
        return;
      }
      case "openFile": {
        // A path from a terminal is relative to the folder of that terminal, and may be outside the workspace.
        const fromTerminal = message.terminal ? session?.terminalFile(message.terminal, message.path) : undefined;
        const absolute = fromTerminal ?? session?.roots.resolve(message.path);
        if (!absolute) {
          this.post({ type: "notice", level: "warning", text: `${message.path} is outside the workspace.` });
          return;
        }
        const line = Math.max(0, (message.line ?? 1) - 1);
        const column = Math.max(0, (message.column ?? 1) - 1);
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(absolute), {
            selection: new vscode.Range(line, column, line, column),
            preview: true,
            viewColumn: this.pinnedId ? vscode.ViewColumn.One : undefined,
          });
        } catch {
          this.post({ type: "notice", level: "warning", text: `Phew cannot open ${message.path}.` });
        }
        return;
      }
      case "renameChat":
        await sessions.rename(message.id ?? session?.id);
        return;
      case "openInEditor":
        await vscode.commands.executeCommand("phew.openChatInEditor", message.id);
        return;
      case "listSessions":
        await sessions.postSessions(this);
        return;
      case "switchSession":
        if (this.pinnedId) await vscode.commands.executeCommand("phew.openChatInEditor", message.id);
        else sessions.switchTo(message.id);
        return;
      case "openConversation":
        await sessions.openConversation(message.id);
        return;
      case "deleteConversation":
        await sessions.deleteConversation(message.id);
        return;
      case "pinChat":
        await sessions.pin(message.id, message.pinned);
        return;
      case "exportChat":
        if (message.id) await sessions.exportChat(message.id);
        else await sessions.exportActive(session);
        return;
      case "reviewNext":
        await vscode.commands.executeCommand("phew.review.next");
        return;
      case "newWorktreeAgent":
        await sessions.newWorktreeAgent();
        return;
      case "openWalkthrough":
        await vscode.commands.executeCommand("phew.openWalkthrough");
        return;
      case "setupOptions":
        this.post({ type: "setupOptions", options: await this.sessions.setupOptions() });
        return;
      case "connectProvider":
        await vscode.commands.executeCommand("phew.addModel", message.id);
        return;
      case "configureModel":
        // The menu under the input switches models; this message only connects a new one.
        await vscode.commands.executeCommand("phew.addModel");
        return;
      case "openSettings":
        await vscode.commands.executeCommand("phew.openSettings");
        return;
      case "useModel":
        await this.sessions.useModel(message.id);
        return;
      case "manageModels":
        await vscode.commands.executeCommand("phew.manageModels");
        return;
      case "commandInput":
        session?.commandInput(message.id, message.data);
        return;
      case "terminalAction":
        session?.terminalAction(message.id, message.action);
        return;
      case "fixCommand":
        await session?.fixCommand(message.id);
        return;
      case "rerunCommand":
        await session?.rerunCommand(message.id);
        return;
      case "showTerminal":
        session?.showTerminal();
        return;
      case "stopCommand":
        session?.stopCommand(message.id);
        return;
      case "setApprovalLevel":
        sessions.setApprovalLevel(session, message.level);
        return;
      case "editAllowlist":
        await vscode.commands.executeCommand("workbench.action.openSettings", "phew.commands.autoApprove");
        return;
      case "editModes":
        await vscode.commands.executeCommand("workbench.action.openSettings", "phew.modes");
        return;
      case "showStats":
        await vscode.commands.executeCommand("phew.showStats");
        return;
    }
  }
}

/** The chat view in the Phew side bar. It shows the active chat. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "phew.chatView";

  private view: vscode.WebviewView | undefined;
  private readonly controller: ChatController;
  private badge: ActivityBadge | undefined;
  private stopProgress: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log: vscode.LogOutputChannel,
    sessions: SessionManager,
    mentions: MentionProvider,
  ) {
    this.controller = new ChatController(sessions, mentions, log, undefined, () => this.view?.visible ?? false);
  }

  /** Called when the user opens the side bar chat. */
  onVisible: (() => void) | undefined;

  post(message: HostMessage): void {
    this.controller.post(message);
  }

  /** Shows the view and waits until the webview script is ready. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    await this.controller.waitUntilReady();
  }

  /**
   * Shows what happens on the Phew icon in the activity bar:
   * the progress of VS Code while a chat runs, and a badge when a chat needs an answer or finished unseen.
   */
  showActivity(running: boolean, badge: ActivityBadge | undefined): void {
    this.badge = badge;
    if (this.view) this.view.badge = badge;
    if (running && !this.stopProgress) {
      void vscode.window.withProgress(
        { location: { viewId: ChatViewProvider.viewId } },
        () =>
          new Promise<void>((resolve) => {
            this.stopProgress = resolve;
          }),
      );
    } else if (!running && this.stopProgress) {
      this.stopProgress();
      this.stopProgress = undefined;
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.badge = this.badge;
    if (view.visible) this.onVisible?.();
    view.onDidChangeVisibility(() => {
      if (view.visible) this.onVisible?.();
    });
    // The chat title lives in the view title, so the chat needs no second header.
    this.controller.onState = (state) => {
      if (this.view !== view) return;
      const parts = [state.worktree ? `⑂ ${state.worktree}` : "", state.title];
      view.description = parts.filter(Boolean).join(" ");
    };
    setupWebview(view.webview, this.extensionUri);
    this.controller.connect(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.controller.disconnect();
      }
    });
  }
}

/** Chats in editor tabs. Each tab shows one chat, so two agents can work side by side. */
export class ChatPanels implements vscode.Disposable {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; controller: ChatController }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    private readonly sessions: SessionManager,
    private readonly mentions: MentionProvider,
  ) {}

  /** Opens a chat in an editor tab beside the current editor. Without an id, it opens a new chat. */
  async open(id?: string): Promise<void> {
    const session = id ? await this.sessions.restore(id) : this.sessions.createDetached();
    if (!session) {
      void vscode.window.showWarningMessage("Phew: open a folder first.");
      return;
    }
    const existing = this.panels.get(session.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    this.sessions.keep(session.id);
    const panel = vscode.window.createWebviewPanel(
      "phew.chatPanel",
      `Phew: ${session.title}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png");
    const controller = new ChatController(
      this.sessions,
      this.mentions,
      this.log,
      undefined,
      () => panel.visible,
      session.id,
    );
    setupWebview(panel.webview, this.extensionUri);
    controller.connect(panel.webview);
    this.panels.set(session.id, { panel, controller });
    panel.onDidDispose(() => {
      controller.dispose();
      this.panels.delete(session.id);
      this.sessions.release(session.id);
    });
    await controller.waitUntilReady();
  }

  /** Keeps the tab titles in sync with the chat titles. */
  refreshTitles(): void {
    for (const [id, { panel }] of this.panels) {
      const title = this.sessions.session(id)?.title;
      if (title && panel.title !== `Phew: ${title}`) panel.title = `Phew: ${title}`;
    }
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
  }
}
