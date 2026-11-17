export interface ChatHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly iconUri: string;
}

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapes[character] ?? character);
}

/** Small line icons, drawn for Phew. They use the current text color. */
const icons: Record<string, string> = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  paperclip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
};

function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ""}</svg>`;
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
    <button type="button" class="title" id="title" title="Chats and history"><span id="titleText">New chat</span><span class="badge" id="worktree" hidden></span><span class="running" id="running" hidden></span></button>
    <div class="icons">
      <button type="button" class="icon-button" id="renameButton" title="Rename chat" aria-label="Rename chat">${icon("edit")}</button>
      <button type="button" class="icon-button" id="popOut" title="Open a parallel chat in an editor tab" aria-label="Open a parallel chat in an editor tab">${icon("split")}</button>
      <button type="button" class="icon-button" id="historyButton" title="Chats and history" aria-label="Chats and history">${icon("history")}</button>
      <button type="button" class="icon-button" id="newChat" title="New chat" aria-label="New chat">${icon("plus")}</button>
    </div>
  </header>
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
      <img class="logo" src="${e(options.iconUri)}" alt="" width="72" height="72">
      <h1>Phew</h1>
      <p class="tagline">Bug fixed. Phew.</p>
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
  <div class="celebration" id="celebration" hidden aria-hidden="true"><span>Phew! Done.</span></div>
</div>
<script nonce="${e(options.nonce)}" src="${e(options.scriptUri)}"></script>
</body>
</html>`;
}
