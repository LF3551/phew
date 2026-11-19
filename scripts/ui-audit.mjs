// UI audit of the chat: the real page (dist/webview.js, media/chat.css) with a fake host, in many states,
// three themes, and three widths. Each state is checked for console errors, content that sticks out or makes
// the page scroll sideways, controls without an accessible name, controls that cover each other, and text
// with too little contrast. Screenshots go to the temp folder for a look.
//
//   npm run build && PLAYWRIGHT=/path/to/node_modules/playwright node scripts/ui-audit.mjs [state…]
//
// The exit code is 1 when a check fails.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(tmpdir(), "phew-ui-audit");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");

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
const nonce = "uiaudit";

const common = {
  "--vscode-font-family": '-apple-system, "Segoe UI", "Helvetica Neue", sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": 'Menlo, "SF Mono", Consolas, monospace',
  "--vscode-editor-font-size": "12px",
};

/** The colors that VS Code gives a webview in Dark Modern, Light Modern, and High Contrast. */
const themes = {
  dark: {
    body: "vscode-dark",
    vars: {
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
      "--vscode-input-placeholderForeground": "#989898",
      "--vscode-button-background": "#0078d4",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-hoverBackground": "#026ec1",
      "--vscode-button-secondaryBackground": "#313131",
      "--vscode-button-secondaryForeground": "#cccccc",
      "--vscode-list-hoverBackground": "#2a2d2e",
      "--vscode-list-activeSelectionBackground": "#04395e",
      "--vscode-list-activeSelectionForeground": "#ffffff",
      "--vscode-toolbar-hoverBackground": "rgba(90,93,94,.31)",
      "--vscode-textLink-foreground": "#4daafc",
      "--vscode-textCodeBlock-background": "#2b2b2b",
      "--vscode-textPreformat-foreground": "#d0d0d0",
      "--vscode-editorWarning-foreground": "#cca700",
      "--vscode-testing-iconPassed": "#73c991",
      "--vscode-terminal-background": "#181818",
      "--vscode-terminal-foreground": "#cccccc",
      "--vscode-badge-background": "#616161",
      "--vscode-badge-foreground": "#f8f8f8",
      "--vscode-keybindingLabel-background": "rgba(128,128,128,.17)",
      "--vscode-editor-findMatchBackground": "#9e6a03",
      "--vscode-editor-findMatchHighlightBackground": "rgba(234,92,0,.33)",
    },
  },
  light: {
    body: "vscode-light",
    vars: {
      "--vscode-foreground": "#3b3b3b",
      "--vscode-descriptionForeground": "#717171",
      "--vscode-errorForeground": "#f85149",
      "--vscode-focusBorder": "#005fb8",
      "--vscode-sideBar-background": "#f8f8f8",
      "--vscode-editor-background": "#ffffff",
      "--vscode-editorWidget-background": "#f8f8f8",
      "--vscode-widget-border": "#e5e5e5",
      "--vscode-widget-shadow": "rgba(0,0,0,.16)",
      "--vscode-panel-border": "#e5e5e5",
      "--vscode-input-background": "#ffffff",
      "--vscode-input-foreground": "#3b3b3b",
      "--vscode-input-border": "#cecece",
      "--vscode-input-placeholderForeground": "#767676",
      "--vscode-button-background": "#005fb8",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-hoverBackground": "#0258a8",
      "--vscode-button-secondaryBackground": "#e5e5e5",
      "--vscode-button-secondaryForeground": "#3b3b3b",
      "--vscode-list-hoverBackground": "#f2f2f2",
      "--vscode-list-activeSelectionBackground": "#e8e8e8",
      "--vscode-list-activeSelectionForeground": "#000000",
      "--vscode-toolbar-hoverBackground": "rgba(184,184,184,.31)",
      "--vscode-textLink-foreground": "#005fb8",
      "--vscode-textCodeBlock-background": "#f8f8f8",
      "--vscode-textPreformat-foreground": "#3b3b3b",
      "--vscode-editorWarning-foreground": "#bf8803",
      "--vscode-testing-iconPassed": "#388a34",
      "--vscode-terminal-background": "#f8f8f8",
      "--vscode-terminal-foreground": "#3b3b3b",
      "--vscode-badge-background": "#cccccc",
      "--vscode-badge-foreground": "#3b3b3b",
      "--vscode-keybindingLabel-background": "rgba(221,221,221,.4)",
      "--vscode-editor-findMatchBackground": "#a8ac94",
      "--vscode-editor-findMatchHighlightBackground": "rgba(234,92,0,.33)",
    },
  },
  hc: {
    body: "vscode-high-contrast",
    vars: {
      "--vscode-foreground": "#ffffff",
      "--vscode-descriptionForeground": "rgba(255,255,255,.7)",
      "--vscode-errorForeground": "#f48771",
      "--vscode-focusBorder": "#f38518",
      "--vscode-contrastBorder": "#6fc3df",
      "--vscode-contrastActiveBorder": "#f38518",
      "--vscode-sideBar-background": "#000000",
      "--vscode-editor-background": "#000000",
      "--vscode-editorWidget-background": "#0c141f",
      "--vscode-widget-border": "#6fc3df",
      "--vscode-panel-border": "#6fc3df",
      "--vscode-input-background": "#000000",
      "--vscode-input-foreground": "#ffffff",
      "--vscode-input-border": "#6fc3df",
      "--vscode-button-background": "#000000",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-border": "#6fc3df",
      "--vscode-button-secondaryBackground": "#000000",
      "--vscode-button-secondaryForeground": "#ffffff",
      "--vscode-textLink-foreground": "#21a6ff",
      "--vscode-textCodeBlock-background": "#000000",
      "--vscode-textPreformat-foreground": "#ffd700",
      "--vscode-terminal-background": "#000000",
      "--vscode-terminal-foreground": "#ffffff",
      "--vscode-badge-background": "#000000",
      "--vscode-badge-foreground": "#ffffff",
      "--vscode-editor-findMatchBackground": "#000000",
    },
  },
};

