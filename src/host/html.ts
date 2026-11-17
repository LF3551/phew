export interface ChatHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly iconUri: string;
}

import { icon } from "../shared/icons";

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapes[character] ?? character);
}

/** Builds the chat webview document with a strict Content Security Policy and no remote content. */
export function renderChatHtml(options: ChatHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `img-src ${options.cspSource} data:`,
    `style-src ${options.cspSource}`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
  ].join("; ");
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${e(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${e(options.styleUri)}">
<title>Phew</title>
</head>
<body>
<div class="app" id="app">
  <header class="toolbar">
    <span class="header-avatar" id="headerAvatar" title="Your assistant"></span>
    <button type="button" class="title" id="title" title="Chats and history"><span id="titleText">New chat</span><span class="badge" id="worktree" hidden></span><span class="running" id="running" hidden></span></button>
    <div class="icons">
      <button type="button" class="icon-button" id="appearanceButton" title="Appearance" aria-label="Appearance">${icon("type")}</button>
      <button type="button" class="icon-button" id="renameButton" title="Rename chat" aria-label="Rename chat">${icon("edit")}</button>
      <button type="button" class="icon-button" id="popOut" title="Open a parallel chat in an editor tab" aria-label="Open a parallel chat in an editor tab">${icon("split")}</button>
      <button type="button" class="icon-button" id="historyButton" title="Chats and history" aria-label="Chats and history">${icon("history")}</button>
      <button type="button" class="icon-button" id="newChat" title="New chat" aria-label="New chat">${icon("plus")}</button>
    </div>
  </header>
  <section class="popover appearance" id="appearance" hidden>
    <div class="popover-title">Appearance</div>
    <div class="segmented" id="styleChoice">
      <button type="button" data-style="bubbles">Bubbles</button>
      <button type="button" data-style="classic">Classic</button>
      <button type="button" data-style="compact">Compact</button>
    </div>
    <div class="row-label">Accent</div>
    <div class="swatches" id="swatches"></div>
    <div class="row-label">Text size</div>
    <div class="stepper"><button type="button" id="fontDown" aria-label="Smaller">A−</button><span id="fontValue">Default</span><button type="button" id="fontUp" aria-label="Larger">A+</button></div>
    <label class="row-label">Times
      <select id="timestampChoice">
        <option value="hover">On hover</option>
        <option value="always">Always</option>
        <option value="never">Never</option>
      </select>
    </label>
    <div class="popover-links">
      <button type="button" class="link" id="editAssistant">Name and character</button>
      <button type="button" class="link" id="openWrapped">Wrapped and achievements</button>
      <button type="button" class="link" id="moreAppearance">More options</button>
    </div>
  </section>
  <section class="panel" id="panel" hidden>
    <div class="panel-header">
      <input type="search" id="historySearch" placeholder="Search chats" aria-label="Search chats">
      <button type="button" class="icon-button" id="closePanel" aria-label="Close">✕</button>
    </div>
    <div class="panel-actions">
      <button type="button" class="secondary" id="panelNew">＋ New chat</button>
      <button type="button" class="secondary" id="panelParallel" title="A second chat in an editor tab that works at the same time">⧉ Parallel chat</button>
      <button type="button" class="secondary" id="panelWorktree" title="An agent on a new branch in a separate folder">⑂ Agent in worktree</button>
      <button type="button" class="secondary" id="panelExport">Export</button>
    </div>
    <h4>Open</h4>
    <ul class="list" id="openList"></ul>
    <h4>History</h4>
    <ul class="list" id="historyList"></ul>
  </section>
  <main class="transcript" id="transcript" aria-live="polite">
    <section class="welcome" id="welcome">
      <div class="logo" id="welcomeAvatar"></div>
      <h1 id="welcomeName">Phew</h1>
      <p class="tagline" id="welcomeTagline">Bug fixed. Phew.</p>
      <div class="resume-card" id="resumeCard" hidden></div>
      <ul class="tips">
        <li>Ask about your code, or describe a change.</li>
        <li>Type <kbd>@</kbd> to attach files, problems, Git changes, or the terminal.</li>
        <li>Click <strong>Phew it!</strong> on any error in the editor.</li>
        <li>Keep or undo each change in the editor. Restore a checkpoint at any time.</li>
      </ul>
      <div class="welcome-actions">
        <button type="button" class="primary" id="setup" hidden>Connect a model</button>
        <button type="button" class="secondary" id="guide">Get started</button>
      </div>
    </section>
  </main>
  <div class="review-banner" id="reviewBanner" hidden>
    <span id="reviewText"></span>
    <button type="button" class="link" id="reviewNext">Review</button>
  </div>
  <footer class="footer">
    <section class="plan" id="plan" hidden>
      <button type="button" class="plan-header" id="planToggle" aria-expanded="true"><span id="planTitle">Plan</span><span class="plan-progress" id="planProgress"></span></button>
      <ul class="plan-items" id="planItems"></ul>
    </section>
    <ul class="queue" id="queue" hidden></ul>
    <p class="restricted" id="restricted" hidden>Restricted mode: Phew only answers questions in this workspace.</p>
    <form class="composer" id="composer">
      <div class="mentions" id="mentions" role="listbox" hidden></div>
      <div class="popover" id="attachMenu" hidden>
        <button type="button" class="menu-item" id="attachContext">${icon("at")}<span class="menu-label">Files, problems, Git, terminal</span><kbd>@</kbd></button>
        <button type="button" class="menu-item" id="imageButton">${icon("image")}<span class="menu-label">Image or screenshot</span><kbd>Paste</kbd></button>
      </div>
      <div class="popover approvals" id="approvals" hidden>
        <div class="popover-title">Auto-approve in this chat</div>
        <label>Edits
          <select id="approvalReview">
            <option value="editor">Apply, review in editor</option>
            <option value="chat">Ask before each edit</option>
            <option value="none">Apply without review</option>
          </select>
        </label>
        <label>Commands
          <select id="approvalCommands">
            <option value="ask">Always ask</option>
            <option value="allowlist">Run allowlisted</option>
            <option value="safe">Run safe commands</option>
          </select>
        </label>
        <label>MCP tools
          <select id="approvalMcp">
            <option value="false">Ask</option>
            <option value="true">Run without asking</option>
          </select>
        </label>
        <p class="popover-note">Dangerous commands always ask.</p>
        <button type="button" class="link" id="saveApprovals" hidden>Save as default for new chats</button>
        <span id="approvalCustom" hidden></span>
      </div>
      <div class="box">
        <div class="chips" id="chips"></div>
        <label class="visually-hidden" for="prompt">Message</label>
        <textarea id="prompt" rows="2" placeholder="Ask Phew or describe a change"></textarea>
        <div class="box-toolbar">
          <label class="visually-hidden" for="mode">Mode</label>
          <select class="pill" id="mode" title="Mode"></select>
          <button type="button" class="icon-button" id="attachButton" title="Attach context" aria-label="Attach context">${icon("paperclip")}</button>
          <button type="button" class="icon-button" id="approvalsButton" title="Auto-approve settings" aria-label="Auto-approve settings">${icon("shield")}<span class="dot" id="approvalDot" hidden></span></button>
          <input type="file" id="imageInput" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
          <span class="spacer"></span>
          <button type="button" class="context-ring" id="context" hidden title="Context"><span id="contextLabel"></span></button>
          <button type="button" class="pill model" id="model" title="Switch model"></button>
          <button type="submit" class="send" id="send" title="Send" aria-label="Send">${icon("send")}</button>
          <button type="button" class="send stop" id="stop" title="Stop" aria-label="Stop" hidden>${icon("stop")}</button>
        </div>
      </div>
    </form>
  </footer>
  <div class="overlay" id="overlay" hidden></div>
  <div class="celebration" id="celebration" hidden aria-hidden="true"><span>Phew! Done.</span></div>
</div>
<script nonce="${e(options.nonce)}" src="${e(options.scriptUri)}"></script>
</body>
</html>`;
}
