import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as vscode from "vscode";
import { lastLine, looksLikePrompt, plainTerminalText, type ShellMark, ShellMarkParser } from "../core/shellMarks";
import { type ShellLaunch, shellLaunch, userShell } from "./shellScripts";

/**
 * The shell of a chat, like the terminal of the Copilot agent: a real terminal (a PTY from node-pty)
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
  private revealed = false;
  private readonly disposables: vscode.Disposable[] = [this.writer, this.closer];
  /** After Ctrl+C the shell prints a prompt later; the next command waits for it, so it does not take it as its own. */
  private settling: Promise<void> | undefined;
  /** The folder of the shell, from its last prompt. */
  cwd: string | undefined;

  constructor(
    private readonly pty$: PtyModule,
    private readonly title: () => string,
    private readonly startFolder: () => string,
    private readonly shellPath: () => string | undefined,
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) this.reset();
      }),
    );
  }

  /** The terminals of Phew, so the terminal watcher does not offer to fix the agent's own commands. */
  static isAgentTerminal(terminal: vscode.Terminal): boolean {
    return terminal.name.startsWith("Phew:");
  }

  get started(): boolean {
    return this.pty !== undefined;
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
      name: `Phew: ${this.title()}`.slice(0, 50),
      pty,
      iconPath: new vscode.ThemeIcon("sparkle"),
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
    const launch = shellLaunch(userShell(this.shellPath()));
    this.launch = launch;
    const cwd = this.cwd && existsSync(this.cwd) ? this.cwd : this.startFolder();
    const pty = this.pty$.spawn(launch.file, launch.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: { ...process.env, ...launch.env, COLORTERM: "truecolor" },
    });
    this.pty = pty;
    this.busy = true;
    pty.onData((data) => {
      if (this.pty !== pty) return;
      for (const piece of this.parser.push(data)) {
        if ("text" in piece) this.show(piece.text);
        else if (piece.mark.kind === "prompt") {
          this.busy = false;
          this.agentOwnsForeground = false;
          if (piece.mark.cwd) this.cwd = piece.mark.cwd;
        }
        for (const listener of this.listeners) listener(piece as { text?: string; mark?: ShellMark });
      }
    });
    pty.onExit(() => {
      if (this.pty !== pty) return;
      this.show("\r\n\x1b[2m[The shell ended. The next command starts a new one.]\x1b[0m\r\n");
      this.pty = undefined;
      this.ready = undefined;
      this.busy = false;
      for (const listener of this.listeners) listener({ text: "\u0000closed" });
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
    const echo = command.split("\n")[0]?.trim().slice(0, 40) ?? "";
    // Shells with marks say exactly where the output starts; elsewhere it starts after the echo of the command.
    const useStartMark = (launch.kind === "bash" || launch.kind === "zsh" || launch.kind === "fish") && !insideProgram;

    return new Promise<ShellResult>((resolve) => {
      let raw = "";
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
        const output = result.output ?? plainTerminalText(raw).replace(/^\n+/, "").replace(/\s+$/, "");
        resolve({ ...result, output });
      };

      // The output starts after the echo of the command: at the start mark, or after the first line break.
      const stream = (text: string) => {
        if (streaming) {
          raw += text;
          options.onOutput(text);
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
            raw += rest;
            options.onOutput(rest);
          }
        }
      };

      const armQuiet = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(
          () => {
            const text = raw || sinceStart;
            // A quiet program that shows a prompt or a question waits for input (ssh, a REPL, a password).
            if (looksLikePrompt(text)) {
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
              raw += rest;
              options.onOutput(rest);
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

      this.busy = true;
      this.agentOwnsForeground = true;
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
    try {
      this.pty?.kill();
    } catch {
      // It already exited.
    }
    this.terminal?.dispose();
  }
}