function chatPage(theme) {
  const html = renderChatHtml({
    cspSource: "file:",
    nonce,
    scriptUri: file("dist/webview.js"),
    styleUri: file("media/chat.css"),
    terminalStyleUri: file("dist/webview.css"),
    iconUri: file("resources/icon.svg"),
  });
  const vars = Object.entries({ ...common, ...themes[theme].vars })
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  const fake = `<style nonce="${nonce}">html{${vars}} body{margin:0;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}</style>
<script nonce="${nonce}">window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>undefined,setState:()=>undefined});</script>`;
  return html
    .replace("<body>", `<body class="${themes[theme].body}">`)
    .replace(`<script nonce="${nonce}" src=`, `${fake}\n<script nonce="${nonce}" src=`);
}
for (const theme of Object.keys(themes)) writeFileSync(path.join(work, `chat-${theme}.html`), chatPage(theme));

// The data of the chat.

const now = Date.now();
const modes = [
  { id: "ask", name: "Ask", description: "Answers questions about your code.", changes: false, builtIn: true },
  { id: "plan", name: "Plan", description: "Explores the code and writes a plan.", changes: false, builtIn: true },
  { id: "code", name: "Code", description: "Edits files and runs commands.", changes: true, builtIn: true },
  { id: "debug", name: "Debug", description: "Finds the root cause, then fixes it.", changes: true, builtIn: true },
  { id: "review", name: "Review", description: "Reviews changes for bugs and style.", changes: false, builtIn: true },
  {
    id: "docs",
    name: "Documentation writer",
    description: "Writes clear documentation.",
    changes: true,
    builtIn: false,
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
    cost: "$0.42",
    celebrate: false,
    stats: "",
    approvals: {
      review: "editor",
      commands: "allowlist",
      mcp: false,
      custom: false,
      defaults: { review: "editor", commands: "allowlist", mcp: false },
      allowlist: [
        "npm test",
        "npm run lint",
        "git status",
        "pytest -q --maxfail=1 tests/very/long/path/to/a/test_file.py",
      ],
    },
    reviewFiles: 0,
    runningSessions: 0,
    context: 0.62,
    contextLabel: "62% of 200K",
    fontSize: null,
    sendWith: "enter",
    appearance: {
      style: "bubbles",
      accentColor: "",
      userBubbleColor: "",
      fontFamily: "",
      lineHeight: null,
      codeFontSize: null,
      timestamps: "hover",
      messageActions: "hover",
      avatars: false,
      mascot: "still",
      clock: "auto",
    },
    assistant: { name: "Phew", avatar: "", persona: "partner", customPersona: "", userName: "", language: "match" },
    onboarding: false,
    modelId: "claude-sonnet-4.5",
    terminals: [
      { id: "1", name: "Terminal 1", pid: 4242, shell: "zsh", cwd: "/home/sam/projects/shop", state: "idle" },
      {
        id: "2",
        name: "Terminal 2",
        pid: 4310,
        shell: "zsh",
        cwd: "/home/sam/projects/shop/packages/web-frontend-with-a-long-name",
        state: "running",
        command: "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort",
      },
    ],
    models: [
      {
        id: "m1",
        name: "Claude Sonnet",
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        contextWindow: 200000,
        active: true,
      },
      {
        id: "m2",
        name: "GitHub Copilot (token) · gpt-6.1-sol",
        provider: "openai",
        model: "gpt-6.1-sol",
        contextWindow: 400000,
        active: false,
      },
      { id: "m3", name: "Auto", provider: "vscode", model: "auto", active: false },
      {
        id: "m4",
        name: "Ollama · qwen2.5-coder:14b-instruct-q8_0",
        provider: "openai",
        model: "qwen2.5-coder:14b-instruct-q8_0",
        contextWindow: 32768,
        active: false,
      },
    ],
    showThinking: true,
    pinned: false,
    ...overrides,
  };
}

