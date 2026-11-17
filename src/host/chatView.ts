import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { type HostMessage, parseWebviewMessage, type WebviewMessage } from "../shared/protocol";
import type { MentionProvider } from "./attachments";
import { renderChatHtml } from "./html";
import type { SessionManager } from "./sessionManager";
import { readSettings } from "./settings";

/** The chat view in the Phew side bar. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "phew.chatView";

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private queue: HostMessage[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    private readonly sessions: SessionManager,
    private readonly mentions: MentionProvider,
  ) {}

  post(message: HostMessage): void {
    if (this.view && this.ready) void this.view.webview.postMessage(message);
    else if (message.type === "addAttachment" || message.type === "focusInput" || message.type === "openPanel")
      this.queue.push(message);
  }

  /** Shows the view and waits until the webview script is ready. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    if (this.ready) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    const resources = vscode.Uri.joinPath(this.extensionUri, "resources");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist, media, resources] };
    view.webview.html = renderChatHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(18).toString("base64url"),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css")).toString(),
      iconUri: view.webview.asWebviewUri(vscode.Uri.joinPath(resources, "icon.svg")).toString(),
    });
    view.webview.onDidReceiveMessage((value: unknown) => {
      const message = parseWebviewMessage(value);
      if (!message) {
        this.log.warn("Ignored an invalid message from the chat view.");
        return;
      }
      void this.handle(message).catch((error: unknown) =>
        this.post({ type: "notice", level: "error", text: error instanceof Error ? error.message : String(error) }),
      );
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  private async handle(message: WebviewMessage): Promise<void> {
    const sessions = this.sessions;
    switch (message.type) {
      case "ready":
        this.ready = true;
        sessions.replay();
        await sessions.postSessions();
        for (const item of this.queue.splice(0)) this.post(item);
        for (const resolve of this.readyWaiters.splice(0)) resolve();
        return;
      case "send":
        await sessions.run({ text: message.text, kind: "chat", attachments: message.attachments });
        return;
      case "stop":
        sessions.active?.stop();
        return;
      case "setMode":
        sessions.active?.setMode(message.mode);
        return;
      case "newChat":
        sessions.newSession();
        return;
      case "approve":
        sessions.active?.broker.answer(message.id, message.decision === "allow", message.hunks);
        return;
      case "openDiff":
        sessions.active?.broker.openDiff(message.id);
        return;
      case "restoreCheckpoint":
        await sessions.active?.restoreCheckpoint(message.checkpointId);
        return;
      case "mentionQuery": {
        const root = sessions.active?.root.uri;
        if (!root) return;
        const items = await this.mentions.suggest(root, message.query, readSettings());
        this.post({ type: "mentions", query: message.query, items });
        return;
      }
      case "setApproval":
        await sessions.setApproval(message.key, message.value);
        return;
      case "listSessions":
        await sessions.postSessions();
        return;
      case "switchSession":
        sessions.switchTo(message.id);
        return;
      case "openConversation":
        await sessions.openConversation(message.id);
        return;
      case "deleteConversation":
        await sessions.deleteConversation(message.id);
        return;
      case "exportChat":
        await sessions.exportActive();
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
