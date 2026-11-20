import type * as vscode from "vscode";
import {
  idleTerminalsToClose,
  newTerminalPlan,
  normalizeLabel,
  type TerminalEvent,
  terminalSummary,
} from "../core/terminals";
import { loadPty, ShellSession, type ShellSession as ShellSessionType } from "./shellSession";

/** Extra terminals that stay idle this long close themselves; terminal 1 never does. */
const idleCloseMs = 15 * 60_000;

/** One terminal of a chat for the list in the chat: what it is and what it does. */
export interface TerminalInfo {
  readonly id: string;
  readonly name: string;
  readonly pid?: number;
  readonly shell: string;
  readonly cwd?: string;
  readonly state: "idle" | "running" | "waiting" | "stopped";
  readonly command?: string;
  /** What the terminal is for, such as "dev server". */
  readonly label?: string;
  /** The ports that its program listens on. */
  readonly ports?: readonly number[];
  readonly idleSince?: number;
}

/**
 * The terminals of a chat. The agent works in terminal 1 by default; `terminal: "new"` opens another one,
 * for example for a server while it runs the tests. Each one is a real shell.
 */
export class ShellRegistry implements vscode.Disposable {
  private readonly shells = new Map<string, ShellSessionType>();
  /** The chat came from an earlier VS Code window, whose terminals ended with it. */
  restoredChat = false;
  /** The model has heard once that the shell is new. */
  restoreNoted = false;
  private counter = 0;

  constructor(
    private readonly extensionPath: string | undefined,
    private readonly title: () => string,
    private readonly startFolder: () => string,
    private readonly shellPath: () => string | undefined,
    private readonly onChange: () => void,
    private readonly loadStartupFiles: () => boolean = () => true,
    /** One line for the chat when a terminal heals itself. */
    private readonly onHeal?: (message: string) => void,
    /** How many terminals a chat may have (phew.commands.maxTerminals). */
    private readonly maxTerminals: () => number = () => 6,
    /** Each event at once, for the chat; the agent gets them together at its next step. */
    private readonly onEvent?: (event: TerminalEvent) => void,
  ) {}

  /** What happened in the terminals since the agent last heard, for its next step. */
  private events: TerminalEvent[] = [];
  private readonly sweeper = setInterval(() => this.closeIdle(Date.now()), 60_000);

  get limit(): number {
    return Math.max(1, this.maxTerminals());
  }

  /** The events since the last call, once. */
  takeEvents(): TerminalEvent[] {
    return this.events.splice(0);
  }

  /** Closes extra terminals that nobody used for a while, and tells the agent. */
  closeIdle(now: number): string[] {
    const closed = idleTerminalsToClose(this.list(), now, idleCloseMs);
    for (const id of closed) {
      const label = this.shells.get(id)?.label;
      this.remove(id);
      this.events.push({ kind: "idle-closed", id, label, minutes: Math.round(idleCloseMs / 60_000) });
    }
    if (closed.length > 0) this.onChange();
    return closed;
  }

  /** The ports that programs in these terminals listen on. */
  portsInUse(): { id: string; label?: string; port: number }[] {
    return this.list().flatMap((terminal) =>
      (terminal.ports ?? []).map((port) => ({ id: terminal.id, label: terminal.label, port })),
    );
  }

  /** False when node-pty does not load on this system; then commands run in processes. */
  get available(): boolean {
    return this.extensionPath !== undefined && loadPty(this.extensionPath) !== undefined;
  }