const longWord =
  "https://example.com/a/very/long/path/without/any/spaces/that/should/wrap/somewhere/instead/of/overflowing/the/chat/view?query=1234567890";
const answer = [
  "## What I found",
  "",
  "The login timed out because `timeout` was read from the wrong option. See `src/auth/login-service-with-a-long-name.ts:42` and src/retry.ts.",
  "",
  "| File | Lines | Why it changed and what it means for the people who maintain the login service |",
  "| --- | --- | --- |",
  "| src/auth.ts | +12 −3 | The timeout now comes from Options, with a default of 30 seconds |",
  "| src/retry.ts | +40 | New: retry with exponential backoff and jitter |",
  "",
  "```ts",
  "export async function signIn(options: Options): Promise<Session> { const timeout = options.timeout ?? DEFAULT_TIMEOUT_IN_MILLISECONDS; return withRetry(() => post('/login', options), { timeout }); }",
  "```",
  "",
  `Long link: ${longWord}`,
  "",
  "1. First step",
  "2. Second step with **bold** and *italic*",
  "   - nested item",
].join("\n");

function command(id, cmd, description, status, detail, extra = {}) {
  const base = {
    type: "tool",
    id,
    name: "run_command",
    summary: `run_command ${cmd}`,
    command: cmd,
    description,
    at: now - 120000,
  };
  const messages = [
    { ...base, status: "running" },
    { type: "toolOutput", id, text: "", where: "terminal", terminal: "1", ...extra },
  ];
  if (status !== "running") messages.push({ ...base, status, where: "terminal", detail, at: now - 110000 });
  return messages;
}

