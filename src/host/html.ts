export interface ChatHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  /** The styles of xterm.js for the terminal of the commands in the chat. */
  readonly terminalStyleUri: string;
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
    // xterm.js, the terminal of the commands in the chat, adds <style> elements; they carry the nonce.
    `style-src ${options.cspSource} 'nonce-${options.nonce}'`,
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
<link rel="stylesheet" href="${e(options.terminalStyleUri)}">
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
  <section class="popover appearance" id="appearance" role="dialog" aria-label="Appearance" hidden>
    <div class="look-head">
      <span class="popover-title">Appearance</span>
      <button type="button" class="link" id="resetAppearance" title="Back to the defaults" hidden>Reset</button>
    </div>
    <div class="look-group">
      <div class="segmented look-styles" id="styleChoice" role="radiogroup" aria-label="Chat style">
        <button type="button" data-style="bubbles" role="radio"><svg viewBox="0 0 28 18" aria-hidden="true"><rect x="13" y="1" width="14" height="6" rx="3"/><rect x="1" y="10" width="18" height="2" rx="1"/><rect x="1" y="14" width="12" height="2" rx="1"/></svg><span>Bubbles</span></button>
        <button type="button" data-style="classic" role="radio"><svg viewBox="0 0 28 18" aria-hidden="true"><rect x="1" y="1" width="2" height="6" rx="1"/><rect x="5" y="2" width="16" height="2" rx="1"/><rect x="5" y="5" width="10" height="2" rx="1"/><rect x="1" y="10" width="2" height="7" rx="1"/><rect x="5" y="11" width="20" height="2" rx="1"/><rect x="5" y="14" width="14" height="2" rx="1"/></svg><span>Classic</span></button>
        <button type="button" data-style="compact" role="radio"><svg viewBox="0 0 28 18" aria-hidden="true"><rect x="1" y="1" width="22" height="2" rx="1"/><rect x="1" y="5" width="16" height="2" rx="1"/><rect x="1" y="9" width="24" height="2" rx="1"/><rect x="1" y="13" width="18" height="2" rx="1"/></svg><span>Compact</span></button>
      </div>
      <div class="look-row">
        <span class="look-label">Text</span>
        <div class="stepper">
          <button type="button" id="fontDown" aria-label="Smaller text">A−</button>
          <span id="fontValue" aria-live="polite">13</span>
          <button type="button" id="fontUp" aria-label="Larger text">A+</button>
          <button type="button" class="stepper-reset" id="fontReset" title="Use the editor size" aria-label="Use the editor size" hidden>↺</button>
        </div>
      </div>
      <div class="look-row">
        <span class="look-label">Times</span>
        <div class="segmented small" id="timestampChoice" role="radiogroup" aria-label="Message times">
          <button type="button" role="radio" data-value="hover" title="Show the time when you point at a message">Hover</button>
          <button type="button" role="radio" data-value="always">Always</button>
          <button type="button" role="radio" data-value="never">Never</button>
        </div>
      </div>
      <div class="look-row">
        <span class="look-label">Clock</span>
        <div class="segmented small" id="clockChoice" role="radiogroup" aria-label="Clock of message times">
          <button type="button" role="radio" data-value="auto" title="Follow the language of VS Code">Auto</button>
          <button type="button" role="radio" data-value="24h">24h</button>
          <button type="button" role="radio" data-value="12h">12h</button>
        </div>
      </div>
    </div>
    <div class="look-group">
      <div class="look-label">Accent <span class="look-value" id="accentName">Theme</span></div>
      <div class="swatches" id="swatches" role="radiogroup" aria-label="Accent color"></div>
    </div>
    <div class="look-group look-assistant">
      <div class="assistant-row">
        <span class="appearance-avatar" id="appearanceAvatar"></span>
        <span class="assistant-text"><strong id="assistantName">Phew</strong><span id="assistantPersona">Partner</span></span>
        <button type="button" class="secondary small-button" id="editAssistant">Edit</button>
      </div>
      <div class="look-row">
        <span class="look-label">Motion</span>
        <div class="segmented small" id="mascotChoice" role="radiogroup" aria-label="Mascot motion">
          <button type="button" role="radio" data-value="lively" title="Blinks, shows the work with its eyes, and follows the pointer">Lively</button>
          <button type="button" role="radio" data-value="calm" title="Blinks and changes its face">Calm</button>
          <button type="button" role="radio" data-value="still" title="Does not move">Still</button>
        </div>
      </div>
    </div>
    <div class="look-foot">
      <button type="button" class="link" id="openWrapped">Your Wrapped</button>
      <button type="button" class="link" id="moreAppearance">All settings</button>
    </div>
  </section>
  <section class="panel" id="panel" role="dialog" aria-label="Chats" hidden>
    <div class="panel-search">
      ${icon("search")}
      <input type="search" id="historySearch" placeholder="Search chats" aria-label="Search chats" aria-controls="chatList" autocomplete="off" spellcheck="false">
    </div>
    <div class="chat-list" id="chatList" role="listbox" aria-label="Chats"></div>
    <div class="panel-footer">
      <div class="split-button">
        <button type="button" class="split-main" id="panelNew">${icon("plus")}<span>New chat</span></button>
        <button type="button" class="split-more" id="panelMore" aria-haspopup="menu" aria-expanded="false" aria-label="More ways to start" title="More ways to start">${icon("chevron")}</button>
      </div>
      <div class="panel-keys" id="panelKeys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> select</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      <div class="chat-menu start-menu" id="startMenu" role="menu" hidden>
        <button type="button" class="menu-item" role="menuitem" id="panelParallel">${icon("split")}<span class="menu-label">Chat in a new tab<small>Runs next to this chat, at the same time</small></span></button>
        <button type="button" class="menu-item" role="menuitem" id="panelWorktree">${icon("git")}<span class="menu-label">Agent on a separate branch<small>Works in its own folder. Your files stay as they are.</small></span></button>
      </div>
    </div>
  </section>
  <div class="chat-menu row-menu" id="rowMenu" role="menu" hidden></div>
  <div class="undo-toast" id="undoToast" role="status" hidden><span id="undoText"></span><button type="button" id="undoButton">Undo</button></div>
  <main class="transcript" id="transcript" aria-live="polite">
    <section class="welcome" id="welcome">
      <div class="logo" id="welcomeAvatar"></div>
      <h1 id="welcomeName">Phew</h1>
      <p class="tagline" id="welcomeTagline">Bug fixed. Phew.</p>
      <div class="setup-card" id="setupCard" hidden></div>
      <div class="resume-card" id="resumeCard" hidden></div>
      <div class="suggestions" id="suggestions" aria-label="Suggested tasks"></div>
      <p class="welcome-hint">Or describe a change. Type <kbd>@</kbd> to attach files and <kbd>/</kbd> for commands.</p>
      <div class="welcome-actions">
        <button type="button" class="primary" id="setup" hidden>Connect a model</button>
        <button type="button" class="secondary" id="guide">Get started</button>
      </div>
    </section>
  </main>
  <button type="button" class="jump" id="jump" hidden>↓ New</button>
  <div class="review-banner" id="reviewBanner" hidden>
    <span id="reviewText"></span>
    <button type="button" class="link" id="reviewNext">Review</button>
  </div>
  <footer class="footer">
    <div class="status-line" id="statusLine" role="status" aria-live="polite" hidden><span class="status-mascot" id="statusMascot"></span><span class="status-text" id="statusText"></span><span class="status-time" id="statusTime"></span></div>
    <section class="plan" id="plan" hidden>
      <button type="button" class="plan-header" id="planToggle" aria-expanded="true"><span id="planTitle">Plan</span><span class="plan-progress" id="planProgress"></span></button>
      <ul class="plan-items" id="planItems"></ul>
    </section>
    <ul class="queue" id="queue" hidden></ul>
    <p class="restricted" id="restricted" hidden>Restricted mode: Phew only answers questions in this workspace.</p>
    <form class="composer" id="composer">
      <div class="mentions" id="mentions" role="listbox" hidden></div>
      <div class="popover attach-menu" id="attachMenu" role="menu" aria-label="Add context" hidden></div>
      <div class="popover mode-menu" id="modeMenu" role="menu" aria-label="Mode" hidden></div>
      <div class="popover model-menu" id="modelMenu" role="menu" aria-label="Model" hidden></div>
      <div class="popover terminals-panel" id="terminalsPanel" role="dialog" aria-label="Terminals" hidden></div>
      <div class="popover approvals" id="approvals" role="dialog" aria-label="Auto-approve in this chat" hidden></div>
      <div class="box">
        <div class="chips" id="chips"></div>
        <label class="visually-hidden" for="prompt">Message</label>
        <textarea id="prompt" rows="2" placeholder="Ask Phew or describe a change"></textarea>
        <div class="box-toolbar">
          <button type="button" class="pill mode-pill" id="mode" aria-haspopup="menu" aria-expanded="false" aria-controls="modeMenu"></button>
          <button type="button" class="icon-button" id="attachButton" title="Add context" aria-label="Add context" aria-haspopup="menu" aria-expanded="false" aria-controls="attachMenu">${icon("paperclip")}</button>
          <button type="button" class="icon-button" id="approvalsButton" title="Auto-approve settings" aria-label="Auto-approve settings" aria-haspopup="dialog" aria-expanded="false" aria-controls="approvals">${icon("shield")}<span class="dot" id="approvalDot" hidden></span></button>
          <button type="button" class="icon-button terminals-button" id="terminalsButton" aria-haspopup="dialog" aria-expanded="false" aria-controls="terminalsPanel" hidden></button>
          <input type="file" id="imageInput" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
          <span class="spacer"></span>
          <button type="button" class="context-ring" id="context" hidden title="Context"><span id="contextLabel"></span></button>
          <button type="button" class="pill model" id="model" title="Switch model" aria-haspopup="menu" aria-expanded="false" aria-controls="modelMenu"></button>
          <button type="submit" class="send" id="send" title="Send" aria-label="Send">${icon("send")}</button>
          <button type="button" class="send stop" id="stop" title="Stop (Esc)" aria-label="Stop" hidden>${icon("stop")}</button>
        </div>
      </div>
    </form>
  </footer>
  <div class="overlay" id="overlay" hidden></div>
  <div class="drop-zone" id="dropZone" aria-hidden="true"><span>${icon("paperclip")}Drop to add to the chat</span></div>
  <div class="celebration" id="celebration" hidden aria-hidden="true"><span>Phew! Done.</span></div>
</div>
<script nonce="${e(options.nonce)}" src="${e(options.scriptUri)}"></script>
</body>
</html>`;
}
