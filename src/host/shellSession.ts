import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as vscode from "vscode";
import { OutputKeeper } from "../core/outputLimit";
import { lastLine, looksLikePrompt, plainTerminalText, type ShellMark, ShellMarkParser } from "../core/shellMarks";
import { type ShellLaunch, shellLaunch, userShell } from "./shellScripts";

/**
 * The shell of a chat: a real terminal (a PTY from node-pty)
 * with the user's own shell, shown in the terminal panel. The agent types its commands into it, the user
 * sees them live and can type too: answer a prompt, press Ctrl+C, or run own commands. The session stays,
 * so `cd`, variables, and `ssh` into another machine carry over to the next command.
 */

interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): Pty;
}

let ptyModule: PtyModule | undefined;
let ptyError: string | undefined;

/** Loads node-pty from dist/pty. Undefined when this platform has no binary; then commands run in processes. */
export function loadPty(extensionPath: string): PtyModule | undefined {
  if (ptyModule || ptyError) return ptyModule;
  try {
    const base = path.join(extensionPath, "dist", "pty");
    // macOS starts shells through a helper that must be executable; a VSIX does not keep file modes.
    const helper = path.join(
      base,
      "node_modules",
      "@lydell",
      `node-pty-${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (existsSync(helper)) chmodSync(helper, 0o755);
    ptyModule = createRequire(path.join(base, "loader.js"))("@lydell/node-pty") as PtyModule;
  } catch (error) {
    ptyError = error instanceof Error ? error.message : String(error);
  }
  return ptyModule;
}

export function ptyLoadError(): string | undefined {
  return ptyError;
}

export type ShellState = "done" | "waiting" | "running" | "timeout" | "stopped" | "closed" | "busy";

export interface ShellResult {
  readonly state: ShellState;
  /** The output without the echo of the command and without escape codes. */
  readonly output: string;
  /** Known when the shell printed its prompt after the command. */
  readonly exitCode?: number;
  /** The folder of the shell after the command. */
  readonly cwd?: string;
  /** The last line, for a command that waits for input. */
  readonly prompt?: string;
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Output for the chat as it arrives, with colors, without the echo of the command. */
  readonly onOutput: (text: string) => void;
  /** For servers and watchers: return after a few seconds and leave it running. */
  readonly background?: boolean;
}

const defaultCols = 110;
const defaultRows = 30;
/** How long a quiet program must be before Phew decides that it waits for input. */
const quietForPromptMs = 2500;
const quietInsideProgramMs = 1200;
const backgroundSettleMs = 5000;
const replayLimit = 400_000;
const historyLimit = 200_000;

export class ShellSession implements vscode.Disposable {
  private pty: Pty | undefined;
  private launch: ShellLaunch | undefined;
  private terminal: vscode.Terminal | undefined;
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<number | undefined>();
  private opened = false;
  private replay = "";
  private cols = defaultCols;
  private rows = defaultRows;
  private parser = new ShellMarkParser();
  /** A command runs in the foreground: the prompt has not come back yet. */
  private busy = false;
  /** The agent started the program in the foreground, so it may type into it (an answer, or a command in ssh). */
  private agentOwnsForeground = false;
  private ready: Promise<void> | undefined;
  private listeners = new Set<(piece: { text?: string; mark?: ShellMark }) => void>();
  /** Readers that wait for a prompt or an end, without taking the output from the unread buffer. */
  private readonly watchers = new Set<(piece: { text?: string; mark?: ShellMark }) => void>();
  private revealed = false;
  private readonly disposables: vscode.Disposable[] = [this.writer, this.closer];
  /**
   * A program that the agent left running (ssh, a server, a prompt) keeps showing in its view in the chat,
   * so everything that happens in the terminal goes there, until the
   * program ends or the next command starts.
   */
  private tail: ((text: string) => void) | undefined;
  /** After Ctrl+C the shell prints a prompt later; the next command waits for it, so it does not take it as its own. */
  private settling: Promise<void> | undefined;
  /** The folder of the shell, from its last prompt. */
  cwd: string | undefined;

  /** Output that came while no command of the agent waited for it (a server, a program in the background). */
  private unread = new OutputKeeper(4_000, 40_000);
  private unreadPlainTail = "";
  /** The last screens of the terminal, for "attach the output of a terminal". */
  private history = "";
  /** The text of the prompt after the last mark, to notice a prompt that came back without its mark. */
  private lastPromptText = "";
  private promptCapture: string | undefined;
  /** Whether the shell loads the user's startup files, and the environment that marks commands of the agent. */
  loadStartupFiles: () => boolean = () => true;
  /** The number of the terminal in its chat, for PHEW_TERMINAL. */
  terminalId = "1";
  /** A server or watcher that the agent started in the background runs here; other commands go elsewhere. */
  get hostsBackgroundJob(): boolean {
    return this.backgroundJob && this.busy;
  }
  private backgroundJob = false;
  /** The folder of the extension, for the icon of the terminal. */
  extensionRoot = "";
  /** " (2)" for the second terminal of a chat. */
  nameSuffix = "";
  /** The last command that the agent ran, for the list of terminals. */
  private lastCommand: string | undefined;

  constructor(
    private readonly pty$: PtyModule,
    private readonly title: () => string,
    private readonly startFolder: () => string,
    private readonly shellPath: () => string | undefined,
    /** Called when the state for the list of terminals changes. */
    private readonly onChange: () => void = () => undefined,
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) this.reset();
      }),
    );
  }

  /** The terminals of Phew, so the terminal watcher does not offer to fix the agent's own commands. */
  static isAgentTerminal(terminal: vscode.Terminal): boolean {
    return terminal.name.startsWith("Phew · ") || terminal.name.startsWith("Phew:");
  }

  get started(): boolean {
    return this.pty !== undefined;
  }

  /** What the list of terminals in the chat shows. */
  get info(): {
    pid?: number;
    shell: string;
    cwd?: string;
    state: "idle" | "running" | "waiting" | "stopped";
    command?: string;
  } {
    const shell = this.launch ? path.basename(this.launch.file).replace(/\.exe$/i, "") : "";
    if (!this.pty) return { shell, cwd: this.cwd, state: "stopped" };
    const state = !this.busy
      ? "idle"
      : this.agentOwnsForeground && this.tail && !this.backgroundJob
        ? "waiting"
        : "running";
    return {
      pid: this.pty.pid,
      shell,
      cwd: this.cwd,
      state,
      ...(this.busy && this.lastCommand ? { command: this.lastCommand } : {}),
    };
  }

  /** Remembers how the prompt looks, from the text right after the prompt mark. */
  private capturePrompt(): void {
    this.promptCapture = "";
    setTimeout(() => this.endPromptCapture(), 250);
  }

  /** Ends the capture: after a moment, or when the agent starts to type, so its command is not in it. */
  private endPromptCapture(): void {
    if (this.promptCapture === undefined) return;
    const line = lastLine(this.promptCapture).trim();
    if (line) this.lastPromptText = line;
    this.promptCapture = undefined;
  }

  /** The last lines of the terminal as plain text, for an attachment. */
  recentOutput(lines = 200): string {
    return plainTerminalText(this.history).split("\n").slice(-lines).join("\n").trim();
  }

  /**
   * New output of a program that keeps running (a server, a watcher), since the last read. With a pattern,
   * waits until the new output matches it, the program ends, or the time is up.
   */
  async readNew(options: { pattern?: RegExp; timeoutMs: number; signal: AbortSignal }): Promise<{
    output: string;
    matched: boolean;
    state: "running" | "waiting" | "ended" | "idle" | "closed";
    exitCode?: number;
  }> {
    const take = () => {
      const output = plainTerminalText(this.unread.text()).replace(/^\n+/, "").replace(/\s+$/, "");
      this.unread = new OutputKeeper(4_000, 40_000);
      this.unreadPlainTail = "";
      return output;
    };
    const stateNow = () =>
      !this.pty
        ? "closed"
        : !this.busy
          ? "idle"
          : this.agentOwnsForeground && this.tail && !this.backgroundJob
            ? "waiting"
            : "running";
    const matches = () => options.pattern?.test(plainTerminalText(this.unreadPlainTail)) ?? false;
    if (!this.pty || !this.busy || !options.pattern || matches()) {
      const state = stateNow();
      const matched = matches();
      return { output: take(), matched, state };
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (state: "running" | "waiting" | "ended" | "closed", matched: boolean, exitCode?: number) => {
        if (done) return;
        done = true;
        this.watchers.delete(listener);
        clearTimeout(timer);
        clearInterval(poll);
        options.signal.removeEventListener("abort", onAbort);
        resolve({ output: take(), matched, state, exitCode });
      };
      const listener = (piece: { text?: string; mark?: ShellMark }) => {
        if (piece.text === "\u0000closed") finish("closed", false);
        else if (piece.mark?.kind === "prompt") finish("ended", matches(), piece.mark.exitCode);
      };
      // Text arrives through the unread buffer, because no command waits; a short poll checks the pattern.
      const poll = setInterval(() => {
        if (matches()) finish(stateNow() === "waiting" ? "waiting" : "running", true);
      }, 150);
      const timer = setTimeout(
        () => finish(stateNow() === "waiting" ? "waiting" : "running", false),
        options.timeoutMs,
      );
      const onAbort = () => finish("running", false);
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.watchers.add(listener);
    });
  }

  /** Ends the shell and closes its terminal; the next command starts a new one. */
  kill(): void {
    const terminal = this.terminal;
    if (this.pty) killTree(this.pty.pid);
    this.reset();
    terminal?.dispose();
    this.onChange();
  }

  private reset(): void {
    this.terminal = undefined;
    this.opened = false;
    this.revealed = false;
    const pty = this.pty;
    this.pty = undefined;
    this.ready = undefined;
    this.busy = false;
    this.agentOwnsForeground = false;
    this.parser = new ShellMarkParser();
    try {
      pty?.kill();
    } catch {
      // It already exited.
    }
    for (const listener of this.listeners) listener({ text: "\u0000closed" });
    for (const watcher of this.watchers) watcher({ text: "\u0000closed" });
  }

  private ensureTerminal(): vscode.Terminal {
    if (this.terminal) return this.terminal;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writer.event,
      onDidClose: this.closer.event,
      open: (dimensions) => {
        this.opened = true;
        if (dimensions) this.resize(dimensions.columns, dimensions.rows);
        if (this.replay) this.writer.fire(this.replay);
        this.replay = "";
      },
      close: () => this.reset(),
      handleInput: (data) => this.userInput(data),
      setDimensions: (dimensions) => this.resize(dimensions.columns, dimensions.rows),
    };
    this.terminal = vscode.window.createTerminal({
      name: `Phew · ${this.title()}`.slice(0, 44) + this.nameSuffix,
      pty,
      // The drop of Phew in the cyan of its logo, so the agent's terminals stand out from the user's own.
      iconPath: this.extensionRoot
        ? {
            light: vscode.Uri.joinPath(vscode.Uri.file(this.extensionRoot), "resources", "phew.svg"),
            dark: vscode.Uri.joinPath(vscode.Uri.file(this.extensionRoot), "resources", "phew-dark.svg"),
          }
        : new vscode.ThemeIcon("sparkle"),
      color: new vscode.ThemeColor("terminal.ansiCyan"),
      isTransient: true,
    });
    return this.terminal;
  }

  private resize(cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty?.resize(cols, rows);
    } catch {
      // The shell exited.
    }
  }

  private show(text: string): void {
    if (this.opened) this.writer.fire(text);
    else {
      this.replay += text;
      if (this.replay.length > replayLimit) this.replay = this.replay.slice(-replayLimit);
    }
  }

  /** Starts the shell once; resolves at its first prompt, or soon for shells without marks. */
  private start(): Promise<void> {
    if (this.ready && this.pty) return this.ready;
    this.ensureTerminal();
    const launch = shellLaunch(userShell(this.shellPath()), this.loadStartupFiles());
    this.launch = launch;
    const cwd = this.cwd && existsSync(this.cwd) ? this.cwd : this.startFolder();
    const pty = this.pty$.spawn(launch.file, launch.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      // PHEW_AGENT tells scripts, Git hooks, and CLIs that an agent runs the command.
      env: {
        ...process.env,
        ...utf8Locale(),
        ...launch.env,
        COLORTERM: "truecolor",
        PHEW_AGENT: "1",
        PHEW_TERMINAL: this.terminalId,
      },
    });
    this.pty = pty;
    this.busy = true;
    this.onChange();
    pty.onData((data) => {
      if (this.pty !== pty) return;
      for (const piece of this.parser.push(data)) {
        if ("text" in piece) {
          this.show(piece.text);
          this.history = (this.history + piece.text).slice(-historyLimit);
          if (this.promptCapture !== undefined) this.promptCapture += piece.text;
          if (this.listeners.size === 0) {
            this.tail?.(piece.text);
            this.unread.push(piece.text);
            this.unreadPlainTail = (this.unreadPlainTail + piece.text).slice(-8_000);
          }
        } else if (piece.mark.kind === "prompt") {
          this.busy = false;
          this.agentOwnsForeground = false;
          this.backgroundJob = false;
          this.tail = undefined;
          if (piece.mark.cwd) this.cwd = piece.mark.cwd;
          this.capturePrompt();
          this.onChange();
        }
        for (const listener of this.listeners) listener(piece as { text?: string; mark?: ShellMark });
        for (const watcher of this.watchers) watcher(piece as { text?: string; mark?: ShellMark });
      }
    });
    pty.onExit(() => {
      if (this.pty !== pty) return;
      this.show("\r\n\x1b[2m[The shell ended. The next command starts a new one.]\x1b[0m\r\n");
      this.pty = undefined;
      this.ready = undefined;
      this.busy = false;
      for (const listener of this.listeners) listener({ text: "\u0000closed" });
      for (const watcher of this.watchers) watcher({ text: "\u0000closed" });
      this.onChange();
    });
    this.ready = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.listeners.delete(listener);
        this.busy = false;
        resolve();
      };
      const listener = (piece: { mark?: ShellMark }) => {
        if (piece.mark?.kind === "prompt") finish();
      };
      this.listeners.add(listener);
      // Shells without marks, or slow startup files: go on after a while.
      setTimeout(finish, launch.integrated ? 8000 : 1200);
    });
    return this.ready;
  }

  /** Keys from the user in the terminal panel or in the terminal inside the chat go straight to the shell. */
  userInput(data: string): void {
    if (!this.pty) {
      if (data === "\r") void this.start();
      return;
    }
    // Enter at an idle prompt starts the user's own command.
    if (!this.busy && /\r/.test(data)) {
      this.busy = true;
      this.agentOwnsForeground = false;
      this.lastCommand = undefined;
      this.onChange();
    }
    this.pty.write(data);
  }

  /** Shows the terminal panel; preserveFocus keeps the focus in the chat. */
  reveal(preserveFocus = false): void {
    this.ensureTerminal().show(preserveFocus);
    this.revealed = true;
  }

  interrupt(): void {
    if (!this.pty) return;
    this.pty.write("\u0003");
    this.settling = new Promise<void>((resolve) => {
      const done = () => {
        this.listeners.delete(listener);
        clearTimeout(timer);
        this.settling = undefined;
        resolve();
      };
      const listener = (piece: { text?: string; mark?: ShellMark }) => {
        if (piece.mark?.kind === "prompt" || piece.text === "\u0000closed") done();
      };
      this.listeners.add(listener);
      // A program that ignores Ctrl+C keeps the terminal; the agent then types into it.
      const timer = setTimeout(done, 3000);
    });
  }

  /** Runs a command of the agent in the shell, or types it into the program that the agent started. */
  async run(command: string, options: RunOptions & { reveal: boolean }): Promise<ShellResult> {
    await this.start();
    if (this.settling) await this.settling;
    const pty = this.pty;
    const launch = this.launch;
    if (!pty || !launch) return { state: "closed", output: "" };
    if (options.reveal && !this.revealed) this.reveal(true);
    if (this.busy && !this.agentOwnsForeground) {
      return { state: "busy", output: "", prompt: "" };
    }
    const insideProgram = this.busy;
    // The next command has its own view; the previous one stops following the terminal.
    this.tail = undefined;
    this.unread = new OutputKeeper(4_000, 40_000);
    this.unreadPlainTail = "";
    const echo = command.split("\n")[0]?.trim().slice(0, 40) ?? "";
    // Shells with marks say exactly where the output starts; elsewhere it starts after the echo of the command.
    const useStartMark = (launch.kind === "bash" || launch.kind === "zsh" || launch.kind === "fish") && !insideProgram;

    return new Promise<ShellResult>((resolve) => {
      // A command can print millions of lines: the result keeps the start and the end.
      const kept = new OutputKeeper();
      let recent = "";
      const take = (text: string) => {
        kept.push(text);
        recent = (recent + text).slice(-4000);
        options.onOutput(text);
      };
      let streaming = false;
      let sinceStart = "";
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;

      const finish = (result: Omit<ShellResult, "output"> & { output?: string }) => {
        if (finished) return;
        finished = true;
        this.listeners.delete(listener);
        clearTimeout(timeout);
        clearTimeout(quietTimer);
        clearTimeout(backgroundTimer);
        clearTimeout(echoTimer);
        options.signal.removeEventListener("abort", onAbort);
        const output = result.output ?? plainTerminalText(kept.text()).replace(/^\n+/, "").replace(/\s+$/, "");
        // The program keeps running: its view in the chat keeps following the terminal.
        if (result.state === "waiting" || result.state === "running") this.tail = options.onOutput;
        this.backgroundJob = result.state === "running" && options.background === true;
        this.onChange();
        resolve({ ...result, output });
      };

      // The output starts after the echo of the command: at the start mark, or after the first line break.
      const stream = (text: string) => {
        if (streaming) {
          take(text);
          return;
        }
        sinceStart += text;
        if (useStartMark) return;
        const plain = plainTerminalText(sinceStart);
        const breakAt = sinceStart.indexOf("\n");
        if (breakAt >= 0 && (!echo || plain.includes(echo) || plain.split("\n").length > 2)) {
          streaming = true;
          const rest = sinceStart.slice(breakAt + 1);
          sinceStart = "";
          if (rest) {
            take(rest);
          }
        }
      };

      const armQuiet = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(
          () => {
            const text = recent || sinceStart;
            // The shell's own prompt came back without its mark (a theme such as powerlevel10k can drop it):
            // the command is done, with an unknown exit code.
            if (!insideProgram && this.lastPromptText && lastLine(text).trim() === this.lastPromptText) {
              this.busy = false;
              this.agentOwnsForeground = false;
              finish({ state: "done" });
              return;
            }
            // A quiet program that shows a prompt or a question waits for input (ssh, a REPL, a password).
            // A server in the background only reports "running".
            if (!options.background && looksLikePrompt(text)) {
              this.agentOwnsForeground = true;
              finish({ state: "waiting", prompt: lastLine(text) });
            }
          },
          insideProgram ? quietInsideProgramMs : quietForPromptMs,
        );
      };

      const listener = (piece: { text?: string; mark?: ShellMark }) => {
        if (piece.text === "\u0000closed") {
          finish({ state: "closed" });
          return;
        }
        if (piece.mark?.kind === "start") {
          streaming = true;
          sinceStart = "";
          return;
        }
        if (piece.mark?.kind === "prompt") {
          finish({ state: "done", exitCode: piece.mark.exitCode, cwd: piece.mark.cwd || undefined });
          return;
        }
        if (piece.text) {
          stream(piece.text);
          armQuiet();
        }
      };
      this.listeners.add(listener);

      const timeout = setTimeout(() => {
        if (options.background) return;
        this.interrupt();
        finish({ state: "timeout" });
      }, options.timeoutMs);
      const backgroundTimer = options.background
        ? setTimeout(() => {
            this.agentOwnsForeground = true;
            finish({ state: "running" });
          }, backgroundSettleMs)
        : undefined;
      // Without a start mark and without a line break, the output still starts after a moment.
      const echoTimer = setTimeout(
        () => {
          if (!streaming && sinceStart) {
            streaming = true;
            const rest = sinceStart.includes(echo)
              ? sinceStart.slice(sinceStart.indexOf(echo) + echo.length)
              : sinceStart;
            sinceStart = "";
            if (rest) {
              take(rest);
            }
          } else streaming = true;
        },
        useStartMark ? 3000 : 1500,
      );
      const onAbort = () => {
        this.interrupt();
        finish({ state: "stopped" });
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      this.endPromptCapture();
      this.busy = true;
      this.agentOwnsForeground = true;
      this.lastCommand = command;
      this.onChange();
      // Inside a program (ssh, a REPL), the text is input for it.
      const line = command;
      // Several lines go in as one paste, so the shell runs them as one command and prints one prompt.
      const multiline =
        line.includes("\n") && (launch.kind === "bash" || launch.kind === "zsh" || launch.kind === "fish");
      pty.write(
        multiline ? `\u001b[200~${line.replace(/\r?\n/g, "\n")}\u001b[201~\r` : `${line.replace(/\r?\n/g, "\r")}\r`,
      );
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    // The processes that the shell started (servers, watchers) end too, so none is left behind.
    if (this.pty) killTree(this.pty.pid);
    try {
      this.pty?.kill();
    } catch {
      // It already exited.
    }
    this.terminal?.dispose();
  }
}

/**
 * A UTF-8 locale when the environment has none: a remote VS Code server often starts without LANG, and then
 * bash shows letters such as ö or я as octal bytes.
 */
function utf8Locale(): Record<string, string> {
  if (process.platform === "win32") return {};
  const current = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  if (/utf-?8/i.test(current)) return {};
  const locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  return { LANG: locale, LC_CTYPE: locale };
}

/**
 * Ends a process and all its descendants: servers and watchers that a shell started, also in the background.
 * Without this, a dev server could keep running after its chat is gone.
 */
export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
      return;
    }
    const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
    const children = new Map<number, number[]>();
    for (const line of table.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!child || parent === undefined || Number.isNaN(parent)) continue;
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    const all: number[] = [];
    const walk = (id: number) => {
      for (const child of children.get(id) ?? []) {
        all.push(child);
        walk(child);
      }
    };
    walk(pid);
    for (const id of all.reverse()) {
      try {
        process.kill(id, "SIGTERM");
      } catch {
        // It already ended.
      }
    }
    // A process that ignores SIGTERM ends a moment later.
    setTimeout(() => {
      for (const id of all) {
        try {
          process.kill(id, "SIGKILL");
        } catch {
          // It already ended.
        }
      }
    }, 1500).unref?.();
  } catch {
    // ps or taskkill is missing; the shell still ends.
  }
}
