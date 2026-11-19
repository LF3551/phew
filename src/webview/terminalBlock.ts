import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { countErrors, findLinks, parseCommandResult, parseFileLink } from "../core/commandResult";
import { type AvatarLook, lookOf } from "../core/persona";
import { icon } from "../shared/icons";
import type { WebviewMessage } from "../shared/protocol";
import { copyWithFeedback } from "./copy";
import { mascotMotion } from "./mascotLife";
import { mascot } from "./persona";

/**
 * A command in the chat: a real terminal (xterm.js) inside the
 * chat that shows the output live and in color, the same as the terminal of the chat in the panel.
 * Typing in it goes to the running command; Ctrl+C stops it. Above it: what the command does in plain
 * words, the command, and the result.
 */

// The page allows only <style> elements with its nonce. xterm.js creates its own, so they get the nonce
// of the script of the page; everything else in the policy stays strict.
const pageNonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? "";
if (pageNonce) {
  const createElement = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const node = createElement(tag, options);
    if (tag.toLowerCase() === "style") node.setAttribute("nonce", pageNonce);
    return node;
  }) as typeof document.createElement;
}

const maximumRows = 16;
/** "Show all lines" opens the terminal up to this height; longer output is in the terminal of the chat. */
const expandedRows = 200;
/** A short result shows in one line: the output fits in a glance. */
const compactLines = 2;
const compactChars = 160;
/** Older terminals become plain text, so a long chat stays light. */
const liveTerminals = 12;

interface CommandView {
  readonly root: HTMLElement;
  /** The mascot of the assistant in the header: it reads while the command runs and reacts to the result. */
  readonly face: SVGSVGElement;
  readonly title: HTMLElement;
  readonly summary: HTMLElement;
  readonly fix: HTMLButtonElement;
  readonly body: HTMLElement;
  readonly answer: HTMLElement;
  readonly answerInput: HTMLInputElement;
  lastBeat: number;
  readonly verb: HTMLElement;
  readonly commandLine: HTMLElement;
  readonly full: HTMLElement;
  readonly actions: HTMLElement;
  readonly meta: HTMLElement;
  readonly screen: HTMLElement;
  readonly hint: HTMLElement;
  /** The output in one line, for a short result. */
  readonly peek: HTMLElement;
  /** The state after the mascot settles: a check, a cross, or a pause. */
  readonly state: HTMLElement;
  /** "Show all 240 lines" under a long output. */
  readonly more: HTMLButtonElement;
  /** True once the user opened or closed the command; Phew stops folding it by itself. */
  touched: boolean;
  /** The height of the terminal in rows; "Show all lines" raises it. */
  rows: number;
  settle?: ReturnType<typeof setTimeout>;
  term?: Terminal;
  fit?: FitAddon;
  search?: SearchAddon;
  /** The search field, shown with Ctrl+F or the search button. */
  searchBox?: HTMLInputElement;
  /** The output without colors, for Copy and for a terminal that turned into text. */
  text: string;
  where?: "terminal" | "background";
  started: number;
  finished?: number;
  lastOutput: number;
  /** The command still runs in the terminal of the chat (waiting for input, or in the background). */
  live: boolean;
  result?: { label: string; tone: "ok" | "error" | "muted" | "waiting" };
  description?: string;
  renderActions: () => void;
  post: (message: WebviewMessage) => void;
}

const views = new Map<string, CommandView>();
/** The look of the assistant, so the mascot in each command matches it. */
let look: AvatarLook | undefined;

/** The chat tells the terminals which look the assistant has. */
export function setTerminalLook(avatar: string): void {
  look = lookOf(avatar);
}

