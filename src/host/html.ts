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
      <button type="button" class="icon-button" id="renameButton" title="Rename chat" aria-label="Rename chat">✎</button>
      <button type="button" class="icon-button" id="popOut" title="Open a parallel chat in an editor tab" aria-label="Open a parallel chat in an editor tab">⧉</button>
      <button type="button" class="icon-button" id="historyButton" title="Chats and history" aria-label="Chats and history">⟲</button>
      <button type="button" class="icon-button" id="newChat" title="New chat" aria-label="New chat">＋</button>
    </div>
  </header>
  <div class="bar">
    <label class="visually-hidden" for="mode">Mode</label>
    <select id="mode" title="Mode"></select>
    <button type="button" class="model" id="model" title="Switch model"></button>
  </div>
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
    <div class="approvals" id="approvals">
      <label title="How you review file changes">Edits
        <select id="approvalReview">
          <option value="editor">Review in editor</option>
          <option value="chat">Ask first</option>
          <option value="none">Auto-apply</option>
        </select>
      </label>
      <label title="When commands run without asking. Dangerous commands always ask.">Commands
        <select id="approvalCommands">
          <option value="ask">Always ask</option>
          <option value="allowlist">Allowlist</option>
          <option value="safe">Safe auto</option>
        </select>
      </label>
      <label title="Run MCP tools without asking">MCP
        <select id="approvalMcp">
          <option value="false">Ask</option>
          <option value="true">Auto</option>
        </select>
      </label>
      <span class="custom" id="approvalCustom" hidden>this chat · <button type="button" class="link" id="saveApprovals">save as default</button></span>
    </div>
    <div class="context" id="context" hidden>
      <div class="context-bar"><div class="context-fill" id="contextFill"></div></div>
      <span class="context-label" id="contextLabel"></span>
      <button type="button" class="link" id="compact" hidden>Compact</button>
    </div>
    <div class="meter" id="meter" title="Statistics"></div>
    <div class="chips" id="chips"></div>
    <form class="composer" id="composer">
      <div class="mentions" id="mentions" role="listbox" hidden></div>
      <label class="visually-hidden" for="prompt">Message</label>
      <textarea id="prompt" rows="3" placeholder="Ask Phew or describe a change. @ to attach, ↑ for history"></textarea>
      <div class="actions">
        <button type="button" class="icon-button" id="mentionButton" title="Attach context (@)" aria-label="Attach context">@</button>
        <button type="button" class="icon-button" id="imageButton" title="Attach an image" aria-label="Attach an image">🖼</button>
        <input type="file" id="imageInput" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <span class="spacer"></span>
        <button type="button" class="secondary" id="stop" hidden>Stop</button>
        <button type="submit" class="primary" id="send">Send</button>
      </div>
    </form>
  </footer>
  <div class="celebration" id="celebration" hidden aria-hidden="true"><span>Phew! Done.</span></div>
</div>
<script nonce="${e(options.nonce)}" src="${e(options.scriptUri)}"></script>
</body>
</html>`;
}