const kitchen = [
  {
    type: "state",
    state: state({
      reviewFiles: 3,
      reviewList: [
        { uri: "file:///w/src/auth.ts", path: "src/auth.ts", added: 12, removed: 3 },
        { uri: "file:///w/src/retry.ts", path: "src/retry.ts", added: 40, removed: 0 },
        {
          uri: "file:///w/packages/web/src/components/very/deep/folder/LoginForm.test.tsx",
          path: "packages/web/src/components/very/deep/folder/LoginForm.test.tsx",
          added: 118,
          removed: 64,
        },
      ],
    }),
  },
  {
    type: "user",
    id: "u1",
    text: `Fix the login timeout. Here is the log:\n${longWord}`,
    checkpointId: "c1",
    attachments: ["src/auth.ts", "Pasted text · 120 lines", "Chat: Speed up the test suite on CI"],
    at: now - 300000,
  },
  {
    type: "reasoningDelta",
    id: "r1",
    text: "The timeout looks wrong. Let me read the auth module and the retry helper first.",
  },
  {
    type: "reasoningEnd",
    id: "r1",
    text: "The timeout looks wrong. Let me read the auth module and the retry helper first.",
  },
  {
    type: "tool",
    id: "g1",
    name: "read_file",
    summary: "read_file src/auth.ts",
    status: "done",
    detail: "1: export ...",
    at: now - 290000,
  },
  {
    type: "tool",
    id: "g2",
    name: "search_text",
    summary: "search_text timeout",
    status: "done",
    detail: "src/auth.ts:3",
    at: now - 289000,
  },
  {
    type: "tool",
    id: "g3",
    name: "read_file",
    summary: "read_file src/missing.ts",
    status: "error",
    detail: "Error: not found",
    at: now - 288000,
  },
  ...command("t1", "pwd", "Print current working directory", "done", "$ pwd\n[exit code 0]\n/home/sam/projects/shop"),
  ...command(
    "t2",
    "npm test",
    "Run the unit tests",
    "error",
    "$ npm test\n[exit code 1]\n> vitest run\n ✗ src/login.test.ts > signs in\n   AssertionError: expected 'timeout' to be 'ok'\nTest Files 1 failed | 2 passed (3)",
  ),
  ...command(
    "t3",
    "sudo apt-get install -y libpq-dev",
    "Install the Postgres headers",
    "done",
    "$ sudo apt-get install -y libpq-dev\n[waiting for input]\n[sudo] password for sam:",
  ),
  ...command(
    "t4",
    'for i in $(seq 1 40); do echo "line $i of a long build log that goes on and on"; done',
    "Print a long log",
    "done",
    `$ for\n[exit code 0]\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long build log that goes on and on and on past the edge of a narrow panel`).join("\n")}`,
  ),
  ...command("t5", "npm run dev", "Start the dev server", "running", ""),
  {
    type: "approval",
    id: "p1",
    kind: "edit",
    title: "Edit src/auth.ts",
    detail: "2 changes",
    hunks: [
      {
        index: 0,
        preview:
          "@@ -3,1 +3,1 @@\n-  const timeout = options.retry.timeout;\n+  const timeout = options.timeout ?? DEFAULT_TIMEOUT_IN_MILLISECONDS_FOR_THE_LOGIN_SERVICE;",
      },
      { index: 1, preview: "@@ -10,0 +10,2 @@\n+import { withRetry } from './retry';\n+" },
    ],
  },
  {
    type: "approval",
    id: "p2",
    kind: "command",
    title: "Run a command",
    detail: "terraform apply -auto-approve -var-file=environments/production/very-long-file-name.tfvars",
    reason: "Changes systems outside the workspace",
    alwaysAllow: "terraform apply",
  },
  {
    type: "approval",
    id: "p3",
    kind: "mcp",
    title: "Use search from MCP server github",
    detail: '{ "query": "repo:LF3551/phew is:issue is:open label:bug sort:reactions-desc" }',
  },
  {
    type: "approval",
    id: "p4",
    kind: "question",
    title: "Which login should I keep?",
    detail: "Both work. The new one retries.",
    options: ["Keep the new one with retry", "Keep the old one", "Ask me later when the tests pass on CI"],
    allowText: true,
  },
  { type: "assistantStart", id: "a1" },
  { type: "assistantEnd", id: "a1", text: answer, at: now - 100000 },
  { type: "verify", attempt: 1, passed: false, output: "npm test\n1 failed" },
  { type: "verify", attempt: 2, passed: true, output: "npm test\nall passed" },
  {
    type: "summary",
    checkpointId: "c1",
    status: "done",
    seconds: 38,
    files: [
      { path: "src/auth.ts", kind: "modified", added: 12, removed: 3 },
      { path: "src/retry.ts", kind: "added", added: 40, removed: 0 },
      {
        path: "packages/web/src/components/very/deep/folder/LoginForm.test.tsx",
        kind: "modified",
        added: 118,
        removed: 64,
      },
    ],
    check: { command: "npm test", passed: true, attempts: 2 },
    pending: 3,
  },
  { type: "notice", level: "info", text: "Sent the request to Claude Sonnet again." },
  { type: "notice", level: "warning", text: "Claude Sonnet: rate limited. Retrying in 4 s (attempt 2 of 4)." },
  {
    type: "notice",
    level: "error",
    text: `Cannot reach Ollama at 127.0.0.1:11434 (ECONNREFUSED). Is the local server running? ${longWord}`,
  },
  { type: "user", id: "u2", text: "/btw what does withRetry do?", checkpointId: "u2", at: now - 50000 },
  { type: "assistantStart", id: "b1", variant: "btw" },
  {
    type: "assistantEnd",
    id: "b1",
    text: "It calls the function again after a failure, waiting a bit longer each time.",
    variant: "btw",
    at: now - 49000,
  },
  {
    type: "plan",
    plan: {
      goal: "Make the login work on slow networks and keep the tests green on CI",
      items: [
        { text: "Read the auth module", status: "done" },
        {
          text: "Move the timeout to Options and add a retry with backoff and jitter for every request",
          status: "in_progress",
        },
        { text: "Run the tests", status: "pending" },
      ],
    },
  },
  {
    type: "queue",
    items: [
      {
        id: "q1",
        text: "Also update the docs about the timeout option and add an example with a very long explanation",
      },
      { id: "q2", text: "Then commit" },
    ],
  },
];

const busy = (extra = {}) => ({ type: "state", state: state({ busy: true, ...extra }) });

/** The states to check: what the host sends, and what the user does. */
const states = {
  kitchen: { messages: kitchen },
  "kitchen-busy": { messages: [...kitchen, busy({ reviewFiles: 3 })] },
  welcome: {
    messages: [
      { type: "state", state: state({ title: "New chat" }) },
      {
        type: "suggestions",
        items: [
          {
            id: "s1",
            title: "Fix 3 errors in src/auth.ts",
            detail: "TypeScript: Property 'timeout' does not exist on type 'RetryOptions'",
            icon: "bug",
          },
          { id: "s2", title: "Continue yesterday's work", detail: "Speed up the test suite on CI", icon: "book" },
          { id: "s3", title: "Review the changes", detail: "4 files changed, +52 −3", icon: "git" },
        ],
      },
    ],
  },
  "welcome-resume-news": {
    messages: [
      {
        type: "state",
        state: state({
          title: "New chat",
          whatsNew: {
            version: "0.6",
            items: [
              "Each chat starts with an overview of the project: the stack, the commands, and the layout. /init writes AGENTS.md.",
              "Rules come with the files they are for.",
            ],
          },
          handoff: {
            path: ".phew/handoff/2026-11-18-fix-login.md",
            title: "Fix the login timeout on slow networks",
            status: "in-progress",
            created: new Date(now - 86400000).toISOString(),
          },
        }),
      },
    ],
  },
  setup: {
    messages: [
      { type: "state", state: state({ configured: false, model: "", provider: "", models: [], title: "New chat" }) },
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
            id: "ollama",
            label: "Ollama",
            detail: "Runs on your computer, so your code stays there. Install Ollama and a model of a few GB.",
            kind: "private",
          },
        ],
      },
    ],
  },
  onboarding: { messages: [{ type: "state", state: state({ onboarding: true, title: "New chat" }) }] },
  untrusted: { messages: [{ type: "state", state: state({ trusted: false, title: "New chat" }) }] },
  stall: {
    messages: [
      busy(),
      { type: "user", id: "u1", text: "Explain the login flow.", checkpointId: "c1", at: now - 40000 },
    ],
    after: async (page) => {
      await page.evaluate(() => {
        const real = Date.now;
        Date.now = () => real() + 40000;
      });
      await page.waitForTimeout(1300);
    },
  },
  "menu-mode": { messages: kitchen, click: "#mode" },
  "menu-model": { messages: kitchen, click: "#model" },
  "menu-attach": { messages: kitchen, click: "#attachButton" },
  "menu-approvals": { messages: kitchen, click: "#approvalsButton" },
  // In the side bar, VS Code shows these buttons in its own title bar; they send a message to the chat.
  "menu-appearance": { messages: [...kitchen, { type: "showAppearance" }] },
  "menu-terminals": { messages: kitchen, click: "#terminalsButton" },
  // The bar of files to review shows when the summary card with the same buttons is out of view.
  "review-open": { messages: kitchen.filter((message) => message.type !== "summary"), click: "#reviewToggle" },
  history: {
    messages: [
      ...kitchen,
      {
        type: "sessions",
        sessions: [
          {
            id: "s1",
            title: "Fix the login test",
            running: true,
            active: true,
            needsApproval: false,
            updatedAt: now,
            preview: "Fix the login timeout",
            pinned: false,
          },
          {
            id: "s2",
            title: "A chat with a very long title that will not fit into a narrow side bar at all",
            running: false,
            active: false,
            needsApproval: true,
            updatedAt: now - 3600000,
            worktree: "phew/feature-with-a-long-branch-name",
            preview: "Please also check the docs",
            pinned: true,
          },
        ],
        history: [
          {
            id: "h1",
            title: "Speed up the test suite on CI",
            updatedAt: now - 86400000 * 2,
            messages: 12,
            preview: "The suite takes 9 minutes",
          },
          { id: "h2", title: "Old chat", updatedAt: now - 86400000 * 40, messages: 3 },
        ],
      },
      { type: "openPanel" },
    ],
  },
  find: {
    messages: kitchen,
    after: async (page) => {
      await page.keyboard.press("Control+f");
      await page.keyboard.type("timeout");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
    },
  },
  paste: {
    messages: kitchen,
    after: async (page) => {
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData(
          "text/plain",
          Array.from(
            { length: 120 },
            (_, i) =>
              `2026-11-19 07:${String(i % 60).padStart(2, "0")} ERROR worker ${i}: connection reset by peer while reading the response body`,
          ).join("\n"),
        );
        const prompt = document.getElementById("prompt");
        prompt.focus();
        prompt.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(150);
      await page.click(".chip-open");
      await page.waitForTimeout(150);
    },
  },
  // The accents of Appearance: text and buttons in the accent stay readable in every theme.
  ...Object.fromEntries(
    ["#8b5cf6", "#f08c2e", "#2fb67c", "#e64980"].map((color) => [
      `accent-${color.slice(1)}`,
      {
        messages: [
          { type: "state", state: state({ appearance: { ...state().appearance, accentColor: color } }) },
          ...kitchen.slice(1),
        ],
      },
    ]),
  ),
  "classic-style": {
    messages: [
      {
        type: "state",
        state: state({
          appearance: {
            ...state().appearance,
            style: "classic",
            avatars: true,
            timestamps: "always",
            messageActions: "always",
          },
        }),
      },
      ...kitchen.slice(1),
    ],
  },
  "compact-style-large-font": {
    messages: [
      {
        type: "state",
        state: state({ fontSize: 18, appearance: { ...state().appearance, style: "compact", timestamps: "always" } }),
      },
      ...kitchen.slice(1),
    ],
  },
};

// DUMP=1 writes the messages of each state to the temp folder, to reproduce a problem by hand.
if (process.env.DUMP)
  for (const [name, scene] of Object.entries(states))
    writeFileSync(path.join(work, `${name}.json`), JSON.stringify(scene.messages));

// The checks, inside the page.
function auditPage() {
  const issues = [];
  const viewport = document.documentElement.clientWidth;
  const describe = (node) => {
    const id = node.id ? `#${node.id}` : "";
    const classes =
      typeof node.className === "string" && node.className
        ? `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";
    const text = (node.getAttribute?.("aria-label") || node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${node.tagName.toLowerCase()}${id}${classes}${text ? ` "${text}"` : ""}`;
  };
  const visible = (node) => {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) return false;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let item = node; item && item !== document.body; item = item.parentElement) {
      const style = getComputedStyle(item);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      // The content of a closed <details> is not shown, though the browser still gives it a box.
      if (item.parentElement?.tagName === "DETAILS" && !item.parentElement.open && item.tagName !== "SUMMARY")
        return false;
      // Content scrolled out of a box that clips it is not visible.
      if (item !== node && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        const clip = item.getBoundingClientRect();
        if (
          box.bottom <= clip.top + 1 ||
          box.top >= clip.bottom - 1 ||
          box.right <= clip.left + 1 ||
          box.left >= clip.right - 1
        )
          return false;
      }
    }
    return true;
  };
  const clipped = (node) => {
    for (let item = node.parentElement; item && item !== document.body; item = item.parentElement) {
      const style = getComputedStyle(item);
      if (style.overflowX !== "visible" || style.overflow !== "visible") return true;
    }
    return false;
  };
  if (document.documentElement.scrollWidth > viewport + 1)
    issues.push(`overflow: the page scrolls sideways (${document.documentElement.scrollWidth} > ${viewport})`);
  for (const node of document.querySelectorAll("body *")) {
    if (!visible(node)) continue;
    const box = node.getBoundingClientRect();
    if ((box.right > viewport + 1 || box.left < -1) && !clipped(node) && getComputedStyle(node).position !== "fixed")
      issues.push(
        `overflow: sticks out of the view by ${Math.round(Math.max(box.right - viewport, -box.left))}px: ${describe(node)}`,
      );
  }
  // Every control has a name for screen readers.
  const controls = [
    ...document.querySelectorAll(
      "button, a[href], input, select, textarea, [role=button], [role=menuitem], [role=tab], [role=radio], [role=checkbox], [role=option]",
    ),
  ].filter(visible);
  for (const control of controls) {
    const labelled = control.getAttribute("aria-labelledby");
    const name =
      control.getAttribute("aria-label") ||
      labelled
        ?.split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim() ||
      control.getAttribute("title") ||
      control.textContent?.trim() ||
      control.getAttribute("placeholder") ||
      (control.id && document.querySelector(`label[for="${control.id}"]`)?.textContent?.trim()) ||
      control.closest("label")?.textContent?.trim();
    if (!name) issues.push(`a11y: control without a name: ${describe(control)}`);
  }
  // Controls do not cover each other. A menu, a popover, or a panel covers the chat on purpose.
  const overlay =
    ".popover, #panel, [role=dialog], [role=menu], [role=listbox], .find-bar, .chat-menu, .undo-toast, .jump";
  const boxes = controls.map((control) => ({
    control,
    box: control.getBoundingClientRect(),
    layer: control.closest(overlay),
  }));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.control.contains(b.control) || b.control.contains(a.control)) continue;
      if (a.layer !== b.layer) continue;
      // The actions button of a chat row sits at the end of the row on purpose; the title stops before it.
      if (a.control.matches(".chat-more") || b.control.matches(".chat-more")) continue;
      const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width > 3 && height > 3)
        issues.push(
          `overlap: ${describe(a.control)} and ${describe(b.control)} (${Math.round(width)}×${Math.round(height)})`,
        );
    }
  // Text has enough contrast.
  const parse = (color) => {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (!match) return undefined;
    const [r, g, b, a = 1] = match[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r, g, b, a };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const background = (node) => {
    const layers = [];
    for (let item = node; item; item = item.parentElement) {
      const color = parse(getComputedStyle(item).backgroundColor);
      if (color && color.a > 0) {
        layers.push(color);
        if (color.a >= 1) break;
      }
    }
    let result = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 0, g: 0, b: 0, a: 1 };
    for (const layer of layers.reverse()) {
      result = {
        r: layer.r * layer.a + result.r * (1 - layer.a),
        g: layer.g * layer.a + result.g * (1 - layer.a),
        b: layer.b * layer.a + result.b * (1 - layer.a),
        a: 1,
      };
    }
    return result;
  };
  const toRgb = (value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const node = text.parentElement;
    if (!node || !text.nodeValue?.trim() || seen.has(node) || !visible(node)) continue;
    if (node.closest(".xterm, [aria-hidden=true], svg, .visually-hidden")) continue;
    seen.add(node);
    const style = getComputedStyle(node);
    const color = parse(style.color);
    if (!color) continue;
    const back = background(node);
    const fore = {
      r: color.r * color.a + back.r * (1 - color.a),
      g: color.g * color.a + back.g * (1 - color.a),
      b: color.b * color.a + back.b * (1 - color.a),
    };
    const [light, dark] = [luminance(fore), luminance(back)].sort((x, y) => y - x);
    const ratio = (light + 0.05) / (dark + 0.05);
    const size = Number.parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const disabled = node.closest("[disabled], [aria-disabled=true]");
    // The description color of the theme on its own side bar is the choice of the theme, as everywhere in VS Code.
    const description = getComputedStyle(document.body).getPropertyValue("--vscode-descriptionForeground").trim();
    if (description && style.color === toRgb(description)) continue;
    if (!disabled && ratio < (large ? 3 : 4.5))
      issues.push(
        `contrast: ${ratio.toFixed(2)} for "${text.nodeValue.trim().slice(0, 30)}" in ${describe(node).split(" ")[0]}`,
      );
  }
  return issues;
}