  /**
   * The terminal for a command: the given one, a new one for "new", or terminal 1.
   * Throws for an unknown name, with the list of terminals, so the model can choose again.
   */
  pick(
    name: string | undefined,
    rawLabel?: unknown,
  ): { id: string; session: ShellSessionType; fresh: boolean; reused?: boolean } | undefined {
    const pty = this.extensionPath ? loadPty(this.extensionPath) : undefined;
    if (!pty) return undefined;
    const wanted = name?.trim().replace(/^#/, "");
    const label = normalizeLabel(rawLabel);
    if (wanted && wanted !== "new" && !this.shells.has(wanted)) {
      const known = [...this.shells.keys()];
      throw new Error(
        `There is no terminal "${wanted}". The terminals of this chat: ${known.length ? known.join(", ") : "none yet"}. Use "new" for another one.`,
      );
    }
    // Without a name, a command goes to the first terminal that does not host a server in the background,
    // so it is never typed into a running server; a program that waits for input (ssh) still gets it.
    const free = [...this.shells].find(([, shell]) => !shell.hostsBackgroundJob)?.[0];
    // "new" without a name, while an extra terminal is free, needs no new shell: it runs in that one. Terminal 1
    // keeps its folder and variables for the next commands, so it never becomes the "new" one.
    const idleFree = [...this.shells].find(
      ([id, shell]) => id !== "1" && shell.info.state === "idle" && !shell.hostsBackgroundJob,
    )?.[0];
    let id =
      wanted && wanted !== "new"
        ? wanted
        : wanted !== "new" && free
          ? free
          : wanted === "new" && !label && idleFree
            ? idleFree
            : undefined;
    let reused = false;
    if (!id) {
      // A new terminal, within the limit: at the limit, the terminal that is idle the longest is used again.
      const idle = this.list()
        .filter((terminal) => terminal.state === "idle" && !this.shells.get(terminal.id)?.hostsBackgroundJob)
        .sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0))
        .map((terminal) => terminal.id);
      const plan = newTerminalPlan({ size: this.shells.size, limit: this.limit, idle });
      if (plan.kind === "full")
        throw new Error(
          `This chat already has ${this.shells.size} terminals, its limit (phew.commands.maxTerminals), and all of them are busy. ${this.summary()} Stop a program with interrupt, close a terminal with close_terminal, or run the command in one of them.`,
        );
      id = plan.kind === "reuse" ? plan.id : this.nextId();
      reused = plan.kind === "reuse";
    }
    let session = this.shells.get(id);
    if (session && label) session.label = label;
    const fresh = !session;
    if (!session) {
      session = new ShellSession(pty, this.title, this.startFolder, this.shellPath, this.onChange);
      session.nameSuffix = id === "1" ? "" : ` (${id})`;
      session.terminalId = id;
      session.extensionRoot = this.extensionPath ?? "";
      session.loadStartupFiles = this.loadStartupFiles;
      session.onHeal = this.onHeal;
      session.label = label;
      session.onEvent = (event) => {
        this.events.push(event);
        this.onEvent?.(event);
        this.onChange();
      };
      this.shells.set(id, session);
    }
    return { id, session, fresh, ...(reused ? { reused } : {}) };
  }

  /** A terminal where nothing runs, for a command that the user starts again; a new one when all are busy. */
  pickIdle(preferred?: string): { id: string; session: ShellSessionType } | undefined {
    const shell = preferred ? this.shells.get(preferred) : undefined;
    if (shell && shell.info.state === "idle") return { id: preferred as string, session: shell };
    const idle = [...this.shells].find(([, candidate]) => candidate.info.state === "idle");
    if (idle) return { id: idle[0], session: idle[1] };
    const picked = this.pick("new");
    return picked ? { id: picked.id, session: picked.session } : undefined;
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
      name: session.label ?? `Terminal ${id}`,
      ...(session.label ? { label: session.label } : {}),
      ...session.info,
    }));
  }

  /** A short line for the model about the other terminals, when there are several. */
  summary(): string {
    return terminalSummary(this.list(), this.limit);
  }

  /** The recent output of each terminal that has some, for "attach the output of a terminal". */
  snapshots(): { id: string; state: TerminalInfo["state"]; command?: string; output: string }[] {
    return this.list()
      .map((terminal) => ({
        id: terminal.id,
        state: terminal.state,
        command: terminal.command,
        output: this.shells.get(terminal.id)?.recentOutput() ?? "",
      }))
      .filter((snapshot) => snapshot.output);
  }

  /** Closes a terminal and ends its processes. */
  kill(id: string): void {
    if (!this.remove(id)) return;
    this.onChange();
  }

  private remove(id: string): boolean {
    const session = this.shells.get(id);
    if (!session) return false;
    session.onEvent = undefined;
    session.kill();
    session.dispose();
    this.shells.delete(id);
    return true;
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const session of this.shells.values()) session.dispose();
    this.shells.clear();
  }
}
