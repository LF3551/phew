// Renders the README and Marketplace pictures from the real chat: dist/webview.js and media/chat.css
// with a fake host. Each picture is a 1600×900 card: the logo and a headline on the left, the chat on the right.
//
//   npm run build && PLAYWRIGHT=/path/to/node_modules/playwright node scripts/readme-images.mjs [scene…]
//
// Playwright is not a dependency of Phew; point PLAYWRIGHT to any installed copy with Chromium.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs/images");
const work = path.join(tmpdir(), "phew-readme-images");
mkdirSync(work, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");

// The real page of the chat, from the same code as the extension.
const htmlModule = path.join(work, "html.cjs");
await esbuild.build({
  entryPoints: [path.join(root, "src/host/html.ts")],
  outfile: htmlModule,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { renderChatHtml } = require(htmlModule);
const file = (relative) => pathToFileURL(path.join(root, relative)).href;
const nonce = "readmeimages";

/** Colors of the Dark Modern theme, as VS Code gives them to a webview. */
const theme = {
  "--vscode-font-family": '-apple-system, "Segoe UI", "Helvetica Neue", sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": 'Menlo, "SF Mono", Consolas, monospace',
  "--vscode-editor-font-size": "12px",
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-errorForeground": "#f85149",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-sideBar-background": "#181818",
  "--vscode-editor-background": "#1f1f1f",
  "--vscode-editorWidget-background": "#202020",
  "--vscode-widget-border": "#313131",
  "--vscode-widget-shadow": "rgba(0,0,0,.36)",
  "--vscode-panel-border": "#2b2b2b",
  "--vscode-input-background": "#313131",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-button-background": "#0078d4",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#026ec1",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-toolbar-hoverBackground": "rgba(90,93,94,.31)",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-textCodeBlock-background": "#2b2b2b",
  "--vscode-textPreformat-foreground": "#d0d0d0",
  "--vscode-editorWarning-foreground": "#cca700",
  "--vscode-testing-iconPassed": "#73c991",
  "--vscode-terminal-background": "#181818",
  "--vscode-terminal-foreground": "#cccccc",
  "--vscode-terminal-ansiGreen": "#0dbc79",
  "--vscode-terminal-ansiBrightGreen": "#23d18b",
  "--vscode-terminal-ansiRed": "#cd3131",
  "--vscode-terminal-ansiBrightRed": "#f14c4c",
  "--vscode-terminal-ansiYellow": "#e5e510",
  "--vscode-terminal-ansiCyan": "#11a8cd",
  "--vscode-terminal-ansiBrightBlack": "#666666",
};

function chatPage() {
  const html = renderChatHtml({
    cspSource: "file:",
    nonce,
    scriptUri: file("dist/webview.js"),
    styleUri: file("media/chat.css"),
    terminalStyleUri: file("dist/webview.css"),
    iconUri: file("resources/icon.svg"),
  });
  const vars = Object.entries(theme)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  // A fake VS Code: the API that the webview expects, and the theme on the page.
  const fake = `<style nonce="${nonce}">html{${vars}} body{margin:0;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}</style>
<script nonce="${nonce}">window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>undefined,setState:()=>undefined});</script>`;
  return html
    .replace("<body>", '<body class="vscode-dark">')
    .replace(`<script nonce="${nonce}" src=`, `${fake}\n<script nonce="${nonce}" src=`);
}
writeFileSync(path.join(work, "chat.html"), chatPage());

const modes = [
  { id: "ask", name: "Ask", description: "Answers questions about your code.", changes: false, builtIn: true },
  { id: "plan", name: "Plan", description: "Explores the code and writes a plan.", changes: false, builtIn: true },
  {
    id: "code",
    name: "Code",
    description: "Edits files and runs commands with your approval.",
    changes: true,
    builtIn: true,
  },
  {
    id: "debug",
    name: "Debug",
    description: "Finds the root cause of a bug, then fixes it.",
    changes: true,
    builtIn: true,
  },
  {
    id: "review",
    name: "Review",
    description: "Reviews changes for bugs, security, and style.",
    changes: false,
    builtIn: true,
  },
];

function state(overrides = {}) {
  return {
    sessionId: "s1",
    title: "Fix the login test",
    mode: "code",
    modes,
    model: "Claude Sonnet",
    provider: "Anthropic",
    configured: true,
    busy: false,
    trusted: true,
    tokens: "12k",
    cost: "",
    celebrate: false,
    stats: "",
    approvals: {
      review: "editor",
      commands: "allowlist",
      mcp: false,
      custom: false,
      defaults: { review: "editor", commands: "allowlist", mcp: false },
      allowlist: ["npm test", "npm run lint", "git status", "pytest"],
    },
    reviewFiles: 0,
    runningSessions: 0,
    context: 0.18,
    contextLabel: "18%",
    fontSize: null,
    sendWith: "enter",
    appearance: {
      style: "bubbles",
      accentColor: "",
      userBubbleColor: "",
      fontFamily: "",
      lineHeight: null,
      codeFontSize: null,
      timestamps: "never",
      messageActions: "hover",
      avatars: false,
      mascot: "still",
    },
    assistant: { name: "Phew", avatar: "", persona: "partner", customPersona: "", userName: "", language: "match" },
    onboarding: false,
    modelId: "claude-sonnet-4.5",
    terminals: [],
    models: [
      {
        id: "m1",
        name: "Claude Sonnet",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        contextWindow: 200000,
        active: true,
      },
      { id: "m2", name: "GPT-5.1", provider: "openai", model: "gpt-5.1", contextWindow: 400000, active: false },
      { id: "m3", name: "Auto", provider: "vscode", model: "auto", active: false },
    ],
    showThinking: false,
    pinned: false,
    ...overrides,
  };
}

const now = Date.now();
const testOutput =
  "\x1b[1m> shop@1.4.0 test\x1b[0m\r\n> vitest run\r\n\r\n" +
  " \x1b[32m✓\x1b[0m src/cart.test.ts \x1b[2m(14 tests)\x1b[0m\r\n" +
  " \x1b[32m✓\x1b[0m src/api.test.ts \x1b[2m(9 tests)\x1b[0m\r\n" +
  " \x1b[31m✗\x1b[0m src/login.test.ts \x1b[2m> signs in with a slow network\x1b[0m\r\n" +
  "   \x1b[31mAssertionError: expected 'timeout' to be 'ok'\x1b[0m\r\n" +
  "\r\n Test Files  \x1b[1;31m1 failed\x1b[0m | \x1b[1;32m2 passed\x1b[0m (3)\r\n";

/** Each scene: the card text, the chat title, and what the fake host sends. */
const scenes = {
  connect: {
    title: "Start in a minute",
    text: "Phew shows what is ready on your computer and what is free to start. One click opens the setup with your choice.",
    chatTitle: "New chat",
    alt: "The first-run card: an OpenAI key found in the environment, the free options GitHub Copilot, Google Gemini, and OpenRouter, and Ollama as the private option",
    messages: [
      { type: "state", state: state({ configured: false, model: "", provider: "", models: [] }) },
      {
        type: "setupOptions",
        options: [
          { id: "openai", label: "OpenAI", detail: "Key found in $OPENAI_API_KEY.", kind: "ready" },
          {
            id: "copilot",
            label: "GitHub Copilot",
            detail: "Sign in to GitHub in VS Code. The free Copilot plan is enough to start, with no key.",
            kind: "free",
          },
          {
            id: "gemini",
            label: "Google Gemini",
            detail:
              "A free key from Google AI Studio, with no card. On the free tier, Google may use your requests to improve its products.",
            kind: "free",
          },
          {
            id: "openrouter",
            label: "OpenRouter",
            detail: "Free models with a free key: 50 requests a day, enough to try Phew.",
            kind: "free",
          },
          {
            id: "ollama",
            label: "Ollama",
            detail: "Runs on your computer, so your code stays there. Install Ollama and a model of a few GB.",
            kind: "private",
          },
        ],
      },
    ],
    after: (page) => page.evaluate(() => document.getElementById("setupCard")?.scrollIntoView({ block: "start" })),
  },
  terminal: {
    title: "A real terminal, shared",
    text: "The agent works in your shell: ssh, venvs, and REPLs carry over. Watch it live, answer a prompt, and fix a failure in one click.",
    chatTitle: "Fix the login test",
    alt: "Commands in the chat: a sudo prompt that waits for an answer, failing tests with Phew it!, and a build that runs live",
    messages: [
      { type: "state", state: state({ busy: true, title: "Fix the login test" }) },
      {
        type: "user",
        id: "u1",
        text: "Install the dependencies, run the tests, and build.",
        checkpointId: "c1",
        at: now - 60000,
      },
      {
        type: "tool",
        id: "t1",
        name: "run_command",
        summary: "run_command sudo apt-get install -y libpq-dev",
        status: "running",
        command: "sudo apt-get install -y libpq-dev",
        description: "Install the Postgres headers",
        at: now - 52000,
      },
      { type: "toolOutput", id: "t1", text: "", where: "terminal", approval: "Approved by you", terminal: "1" },
      { type: "toolOutput", id: "t1", text: "[sudo] password for sam: " },
      {
        type: "tool",
        id: "t1",
        name: "run_command",
        summary: "run_command sudo apt-get install -y libpq-dev",
        status: "done",
        command: "sudo apt-get install -y libpq-dev",
        description: "Install the Postgres headers",
        where: "terminal",
        detail: "$ sudo apt-get install -y libpq-dev\n[waiting for input]\n[sudo] password for sam:",
        at: now - 49000,
      },
      {
        type: "tool",
        id: "t2",
        name: "run_command",
        summary: "run_command npm test",
        status: "running",
        command: "npm test",
        description: "Run the unit tests",
        at: now - 30000,
      },
      {
        type: "toolOutput",
        id: "t2",
        text: "",
        where: "terminal",
        approval: "Auto-approved: your allowlist: npm test",
        terminal: "1",
      },
      {
        type: "toolOutput",
        id: "t2",
        text: " \x1b[31m✗\x1b[0m src/login.test.ts \x1b[2m> signs in with a slow network\x1b[0m\r\n   \x1b[31mAssertionError: expected 'timeout' to be 'ok'\x1b[0m\r\n Test Files  \x1b[1;31m1 failed\x1b[0m | \x1b[1;32m2 passed\x1b[0m (3)\r\n",
      },
      {
        type: "tool",
        id: "t2",
        name: "run_command",
        summary: "run_command npm test",
        status: "done",
        command: "npm test",
        description: "Run the unit tests",
        where: "terminal",
        detail: "$ npm test\n[exit code 1]\n(output)",
        at: now - 25800,
      },
      {
        type: "tool",
        id: "t3",
        name: "run_command",
        summary: "run_command npm run build",
        status: "running",
        command: "npm run build",
        description: "Build the app",
        at: now - 4200,
      },
      {
        type: "toolOutput",
        id: "t3",
        text: "",
        where: "terminal",
        approval: "Auto-approved: only reads",
        terminal: "2",
      },
      {
        type: "toolOutput",
        id: "t3",
        text: "\x1b[2mvite v6.2.0 building for production...\x1b[0m\r\n\x1b[32m✓\x1b[0m 1284 modules transformed.\r\n",
      },
    ],
  },
  terminals: {
    title: "Every terminal in sight",
    text: "See what each terminal of the agent runs, with its process and folder. Stop it, or close it with every process it started.",
    chatTitle: "Run the shop locally",
    alt: "The Terminals panel: terminal 1 is idle, terminal 2 runs npm run dev, terminal 3 waits for a password in ssh, with process ids, folders, Stop, and Close",
    messages: [
      {
        type: "state",
        state: state({
          title: "Run the shop locally",
          terminals: [
            { id: "1", name: "Terminal 1", pid: 41207, shell: "zsh", cwd: "/Users/sam/shop", state: "idle" },
            {
              id: "2",
              name: "Terminal 2",
              pid: 41388,
              shell: "zsh",
              cwd: "/Users/sam/shop/web",
              state: "running",
              command: "npm run dev",
            },
            {
              id: "3",
              name: "Terminal 3",
              pid: 41502,
              shell: "zsh",
              cwd: "/Users/sam/shop",
              state: "waiting",
              command: "ssh deploy@staging",
            },
          ],
        }),
      },
      {
        type: "user",
        id: "u1",
        text: "Start the web app and the API, then check the staging server.",
        checkpointId: "c1",
        at: now - 90000,
      },
      { type: "assistantStart", id: "a1" },
      {
        type: "assistantEnd",
        id: "a1",
        text: "The web app runs in terminal 2 and answers on `http://localhost:5173`. Terminal 3 is connected to staging and waits for your password.",
        at: now - 20000,
      },
    ],
    after: async (page) => {
      await page.click("#terminalsButton");
    },
  },
  family: {
    title: "Make it yours",
    text: "Pick a look from the Phew family, a name, and a character. The mascot blinks, follows your pointer, and sweats while it works.",
    chatTitle: "New chat",
    alt: "The assistant card: a cat named Mochi with the Mentor character, and the Phew family of looks: drop, cat, bot, ghost, sprout, nerd, night owl, angel, ninja",
    messages: [
      {
        type: "state",
        state: state({
          assistant: {
            name: "Mochi",
            avatar: "look:cat",
            persona: "mentor",
            customPersona: "",
            userName: "Sam",
            language: "match",
          },
        }),
      },
      { type: "showOnboarding" },
    ],
    after: async (page) => {
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    },
  },
  modes: {
    title: "Ask, plan, then code",
    text: "Switch the mode with Shift+Tab. Ask, Plan, and Review change nothing; Code and Debug edit with your approval.",
    chatTitle: "Plan the checkout",
    alt: "The mode menu above the input: Ask, Plan, Code, Debug, and Review, each with a color, a description, and read-only marks",
    messages: [
      { type: "state", state: state({ mode: "plan", title: "Plan the checkout" }) },
      {
        type: "user",
        id: "u1",
        text: "How should we add Apple Pay to the checkout?",
        checkpointId: "c1",
        at: now - 20000,
      },
      { type: "assistantStart", id: "a1" },
      {
        type: "assistantEnd",
        id: "a1",
        text: "Three steps: add the payment request in `src/checkout/pay.ts`, verify the merchant on the server, and show the button only where the browser supports it.",
        at: now - 15000,
      },
    ],
    after: async (page) => {
      await page.click("#mode");
    },
  },
  approvals: {
    title: "You decide how far it goes",
    text: "Careful, Balanced, or Autopilot in one click. Dangerous commands always ask, and checkpoints undo any change.",
    chatTitle: "Fix the login test",
    alt: "The auto-approve panel: Careful, Balanced, and Autopilot levels, and rows for edits, commands with the allowlist, and MCP tools",
    messages: [
      { type: "state", state: state() },
      {
        type: "user",
        id: "u1",
        text: "Update the dependencies and run the tests.",
        checkpointId: "c1",
        at: now - 20000,
      },
    ],
    after: async (page) => {
      await page.click("#approvalsButton");
    },
  },
};

const titleIcons = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg><svg viewBox="0 0 24 24"><path d="M4 19 9 5l5 14M6 14h6"/></svg>`;

function cardPage(scene, chatImage) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:1600px;height:900px;overflow:hidden;background:#2a2d35;font-family:-apple-system,"Segoe UI","Helvetica Neue",sans-serif;color:#f0ede8}
  .left{position:absolute;left:96px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center}
  .brand{display:flex;align-items:center;gap:20px;font-size:30px;font-weight:700;margin-bottom:44px}
  .brand img{width:68px;height:68px;border-radius:18px}
  h1{margin:0 0 30px;font-size:66px;line-height:1.12;letter-spacing:-.01em}
  p{margin:0;font-size:30px;line-height:1.6;color:#9da2ad}
  .frame{position:absolute;left:776px;top:62px;width:744px;height:900px;background:#181818;border:2px solid #3a3d44;border-bottom:0;border-radius:24px 24px 0 0;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45)}
  .bar{height:66px;display:flex;align-items:center;padding:0 24px;border-bottom:2px solid #2b2b2b;font-size:21px}
  .bar b{color:#cccccc;letter-spacing:.02em}.bar span{color:#9d9d9d;margin-left:12px;flex:1}
  .bar svg{width:24px;height:24px;margin-left:20px;fill:none;stroke:#c5c5c5;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .shot{display:block;width:744px}
  </style></head><body>
  <div class="left"><div class="brand"><img src="${file("resources/icon.png")}">Phew</div><h1>${scene.title}</h1><p>${scene.text}</p></div>
  <div class="frame"><div class="bar"><b>PHEW: CHAT</b><span>${scene.chatTitle}</span>${titleIcons}</div><img class="shot" src="${pathToFileURL(chatImage).href}"></div>
  </body></html>`;
}

const browser = await chromium.launch();
const wanted = process.argv.slice(2);
for (const [name, scene] of Object.entries(scenes)) {
  if (wanted.length && !wanted.includes(name)) continue;
  // The chat at 1.5× fills the frame of the card: 496 × 556 CSS pixels.
  const page = await browser.newPage({ viewport: { width: 496, height: 556 }, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.goto(pathToFileURL(path.join(work, "chat.html")).href);
  await page.waitForTimeout(200);
  for (const message of scene.messages) {
    await page.evaluate((data) => window.postMessage(data, "*"), message);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  await scene.after?.(page);
  await page.waitForTimeout(400);
  const chatImage = path.join(work, `${name}-chat.png`);
  await page.screenshot({ path: chatImage });
  if (errors.length) console.warn(`${name}: ${errors.join("\n")}`);
  await page.close();
  const card = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const cardFile = path.join(work, `${name}-card.html`);
  writeFileSync(cardFile, cardPage(scene, chatImage));
  await card.goto(pathToFileURL(cardFile).href);
  await card.waitForTimeout(200);
  await card.screenshot({ path: path.join(out, `${name}.png`) });
  await card.close();
  console.log(`docs/images/${name}.png — ${scene.alt}`);
}
await browser.close();
