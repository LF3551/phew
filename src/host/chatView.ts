import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { type HostMessage, parseWebviewMessage, type WebviewMessage } from "../shared/protocol";
import { renderChatHtml } from "./html";
import type { AgentSession } from "./session";

const maximumTranscript = 3_000;

/**
 * Keeps the chat messages so that the view can rebuild itself after VS Code disposes a hidden webview.
 * Streaming deltas are replaced by the final assistant message.
 */
export class Transcript {
  private items: HostMessage[] = [];

  add(message: HostMessage): void {
    if (message.type === "state") return;
    if (message.type === "cleared") {
      this.items = [];
      return;
    }
    if (message.type === "assistantEnd") {
      this.items = this.items.filter(
        (item) => !((item.type === "assistantDelta" || item.type === "assistantStart") && item.id === message.id),
      );
    }
    this.items.push(message);
    if (this.items.length > maximumTranscript) this.items.splice(0, this.items.length - maximumTranscript);
  }

  all(): readonly HostMessage[] {
    return this.items;
  }
}

/** The chat view in the Phew side bar. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "phew.chatView";

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private readonly transcript = new Transcript();
  private session: AgentSession | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  attach(session: AgentSession): void {
    this.session = session;
  }

  post(message: HostMessage): void {
    this.transcript.add(message);
    if (this.view && this.ready) void this.view.webview.postMessage(message);
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
    const session = this.session;
    if (!session) return;
    switch (message.type) {
      case "ready":
        this.ready = true;
        for (const item of this.transcript.all()) void this.view?.webview.postMessage(item);
        void this.view?.webview.postMessage({ type: "state", state: session.state() } satisfies HostMessage);
        for (const resolve of this.readyWaiters.splice(0)) resolve();
        return;
      case "send":
        await session.run({ text: message.text, kind: "chat" });
        return;
      case "stop":
        session.stop();
        return;
      case "setMode":
        await session.setMode(message.mode);
        return;
      case "newChat":
        session.newChat();
        return;
      case "approve":
        session.broker.answer(message.id, message.decision === "allow", message.hunks);
        return;
      case "openDiff":
        session.broker.openDiff(message.id);
        return;
      case "restoreCheckpoint":
        await session.restoreCheckpoint(message.checkpointId);
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
