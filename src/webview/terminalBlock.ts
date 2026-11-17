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
/** A command in the terminal that is quiet this long may wait for an answer. */
const quietMs = 8000;
/** Older terminals become plain text, so a long chat stays light. */
const liveTerminals = 12;

interface CommandView {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  readonly command: HTMLElement;
  readonly status: HTMLElement;
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
  result?: { label: string; tone: "ok" | "error" | "muted" };
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
  if (view.result) {
    view.status.dataset.tone = view.result.tone;
    const time = view.finished !== undefined ? ` · ${seconds(view.finished - view.started)}` : "";
    view.status.textContent = `${view.result.label}${time}`;
  } else {
    view.status.dataset.tone = "running";
    view.status.textContent = seconds(Date.now() - view.started);
  }
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
    if (view.finished === undefined) post({ type: "commandInput", id, data });
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
      view.hint.hidden = Date.now() - view.lastOutput < quietMs;
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
  if (!view.result) action("stop", "Stop this command (Ctrl+C)", () => post({ type: "stopCommand", id }));
  if (view.where === "terminal")
    action("terminal", "Show it in the terminal panel", () => post({ type: "showTerminal" }));
  action(
    "copy",
    "Copy the command and its output",
    (button) => void copyWithFeedback(button, `$ ${command}\n${view.text.trim()}`.trim(), "Command"),
  );
  view.actions.replaceChildren(...buttons);
}

/** Creates or updates the view of a command. */
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
    const title = el("span", "term-title");
    const status = el("span", "term-status");
    const actions = el("span", "term-actions");
    head.append(el("span", "term-dot"), title, status, actions);
    const command = el("code", "term-command");
    const screen = el("div", "term-screen");
    const hint = el("div", "term-hint");
    hint.hidden = true;
    const hintButton = el("button", "link", "Type the answer here");
    hintButton.type = "button";
    hint.append(el("span", undefined, "No output for a while. Does it wait for an answer?"), hintButton);
    root.append(head, command, screen, hint);
    const created: CommandView = {
      root,
      title,
      command,
      status,
      actions,
      screen,
      hint,
      text: "",
      started: update.at ?? Date.now(),
      lastOutput: update.at ?? Date.now(),
      renderActions: () => undefined,
      post,
    };
    hintButton.addEventListener("click", () => created.term?.focus());
    views.set(id, created);
    view = created;
  }
  const current = view;
  current.title.textContent = update.description || update.command;
  current.command.textContent = `$ ${update.command}`;
  current.command.hidden = !update.description;
  current.root.title = update.command;
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
    current.hint.hidden = true;
    const parsed = parseCommandResult(update.detail ?? "");
    // A chat that opens later has no live output: the result fills the terminal.
    if (!current.text.trim() && parsed.output.trim()) {
      if (!current.term && current.root.isConnected) createTerminal(current, id, post);
      write(current, parsed.output.replace(/\r?\n/g, "\r\n"));
      if (!current.term) current.text = parsed.output;
    }
    if (update.status === "error" && parsed.status === undefined)
      current.result = { label: (update.detail ?? "Failed").replace(/^Error:\s*/, "").slice(0, 80), tone: "error" };
    else if (parsed.exitCode === 0) current.result = { label: "Done", tone: "ok" };
    else if (parsed.exitCode !== undefined) current.result = { label: `Exit ${parsed.exitCode}`, tone: "error" };
    else if (parsed.status === "cancelled") current.result = { label: "Stopped", tone: "muted" };
    else if (parsed.status === "timed out") current.result = { label: "Timed out", tone: "error" };
    else if (/did not allow/.test(update.detail ?? "")) current.result = { label: "Denied", tone: "muted" };
    else current.result = { label: parsed.status ?? "Finished", tone: "muted" };
    if (current.term) {
      current.term.options.cursorBlink = false;
      current.term.options.disableStdin = true;
      current.term.write("\x1b[?25l", () => resize(current));
    } else if (!current.root.isConnected) {
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
  view.hint.hidden = true;
  write(view, text);
  return true;
}