const order: string[] = [];
let ticker: ReturnType<typeof setInterval> | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconNode(name: string): Element {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  return template.content.firstElementChild as Element;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences start with a control character.
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
const plain = (text: string) =>
  text
    .replace(ansi, "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\n]*\r(?!\n)/g, "");

function seconds(ms: number): string {
  const total = Math.max(0, ms / 1000);
  if (total < 10) return `${total.toFixed(1)} s`;
  if (total < 60) return `${Math.round(total)} s`;
  return `${Math.floor(total / 60)} min ${Math.round(total % 60)} s`;
}

let themeCache: ITheme | undefined;
// VS Code changes the classes of the body when the theme changes; the colors are read again then.
new MutationObserver(() => {
  themeCache = undefined;
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

/** The colors of the VS Code terminal theme, read once per theme. */
function terminalTheme(): ITheme {
  themeCache ??= readTerminalTheme();
  return themeCache;
}

/** The colors of the VS Code terminal theme, so the chat terminal looks like the one in the panel. */
function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.body);
  const color = (name: string, fallback?: string) =>
    style.getPropertyValue(`--vscode-terminal-${name}`).trim() || fallback;
  const editor = style.getPropertyValue("--vscode-editor-background").trim();
  const names = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"] as const;
  const ansiColors: Record<string, string | undefined> = {};
  for (const name of names) {
    ansiColors[name.toLowerCase()] = color(`ansi${name}`);
    ansiColors[`bright${name}`] = color(`ansiBright${name}`);
  }
  return {
    background: color("background", editor || "#1e1e1e"),
    foreground: color("foreground", style.getPropertyValue("--vscode-foreground").trim() || "#cccccc"),
    cursor: color("cursor-foreground", "#cccccc"),
    selectionBackground: color("selectionBackground", "#264f78"),
    ...ansiColors,
  };
}

function renderStatus(view: CommandView): void {
  const elapsed = (view.finished ?? Date.now()) - view.started;
  const time = seconds(elapsed);
  const label = view.result ? view.result.label : "Running";
  view.verb.textContent = label;
  // With a description, the line reads as plain words; the state goes to the right ("Failed · exit 1 · 2.3 s").
  const described = Boolean(view.description);
  view.verb.hidden = described;
  view.root.dataset.tone = view.result?.tone ?? "running";
  // A short result on the right: the state, the time, the lines, and the errors of a failed command.
  const lines = view.text ? view.text.replace(/\s+$/, "").split("\n").length : 0;
  const parts = described && view.result?.tone !== "ok" ? [label, time] : [time];
  // A folded short result shows itself in the line; its line count says nothing new.
  if (view.result && lines > 0 && !view.root.classList.contains("compact"))
    parts.push(`${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}`);
  const errors = view.result?.tone === "error" ? countErrors(view.text) : 0;
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  view.summary.textContent = parts.join(" · ");
  view.state.replaceChildren(
    iconNode(view.result?.tone === "ok" ? "check" : view.result?.tone === "error" ? "close" : "stop"),
  );
  view.fix.hidden = view.result?.tone !== "error" || /^Denied|^Stopped/.test(view.result.label);
  view.answer.hidden = view.result?.tone !== "waiting" || view.result.label !== "Waiting for input";
  view.root.title = [view.description, view.result ? `${view.result.label} after ${time}` : `Running for ${time}`]
    .filter(Boolean)
    .join(" · ");
  setFace(view);
}

/** The mascot reads while the command runs, sweats while it waits for you, sighs with relief, or worries. */
function setFace(view: CommandView): void {
  const lively = mascotMotion() === "lively";
  const tone = view.result?.tone ?? "running";
  const face = tone === "ok" ? "relief" : tone === "error" ? "worry" : tone === "muted" ? "sleepy" : "open";
  const gaze = tone === "running" && lively ? "scan" : tone === "waiting" ? "down" : "center";
  if (view.face.dataset.face !== face) view.face.dataset.face = face;
  if (view.face.dataset.look !== gaze) view.face.dataset.look = gaze;
  view.face.classList.toggle("sweat", tone === "waiting");
}

/** Colors the parts of a shell command: programs, flags, strings, variables, and operators. */
export function highlightCommand(command: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern =
    /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\$\{?[A-Za-z_][\w]*\}?|\$\(|\$\d)|(\|\||&&|[|;&<>]+)|(\s--?[\w][\w-]*(?:=\S*)?)|(\s+)|([^\s|;&<>"'$]+)|([\s\S])/g;
  let atCommand = true;
  for (const match of command.matchAll(pattern)) {
    const [text, string, variable, operator, flag, space, word] = match;
    let className: string | undefined;
    if (string) className = "cmd-string";
    else if (variable) className = "cmd-var";
    else if (operator) {
      className = "cmd-op";
      atCommand = true;
    } else if (flag) className = "cmd-flag";
    else if (word) {
      if (atCommand && !/=/.test(word)) {
        className = "cmd-name";
        atCommand = false;
      }
    } else if (space && /\n/.test(space)) atCommand = true;
    if (variable === "$(") atCommand = true;
    const node = className ? el("span", className, text) : document.createTextNode(text);
    fragment.append(node);
  }
  return fragment;
}

/** The terminal grows with its output up to a limit, then scrolls inside. */
function resize(view: CommandView): void {
  const term = view.term;
  if (!term || !view.fit) return;
  const cols = view.fit.proposeDimensions()?.cols;
  const buffer = term.buffer.active;
  let used = buffer.length;
  while (
    used > 1 &&
    !buffer
      .getLine(used - 1)
      ?.translateToString(true)
      .trim()
  )
    used--;
  const rows = Math.max(1, Math.min(view.rows, used));
  if (cols && (cols !== term.cols || rows !== term.rows)) term.resize(Math.max(20, cols), rows);
  else if (rows !== term.rows) term.resize(term.cols, rows);
  // All output fits: show it from the top. Longer output follows the newest lines.
  if (used <= view.rows) term.scrollToTop();
  else term.scrollToBottom();
  // A long output: the box shows its end, and one click shows all of it, without a scroll inside a scroll.
  view.root.classList.toggle("expanded", view.rows >= expandedRows);
  const hiddenLines = used - rows;
  view.more.hidden = hiddenLines <= 0 || view.rows >= expandedRows;
  if (!view.more.hidden)
    view.more.textContent = `Show all ${used.toLocaleString("en-US")} lines (${hiddenLines.toLocaleString("en-US")} above)`;
  view.screen.hidden = used <= 1 && !buffer.getLine(0)?.translateToString(true).trim() && view.finished !== undefined;
}

function createTerminal(view: CommandView, id: string, post: (message: WebviewMessage) => void): void {
  const style = getComputedStyle(document.body);
  const term = new Terminal({
    rows: view.rows,
    cols: 80,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "none",
    scrollback: 5000,
    fontFamily: style.getPropertyValue("--vscode-editor-font-family").trim() || "monospace",
    fontSize: Number.parseFloat(style.getPropertyValue("--vscode-editor-font-size")) || 12,
    theme: terminalTheme(),
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  view.search = search;
  term.open(view.screen);
  // Ctrl+F (Cmd+F) searches the output of this command. Ctrl+C with selected text copies it, like the
  // terminal of VS Code; without a selection it stops the command.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "f") {
      openSearch(view);
      return false;
    }
    if ((event.ctrlKey || event.metaKey) && key === "c" && term.hasSelection()) {
      event.preventDefault();
      void copyWithFeedback(view.screen, term.getSelection(), "Selection");
      term.clearSelection();
      return false;
    }
    return true;
  });
  // Paths such as src/login.ts:42:7 open the file at that line; addresses open in the browser.
  term.registerLinkProvider({
    provideLinks(line, callback) {
      const text = term.buffer.active.getLine(line - 1)?.translateToString(true) ?? "";
      const links = findLinks(text).map((link) => ({
        range: { start: { x: link.start + 1, y: line }, end: { x: link.start + link.text.length, y: line } },
        text: link.text,
        decorations: { underline: true, pointerCursor: true },
        activate: () => openLink(view, link.text),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  });
  // Typing goes to the running command.
  term.onData((data) => {
    if (view.finished === undefined || view.live) post({ type: "commandInput", id, data });
  });
  view.term = term;
  view.fit = fit;
  new ResizeObserver(() => resize(view)).observe(view.screen);
  order.push(id);
  // Old terminals turn into plain text.
  while (order.length > liveTerminals) {
    const oldId = order.shift();
    const old = oldId ? views.get(oldId) : undefined;
    if (old?.term && old.finished !== undefined) toText(old);
  }
}

/** The search field of a command: Enter finds the next match, Shift+Enter the previous one, Esc closes it. */
function openSearch(view: CommandView): void {
  view.root.classList.remove("collapsed");
  if (!view.searchBox) {
    const box = el("input", "term-search");
    box.type = "search";
    box.placeholder = "Find in output";
    box.setAttribute("aria-label", "Find in the output of this command");
    const find = (backwards: boolean) => {
      if (!box.value || !view.search) return;
      const found = backwards ? view.search.findPrevious(box.value) : view.search.findNext(box.value);
      box.classList.toggle("missing", !found);
    };
    box.addEventListener("input", () => find(false));
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        find(event.shiftKey);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        box.hidden = true;
        view.term?.clearSelection();
        view.term?.focus();
      }
    });
    view.meta.before(box);
    view.searchBox = box;
  }
  view.searchBox.hidden = false;
  view.searchBox.focus();
  view.searchBox.select();
}

/** Opens a link from the output: an address in the browser, a path in the editor at its line and column. */
function openLink(view: CommandView, text: string): void {
  if (/^https?:\/\//i.test(text)) {
    // The webview opens a clicked link outside, after VS Code asks the user.
    const anchor = document.createElement("a");
    anchor.href = text;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.click();
    return;
  }
  const target = parseFileLink(text);
  if (!target) return;
  view.post({
    type: "openFile",
    path: target.path,
    ...(target.line ? { line: target.line } : {}),
    ...(target.column ? { column: target.column } : {}),
    terminal: view.meta.dataset.terminal ?? "1",
  });
}

function toText(view: CommandView): void {
  view.term?.dispose();
  view.term = undefined;
  view.fit = undefined;
  const text = view.text.replace(/\s+$/, "");
  const lines = text ? text.split("\n") : [];
  // Like the terminal: the end of a long output, and one click shows all of it.
  const cut = lines.length > view.rows && view.rows < expandedRows;
  const pre = el("pre", "term-text", cut ? lines.slice(-view.rows).join("\n") : text);
  view.screen.replaceChildren(pre);
  view.more.hidden = !cut;
  if (cut)
    view.more.textContent = `Show all ${lines.length.toLocaleString("en-US")} lines (${(lines.length - view.rows).toLocaleString("en-US")} above)`;
  view.screen.hidden = !view.text.trim();
}

/** The line along the top of the box beats with the output, so a silent command looks silent. */
function beat(view: CommandView): void {
  const now = Date.now();
  if (now - view.lastBeat < 180) return;
  view.lastBeat = now;
  view.body.classList.remove("beat");
  void view.body.offsetWidth;
  view.body.classList.add("beat");
}

function write(view: CommandView, text: string): void {
  if (view.finished === undefined || view.live) beat(view);
  view.text += plain(text);
  if (view.text.length > 200_000) view.text = view.text.slice(-200_000);
  if (view.term) view.term.write(text, () => resize(view));
}

function tick(): void {
  let running = false;
  for (const [id, view] of views) {
    if (!view.root.isConnected) {
      view.term?.dispose();
      views.delete(id);
    } else if (view.finished === undefined) {
      running = true;
      renderStatus(view);
    }
  }
  if (!running && ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

function renderActions(view: CommandView, id: string, command: string, post: (message: WebviewMessage) => void): void {
  const buttons: HTMLButtonElement[] = [];
  const action = (name: string, title: string, onClick: (button: HTMLButtonElement) => void) => {
    const button = el("button", "term-action");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.append(iconNode(name));
    button.addEventListener("click", () => onClick(button));
    buttons.push(button);
  };
  if (!view.result) action("stop", "Stop (Ctrl+C)", () => post({ type: "stopCommand", id }));
  if (view.where === "terminal") action("terminal", "Show in the terminal", () => post({ type: "showTerminal" }));
  if (view.term) action("search", "Find in the output (Ctrl+F)", () => openSearch(view));
  // Run it again in a terminal where nothing runs; the new run shows as a new command.
  if (view.result && !view.live && view.where === "terminal")
    action("restore", "Run again", () => post({ type: "rerunCommand", id }));
  action(
    "copy",
    "Copy the command and its output",
    (button) => void copyWithFeedback(button, `$ ${command}\n${view.text.trim()}`.trim(), "Command"),
  );
  view.actions.replaceChildren(...buttons);
}

/** Creates or updates the view of a command: one line, the command, and its terminal. */
export function renderCommandTerminal(
  id: string,
  update: {
    command: string;
    description?: string;
    where?: "terminal" | "background";
    approval?: string;
    terminal?: string;
    status: "running" | "done" | "error";
    detail?: string;
    at?: number;
  },
  post: (message: WebviewMessage) => void,
): HTMLElement {
  let view = views.get(id);
  if (!view) {
    const root = el("div", "term");
    const head = el("div", "term-head");
    const toggle = el("button", "term-toggle");
    toggle.type = "button";
    const chevron = iconNode("chevron");
    chevron.classList.add("term-chevron");
    const face = mascot("idle", look);
    face.classList.add("term-mascot");
    const state = el("span", "term-state");
    state.setAttribute("aria-hidden", "true");
    const verb = el("span", "term-verb");
    const title = el("span", "term-title");
    const commandLine = el("code", "term-line");
    const peek = el("code", "term-peek");
    toggle.append(chevron, face, state, verb, title, commandLine, peek);
    const actions = el("span", "term-actions");
    const summary = el("span", "term-summary");
    // A failed command: one click asks the assistant to find the cause and fix it.
    const fix = el("button", "term-fix");
    fix.type = "button";
    fix.hidden = true;
    fix.append(iconNode("bug"), el("span", undefined, "Phew it!"));
    fix.title = "Find the cause of this failure and fix it";
    fix.addEventListener("click", () => {
      fix.disabled = true;
      post({ type: "fixCommand", id });
    });
    head.append(toggle, summary, fix);
    const body = el("div", "term-body");
    // The command at the top of the terminal box, with its buttons on the right.
    const top = el("div", "term-top");
    const full = el("pre", "term-full");
    // Which terminal runs it and why it ran without asking, quiet on the right.
    const meta = el("span", "term-meta");
    top.append(full, meta, actions);
    const screen = el("div", "term-screen");
    const hint = el("div", "term-hint");
    hint.hidden = true;
    const more = el("button", "term-more");
    more.type = "button";
    more.hidden = true;
    // Your turn: an answer field under a program that waits for input; the key hides what you type.
    const answer = el("form", "term-answer");
    answer.hidden = true;
    const answerInput = el("input", "term-answer-input");
    answerInput.type = "text";
    answerInput.placeholder = "Your answer…";
    answerInput.setAttribute("aria-label", "Answer for the command");
    answerInput.autocomplete = "off";
    answerInput.spellcheck = false;
    const secret = el("button", "term-action term-secret");
    secret.type = "button";
    secret.title = "Hide what I type (for passwords)";
    secret.setAttribute("aria-pressed", "false");
    secret.append(iconNode("lock"));
    secret.addEventListener("click", () => {
      const hidden = answerInput.type === "text";
      answerInput.type = hidden ? "password" : "text";
      secret.setAttribute("aria-pressed", String(hidden));
      secret.classList.toggle("on", hidden);
      answerInput.focus();
    });
    const send = el("button", "term-answer-send", "Send");
    send.type = "submit";
    answer.append(el("span", "term-answer-label", "Your turn"), answerInput, secret, send);
    answer.addEventListener("submit", (event) => {
      event.preventDefault();
      post({ type: "commandInput", id, data: `${answerInput.value}\r` });
      answerInput.value = "";
    });
    body.append(top, screen, more, hint, answer);
    root.append(head, body);
    const created: CommandView = {
      root,
      face,
      title,
      summary,
      fix,
      body,
      answer,
      answerInput,
      lastBeat: 0,
      verb,
      commandLine,
      full,
      actions,
      meta,
      screen,
      hint,
      peek,
      state,
      more,
      touched: false,
      rows: maximumRows,
      text: "",
      started: update.at ?? Date.now(),
      lastOutput: update.at ?? Date.now(),
      live: false,
      renderActions: () => undefined,
      post,
    };
    more.addEventListener("click", () => {
      created.rows = expandedRows;
      created.touched = true;
      if (created.term) resize(created);
      else toText(created);
    });
    toggle.addEventListener("click", () => {
      created.touched = true;
      root.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!root.classList.contains("collapsed")));
      if (!root.classList.contains("collapsed")) requestAnimationFrame(() => resize(created));
    });
    hint.addEventListener("click", () => created.term?.focus());
    views.set(id, created);
    view = created;
  }
  const current = view;
  current.description = update.description;
  const firstLine = update.command.split("\n")[0] ?? "";
  // Plain words first, when the assistant says what the command does; the command is in the box below.
  current.title.textContent = update.description ?? "";
  current.title.hidden = !update.description;
  current.commandLine.textContent = firstLine;
  current.commandLine.hidden = Boolean(update.description);
  // The command shows in full at the top of the box, with colors.
  if (current.full.dataset.command !== update.command) {
    current.full.dataset.command = update.command;
    current.full.replaceChildren(highlightCommand(update.command));
  }
  if (update.where) {
    current.where = update.where;
    current.root.dataset.where = update.where;
  }
  renderMeta(current, update.terminal, update.approval);

  if (update.status === "running") {
    ticker ??= setInterval(tick, 1000);
    // The terminal opens once the view is in the chat, so xterm can measure it.
    requestAnimationFrame(() => {
      if (!current.term && current.finished === undefined && current.root.isConnected)
        createTerminal(current, id, post);
    });
  } else {
    current.finished ??= update.at ?? Date.now();
    const parsed = parseCommandResult(update.detail ?? "");
    // A command that arrives finished (a chat that opens again) has no live output and no colors: its
    // result shows as text, without a terminal, so a long chat opens fast.
    // A terminal that is open already (the output came only with the result) shows it there.
    if (!current.text.trim() && parsed.output.trim()) {
      if (current.term) write(current, parsed.output.replace(/\r?\n/g, "\r\n"));
      else current.text = parsed.output;
    }
    const status = parsed.status ?? "";
    current.live =
      status === "waiting for input" ||
      status === "running in the background" ||
      status === "running in watch mode" ||
      status.startsWith("still running");
    if (update.status === "error" && !status)
      current.result = { label: (update.detail ?? "Failed").replace(/^Error:\s*/, "").slice(0, 80), tone: "error" };
    else if (parsed.exitCode === 0) current.result = { label: "Ran", tone: "ok" };
    else if (parsed.exitCode !== undefined)
      current.result = { label: `Failed · exit ${parsed.exitCode}`, tone: "error" };
    else if (status === "waiting for input") current.result = { label: "Waiting for input", tone: "waiting" };
    else if (status === "running in the background")
      current.result = { label: "Running in the background", tone: "waiting" };
    else if (status === "running in watch mode") current.result = { label: "Watching for changes", tone: "waiting" };
    else if (status.startsWith("still running")) current.result = { label: "Still running", tone: "waiting" };
    else if (status === "cancelled") current.result = { label: "Stopped", tone: "muted" };
    else if (status.startsWith("timed out")) current.result = { label: "Timed out", tone: "error" };
    else if (/did not allow/.test(update.detail ?? "")) current.result = { label: "Denied", tone: "muted" };
    else current.result = { label: status ? status[0]?.toUpperCase() + status.slice(1) : "Ran", tone: "muted" };
    current.hint.hidden = status !== "waiting for input";
    fold(current, update.command, update.at);
    if (current.term && !current.live) {
      current.term.options.cursorBlink = false;
      current.term.options.disableStdin = true;
      current.term.write("\x1b[?25l", () => resize(current));
    } else if (!current.term) toText(current);
  }
  current.root.dataset.status = current.result?.tone ?? "running";
  current.renderActions = () => renderActions(current, id, update.command, post);
  current.renderActions();
  renderStatus(current);
  return current.root;
}

/**
 * A finished command settles: the mascot gives way to a check or a cross, and a short result folds into
 * one line ("Print the folder  /home/agent"), so a chat of small commands stays calm. Long or failed output
 * stays open. A command that the user opened or closed keeps its state.
 */
function fold(view: CommandView, command: string, at: number | undefined): void {
  const tone = view.result?.tone;
  const finishedLongAgo = at !== undefined && Date.now() - at > 5000;
  if (view.settle === undefined && (tone === "ok" || tone === "error" || tone === "muted")) {
    view.settle = setTimeout(() => view.root.classList.add("settled"), finishedLongAgo ? 0 : 2500);
  }
  const output = view.text.replace(/\s+$/, "");
  const lines = output ? output.split("\n").length : 0;
  const short =
    tone === "ok" &&
    !view.live &&
    lines <= compactLines &&
    output.length <= compactChars &&
    !command.includes("\n") &&
    command.length <= 120;
  view.peek.textContent = short ? output.replace(/\s*\n\s*/g, "  ") : "";
  view.peek.hidden = !short || !output;
  view.root.classList.toggle("compact", short);
  if (short && !view.touched) {
    view.root.classList.add("collapsed");
    view.root.querySelector(".term-toggle")?.setAttribute("aria-expanded", "false");
  }
}

/** Marks where a running command runs, which terminal, and why it ran without asking. */
export function setCommandWhere(
  id: string,
  where: "terminal" | "background",
  details: { approval?: string; terminal?: string } = {},
): void {
  const view = views.get(id);
  if (!view) return;
  view.where = where;
  view.root.dataset.where = where;
  renderMeta(view, details.terminal, details.approval);
  view.renderActions();
}

function renderMeta(view: CommandView, terminal: string | undefined, approval: string | undefined): void {
  if (terminal) view.meta.dataset.terminal = terminal;
  if (approval) view.meta.dataset.approval = approval;
  const parts: string[] = [];
  const shownTerminal = view.meta.dataset.terminal;
  if (shownTerminal && shownTerminal !== "1") parts.push(`Terminal ${shownTerminal}`);
  const why = view.meta.dataset.approval;
  if (why?.startsWith("Auto-approved: ")) parts.push(`auto: ${why.slice("Auto-approved: ".length)}`);
  else if (why?.startsWith("Always allowed")) parts.push("always allowed");
  view.meta.textContent = parts.join(" · ");
  view.meta.title = [shownTerminal ? `Runs in terminal ${shownTerminal} of this chat.` : "", why ? `${why}.` : ""]
    .filter(Boolean)
    .join(" ");
  view.meta.hidden = parts.length === 0;
}

/** Adds live output (with colors) to a running command. */
export function appendCommandOutput(id: string, text: string): boolean {
  const view = views.get(id);
  // A program that keeps running (ssh, a server) keeps showing what happens in the terminal.
  if (!view || (view.finished !== undefined && !view.live) || !text) return false;
  if (!view.term && view.root.isConnected) createTerminal(view, id, view.post);
  view.lastOutput = Date.now();
  write(view, text);
  return true;
}
