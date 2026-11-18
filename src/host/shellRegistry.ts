import type * as vscode from "vscode";
import { loadPty, ShellSession, type ShellSession as ShellSessionType } from "./shellSession";

/** One terminal of a chat for the list in the chat: what it is and what it does. */
export interface TerminalInfo {
  readonly id: string;
  readonly name: string;
  readonly pid?: number;
  readonly shell: string;
  readonly cwd?: string;
  readonly state: "idle" | "running" | "waiting" | "stopped";
  readonly command?: string;
}

/**
 * The terminals of a chat. The agent works in terminal 1 by default; `terminal: "new"` opens another one,
 * for example for a server while it runs the tests, like the Copilot agent does. Each one is a real shell.
 */
export class ShellRegistry implements vscode.Disposable {
  private readonly shells = new Map<string, ShellSessionType>();
  private counter = 0;

  constructor(
    private readonly extensionPath: string | undefined,
    private readonly title: () => string,
    private readonly startFolder: () => string,
    private readonly shellPath: () => string | undefined,
    private readonly onChange: () => void,
  ) {}

  /** False when node-pty does not load on this system; then commands run in processes. */
  get available(): boolean {
    return this.extensionPath !== undefined && loadPty(this.extensionPath) !== undefined;
  }

  /**
   * The terminal for a command: the given one, a new one for "new", or terminal 1.
   * Throws for an unknown name, with the list of terminals, so the model can choose again.
   */
  pick(name: string | undefined): { id: string; session: ShellSessionType } | undefined {
    const pty = this.extensionPath ? loadPty(this.extensionPath) : undefined;
    if (!pty) return undefined;
    const wanted = name?.trim().replace(/^#/, "");
    if (wanted && wanted !== "new" && !this.shells.has(wanted)) {
      const known = [...this.shells.keys()];
      throw new Error(
        `There is no terminal "${wanted}". The terminals of this chat: ${known.length ? known.join(", ") : "none yet"}. Use "new" for another one.`,
      );
    }
    const id = wanted && wanted !== "new" ? wanted : wanted === "new" || this.shells.size === 0 ? this.nextId() : "1";
    let session = this.shells.get(id);
    if (!session) {
      session = new ShellSession(pty, this.title, this.startFolder, this.shellPath, this.onChange);
      session.nameSuffix = id === "1" ? "" : ` (${id})`;
      this.shells.set(id, session);
    }
    return { id, session };
  }

  private nextId(): string {
    do this.counter++;
    while (this.shells.has(String(this.counter)));
    return String(this.counter);
  }

  get(id: string): ShellSessionType | undefined {
    return this.shells.get(id);
  }

  /** The first terminal that runs, for keys from the chat and the Stop button. */
  get main(): ShellSessionType | undefined {
    return this.shells.get("1") ?? this.shells.values().next().value;
  }

  get size(): number {
    return this.shells.size;
  }

  list(): TerminalInfo[] {
    return [...this.shells].map(([id, session]) => ({
      id,
      name: id === "1" ? "Terminal 1" : `Terminal ${id}`,
      ...session.info,
    }));
  }

  /** A short line for the model about the other terminals, when there are several. */
  summary(): string {
    if (this.shells.size < 2) return "";
    const parts = this.list().map(
      (terminal) =>
        `${terminal.id} (${terminal.state}${terminal.command ? `: ${terminal.command.slice(0, 40)}` : ""}${terminal.cwd ? `, ${terminal.cwd}` : ""})`,
    );
    return `Terminals of this chat: ${parts.join("; ")}.`;
  }

  kill(id: string): void {
    const session = this.shells.get(id);
    if (!session) return;
    session.kill();
    session.dispose();
    this.shells.delete(id);
    this.onChange();
  }

  dispose(): void {
    for (const session of this.shells.values()) session.dispose();
    this.shells.clear();
  }
}