const wanted = process.argv.slice(2);
const widths = [300, 496, 900];
const browser = await chromium.launch();
const report = new Map();
let failures = 0;
for (const theme of Object.keys(themes)) {
  for (const width of widths) {
    for (const [name, scene] of Object.entries(states)) {
      if (wanted.length && !wanted.includes(name)) continue;
      const page = await browser.newPage({ viewport: { width, height: 820 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(`error: ${error.message}`));
      page.on(
        "console",
        (message) => message.type() === "error" && errors.push(`console: ${message.text().slice(0, 200)}`),
      );
      await page.goto(pathToFileURL(path.join(work, `chat-${theme}.html`)).href);
      await page.waitForTimeout(150);
      for (const message of scene.messages) await page.evaluate((data) => window.postMessage(data, "*"), message);
      await page.waitForTimeout(500);
      if (scene.click) {
        await page
          .click(scene.click, { timeout: 3000 })
          .catch((error) => errors.push(`click ${scene.click}: ${error.message.split("\n")[0]}`));
        await page.waitForTimeout(250);
      }
      await scene.after?.(page);
      const issues = [...errors, ...(await page.evaluate(auditPage))];
      const shot = path.join(work, `${theme}-${width}-${name}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      for (const issue of issues) {
        const key = issue.replace(/\d+(\.\d+)?px|\(\d+×\d+\)|\(\d+ > \d+\)/g, "").trim();
        const entry = report.get(key) ?? { issue, where: [] };
        entry.where.push(`${theme}/${width}/${name}`);
        report.set(key, entry);
      }
      await page.close();
    }
  }
}
await browser.close();
for (const { issue, where } of report.values()) {
  failures++;
  console.log(
    `${issue}\n    in ${where.length} place(s): ${where.slice(0, 6).join(", ")}${where.length > 6 ? ", …" : ""}`,
  );
}
console.log(`\n${report.size} distinct issues. Screenshots: ${work}`);
process.exitCode = failures > 0 ? 1 : 0;
