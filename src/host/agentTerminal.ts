import * as vscode from "vscode";

/**
 * The terminal of the chat in the panel. Like the Copilot agent, the agent's commands show here live
 * and in color, and the same output shows in the terminal inside the chat. Typing goes to the running
 * command through its input line, so both terminals echo it. It is a terminal of Phew itself
 * (a pseudoterminal), so it works with every shell and needs no shell integration.
 */

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
/** The output of a command without a TTY ends lines with \n only; a terminal needs \r\n. */
export const toTerminal = (text: string) => text.replace(/\r?\n/g, "\r\n");

export class AgentTerminal implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private readonly writer = new vscode.EventEmitter<string>();
  private opened = false;
  private pending = "";
  private input: ((data: string) => void) | undefined;
  private revealed = false;
  private readonly disposables: vscode.Disposable[] = [this.writer];

  constructor(private readonly title: () => string) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed !== this.terminal) return;
        this.terminal = undefined;
        this.opened = false;
        this.revealed = false;
      }),
    );
  }

  /** The terminals of Phew, so the terminal watcher does not offer to fix the agent's own commands. */
  static isAgentTerminal(terminal: vscode.Terminal): boolean {
    return terminal.name.startsWith("Phew:");
  }

  private ensure(): vscode.Terminal {
    if (this.terminal) return this.terminal;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writer.event,
      open: () => {
        this.opened = true;
        this.writer.fire(dim("Phew shows the agent's commands here. Ctrl+C stops a command; typing answers it.\r\n"));
        if (this.pending) this.writer.fire(this.pending);
        this.pending = "";
      },
      close: () => {
        this.terminal = undefined;
        this.opened = false;
      },
      handleInput: (data) => this.input?.(data),
    };
    this.terminal = vscode.window.createTerminal({
      name: `Phew: ${this.title()}`.slice(0, 50),
      pty,
      iconPath: new vscode.ThemeIcon("sparkle"),
      isTransient: true,
    });
    return this.terminal;
  }

  private write(text: string): void {
    if (this.opened) this.writer.fire(text);
    else this.pending = (this.pending + text).slice(-200_000);
  }

  show(): void {
    this.ensure().show(false);
  }

  /** A command starts: the first one shows the terminal without taking the focus from the chat. */
  start(command: string, folder: string, input: (data: string) => void, reveal: boolean): void {
    const terminal = this.ensure();
    if (reveal && !this.revealed) {
      terminal.show(true);
      this.revealed = true;
    }
    this.input = input;
    this.write(`\r\n${dim(folder)}\r\n\x1b[1;36m$\x1b[0m \x1b[1m${toTerminal(command)}\x1b[0m\r\n`);
  }

  /** Output of the command, and the echo of typed keys, already with \r\n. */
  output(text: string): void {
    this.write(text);
  }

  finish(label: string, ok: boolean): void {
    this.input = undefined;
    this.write(`\r\n${ok ? "\x1b[32m✓" : "\x1b[31m✗"} ${label}\x1b[0m\r\n`);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.terminal?.dispose();
  }
}
