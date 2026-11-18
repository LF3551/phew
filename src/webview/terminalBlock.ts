import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { parseCommandResult } from "../core/commandResult";
import { icon } from "../shared/icons";
import type { WebviewMessage } from "../shared/protocol";
import { copyWithFeedback } from "./copy";

/**
 * A command in the chat, like the terminal of the Copilot agent: a real terminal (xterm.js) inside the
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
/** Older terminals become plain text, so a long chat stays light. */
const liveTerminals = 12;

interface CommandView {
  readonly root: HTMLElement;
  readonly verb: HTMLElement;
  readonly commandLine: HTMLElement;
  readonly full: HTMLElement;
  readonly actions: HTMLElement;
  readonly screen: HTMLElement;
  readonly hint: HTMLElement;
  term?: Terminal;
  fit?: FitAddon;
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

/** The colors of the VS Code terminal theme, so the chat terminal looks like the one in the panel. */
function terminalTheme(): ITheme {
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
  const time = seconds((view.finished ?? Date.now()) - view.started);
  view.verb.textContent = view.result ? view.result.label : "Running";
  view.root.dataset.tone = view.result?.tone ?? "running";
  view.root.title = [view.description, view.result ? `${view.result.label} after ${time}` : `Running for ${time}`]
    .filter(Boolean)
    .join(" · ");
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
  const rows = Math.max(1, Math.min(maximumRows, used));
  if (cols && (cols !== term.cols || rows !== term.rows)) term.resize(Math.max(20, cols), rows);
  else if (rows !== term.rows) term.resize(term.cols, rows);
  // All output fits: show it from the top. Longer output follows the newest lines.
  if (used <= maximumRows) term.scrollToTop();
  else term.scrollToBottom();
  view.screen.hidden = used <= 1 && !buffer.getLine(0)?.translateToString(true).trim() && view.finished !== undefined;
}

function createTerminal(view: CommandView, id: string, post: (message: WebviewMessage) => void): void {
  const style = getComputedStyle(document.body);
  const term = new Terminal({
    rows: maximumRows,
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
  term.open(view.screen);
  // Typing goes to the running command, like in the terminal of the Copilot agent.
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

function toText(view: CommandView): void {
  view.term?.dispose();
  view.term = undefined;
  view.fit = undefined;
  const pre = el("pre", "term-text", view.text.replace(/\s+$/, ""));
  view.screen.replaceChildren(pre);
  view.screen.hidden = !view.text.trim();
}

function write(view: CommandView, text: string): void {
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
  action(
    "copy",
    "Copy the command and its output",
    (button) => void copyWithFeedback(button, `$ ${command}\n${view.text.trim()}`.trim(), "Command"),
  );
  view.actions.replaceChildren(...buttons);
}

/** Creates or updates the view of a command: one line like the Copilot agent, the command, and its terminal. */
export function renderCommandTerminal(
  id: string,
  update: {
    command: string;
    description?: string;
    where?: "terminal" | "background";
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
    const verb = el("span", "term-verb");
    const commandLine = el("code", "term-line");
    toggle.append(chevron, verb, commandLine);
    const actions = el("span", "term-actions");
    head.append(toggle, actions);
    const body = el("div", "term-body");
    const full = el("pre", "term-full");
    const screen = el("div", "term-screen");
    const hint = el("div", "term-hint", "Waiting for input. Type here or in the terminal.");
    hint.hidden = true;
    body.append(full, screen, hint);
    root.append(head, body);
    const created: CommandView = {
      root,
      verb,
      commandLine,
      full,
      actions,
      screen,
      hint,
      text: "",
      started: update.at ?? Date.now(),
      lastOutput: update.at ?? Date.now(),
      live: false,
      renderActions: () => undefined,
      post,
    };
    toggle.addEventListener("click", () => {
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
  current.commandLine.textContent = firstLine;
  // A long or multi-line command shows in full under the line, with colors.
  const long = update.command.includes("\n") || update.command.length > 70;
  current.full.hidden = !long;
  if (long && current.full.dataset.command !== update.command) {
    current.full.dataset.command = update.command;
    current.full.replaceChildren(highlightCommand(update.command));
  }
  if (update.where) {
    current.where = update.where;
    current.root.dataset.where = update.where;
  }

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
    // A chat that opens later has no live output: the result fills the terminal.
    if (!current.text.trim() && parsed.output.trim()) {
      if (!current.term && current.root.isConnected) createTerminal(current, id, post);
      write(current, parsed.output.replace(/\r?\n/g, "\r\n"));
      if (!current.term) current.text = parsed.output;
    }
    const status = parsed.status ?? "";
    current.live = status === "waiting for input" || status === "running in the background";
    if (update.status === "error" && !status)
      current.result = { label: (update.detail ?? "Failed").replace(/^Error:\s*/, "").slice(0, 80), tone: "error" };
    else if (parsed.exitCode === 0) current.result = { label: "Ran", tone: "ok" };
    else if (parsed.exitCode !== undefined)
      current.result = { label: `Failed · exit ${parsed.exitCode}`, tone: "error" };
    else if (status === "waiting for input") current.result = { label: "Waiting for input", tone: "waiting" };
    else if (status === "running in the background")
      current.result = { label: "Running in the background", tone: "waiting" };
    else if (status === "cancelled") current.result = { label: "Stopped", tone: "muted" };
    else if (status.startsWith("timed out")) current.result = { label: "Timed out", tone: "error" };
    else if (/did not allow/.test(update.detail ?? "")) current.result = { label: "Denied", tone: "muted" };
    else current.result = { label: status ? status[0]?.toUpperCase() + status.slice(1) : "Ran", tone: "muted" };
    current.hint.hidden = status !== "waiting for input";
    // A command that worked folds into its line; failures and waiting programs stay open.
    if (current.result.tone === "ok") current.root.classList.add("collapsed");
    if (current.term && !current.live) {
      current.term.options.cursorBlink = false;
      current.term.options.disableStdin = true;
      current.term.write("\x1b[?25l", () => resize(current));
    } else if (!current.term && !current.root.isConnected) {
      // The view is not in the chat yet; it shows the text when it arrives.
      requestAnimationFrame(() => {
        if (!current.term && current.text.trim()) {
          createTerminal(current, id, post);
          const term = (current as { term?: Terminal }).term;
          term?.write(`${current.text.replace(/\r?\n/g, "\r\n")}\x1b[?25l`, () => resize(current));
        } else resize(current);
      });
    }
  }
  current.root.dataset.status = current.result?.tone ?? "running";
  current.renderActions = () => renderActions(current, id, update.command, post);
  current.renderActions();
  renderStatus(current);
  return current.root;
}

/** Marks where a running command runs; a command in the terminal panel can be shown there. */
export function setCommandWhere(id: string, where: "terminal" | "background"): void {
  const view = views.get(id);
  if (!view) return;
  view.where = where;
  view.root.dataset.where = where;
  view.renderActions();
}

/** Adds live output (with colors) to a running command. */
export function appendCommandOutput(id: string, text: string): boolean {
  const view = views.get(id);
  if (!view || view.finished !== undefined || !text) return false;
  if (!view.term && view.root.isConnected) createTerminal(view, id, view.post);
  view.lastOutput = Date.now();
  write(view, text);
  return true;
}
