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
<div class="app" id="app" data-icon="${e(options.iconUri)}">
  <header class="toolbar">
    <div class="modes" role="radiogroup" aria-label="Mode">
      <button type="button" role="radio" data-mode="ask" title="Answers questions. Changes nothing.">Ask</button>
      <button type="button" role="radio" data-mode="plan" title="Explores the code and writes a plan. Changes nothing.">Plan</button>
      <button type="button" role="radio" data-mode="code" title="Edits files and runs commands with your approval.">Code</button>
    </div>
    <button type="button" class="model" id="model" title="Configure the model"></button>
  </header>
  <main class="transcript" id="transcript" aria-live="polite">
    <section class="welcome" id="welcome">
      <img class="logo" src="${e(options.iconUri)}" alt="" width="72" height="72">
      <h1>Phew</h1>
      <p class="tagline">Bug fixed. Phew.</p>
      <ul class="tips">
        <li>Ask about your code, or describe a change.</li>
        <li>Click <strong>Phew it!</strong> on any error in the editor.</li>
        <li>Every change shows a diff. Restore a checkpoint at any time.</li>
      </ul>
      <button type="button" class="primary" id="setup" hidden>Choose a model</button>
    </section>
  </main>
  <footer class="footer">
    <div class="meter" id="meter"></div>
    <form class="composer" id="composer">
      <label class="visually-hidden" for="prompt">Message</label>
      <textarea id="prompt" rows="3" placeholder="Ask Phew or describe a change…"></textarea>
      <div class="actions">
        <button type="button" class="secondary" id="newChat" title="Start a new chat">New</button>
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
