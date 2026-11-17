import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { safeColor } from "../core/appearance";
import { type HostMessage, parseWebviewMessage, type WebviewMessage } from "../shared/protocol";
import type { MentionProvider } from "./attachments";
import { renderChatHtml } from "./html";
import type { ChatViewHandle, SessionManager } from "./sessionManager";
import { readSettings, updateSetting } from "./settings";

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

  post(message: HostMessage): void {
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
        } as const;
        const value = message.key === "accentColor" ? safeColor(message.value) : message.value;
        await updateSetting(keys[message.key], value === "" ? undefined : value);
        return;
      }
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
      case "openFile": {
        const absolute = session?.roots.resolve(message.path);
        if (!absolute) {
          this.post({ type: "notice", level: "warning", text: `${message.path} is outside the workspace.` });
          return;
        }
        const line = Math.max(0, (message.line ?? 1) - 1);
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(absolute), {
            selection: new vscode.Range(line, 0, line, 0),
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
      case "exportChat":
        await sessions.exportActive(session);
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
      case "configureModel":
        await vscode.commands.executeCommand("phew.switchModel");
        return;
      case "openSettings":
        await vscode.commands.executeCommand("phew.openSettings");
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    log: vscode.LogOutputChannel,
    sessions: SessionManager,
    mentions: MentionProvider,
  ) {
    this.controller = new ChatController(sessions, mentions, log, undefined, () => this.view?.visible ?? false);
  }

  post(message: HostMessage): void {
    this.controller.post(message);
  }

  /** Shows the view and waits until the webview script is ready. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    await this.controller.waitUntilReady();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
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
    const session = id ? this.sessions.session(id) : this.sessions.createDetached();
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
