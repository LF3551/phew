/**
 * The terminals of the agents, made easy to follow: each one has a short name for what it is for, the ports that
 * its programs listen on, and events that the agent hears about between its steps (a server that ended, a shell
 * that closed, an idle terminal that Phew closed). A chat keeps a limited number of terminals.
 */

export type TerminalState = "idle" | "running" | "waiting" | "stopped";

export interface TerminalSummaryItem {
  readonly id: string;
  readonly label?: string;
  readonly state: TerminalState;
  readonly command?: string;
  readonly cwd?: string;
  readonly ports?: readonly number[];
}

/** A short name for a terminal, such as "dev server": plain words, at most 24 characters. */
export function normalizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const label = raw
    .replace(/\p{Cc}/gu, " ")
    .replace(/[^\p{L}\p{N} ._:/+#@-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
    .trim();
  return label || undefined;
}

const portPatterns: readonly RegExp[] = [
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::1?)[:.](\d{2,5})\b/gi,
  /\bhttps?:\/\/[\w.-]+:(\d{2,5})\b/gi,
  /\b(?:listening|listens|running|serving|server started|started server|available)\b[^\n]{0,40}?\bport\s+(\d{2,5})\b/gi,
  /\bport\s+(\d{2,5})\b[^\n]{0,30}?\b(?:listening|ready|open)\b/gi,
];

/** The ports that a program says it listens on, from its output: at most five, in order. */
export function portsIn(text: string): number[] {
  const found: number[] = [];
  for (const pattern of portPatterns)
    for (const match of text.matchAll(pattern)) {
      const port = Number(match[1]);
      if (port >= 80 && port <= 65535 && !found.includes(port)) found.push(port);
    }
  return found.slice(0, 5);
}

const conflictPatterns: readonly RegExp[] = [
  /EADDRINUSE[^\n]*?:(\d{2,5})\b/i,
  /address already in use[^\n]*?:(\d{2,5})\b/i,
  // Python: OSError: [Errno 98] Address already in use: ('0.0.0.0', 8000)
  /address already in use[^\n]*?\(\s*['"][^'"]*['"]\s*,\s*(\d{2,5})\s*\)/i,
  /\bport\s+(\d{2,5})\s+is\s+(?:already\s+)?in use\b/i,
  /already running on port\s+(\d{2,5})\b/i,
  /\bbind\b[^\n]*?:(\d{2,5})\b[^\n]*address already in use/i,
];

/** The port that a failed start reports as taken, if any. */
export function portConflict(text: string): number | undefined {
  for (const pattern of conflictPatterns) {
    const port = Number(pattern.exec(text)?.[1]);
    if (port > 0 && port <= 65535) return port;
  }
  return undefined;
}

/** How a terminal reads for the model: `2 "dev server" (running: npm run dev, port 5173, ~/app)`. */
export function describeTerminal(terminal: TerminalSummaryItem): string {
  const details = [
    terminal.state + (terminal.command ? `: ${terminal.command.split("\n")[0]?.slice(0, 40)}` : ""),
    terminal.ports && terminal.ports.length > 0
      ? `port${terminal.ports.length > 1 ? "s" : ""} ${terminal.ports.join(", ")}`
      : "",
    terminal.cwd ?? "",
  ].filter(Boolean);
  return `${terminal.id}${terminal.label ? ` "${terminal.label}"` : ""} (${details.join(", ")})`;
}

/** A short line for the model about all terminals of the chat, when there are several. */
export function terminalSummary(terminals: readonly TerminalSummaryItem[], limit: number): string {
  if (terminals.length < 2) return "";
  return `Terminals of this chat (${terminals.length} of ${limit}): ${terminals.map(describeTerminal).join("; ")}.`;
}

export type TerminalEvent =
  | {
      readonly kind: "exited";
      readonly id: string;
      readonly label?: string;
      readonly command?: string;
      readonly exitCode?: number;
    }
  | { readonly kind: "closed"; readonly id: string; readonly label?: string }
  | { readonly kind: "idle-closed"; readonly id: string; readonly label?: string; readonly minutes: number };

/** What changed in the terminals since the last step of the agent, as one note. */
export function terminalEventsNote(events: readonly TerminalEvent[]): string {
  if (events.length === 0) return "";
  const name = (event: TerminalEvent) => `Terminal ${event.id}${event.label ? ` "${event.label}"` : ""}`;
  const lines = events.map((event) => {
    switch (event.kind) {
      case "exited":
        return `- ${name(event)}: ${event.command ? `\`${event.command.split("\n")[0]?.slice(0, 60)}\`` : "the program"} ended${event.exitCode === undefined ? "" : ` with exit code ${event.exitCode}`}${event.exitCode ? ". Read its output with read_terminal to see why" : ""}.`;
      case "closed":
        return `- ${name(event)}: the shell closed. A command there starts a new shell.`;
      case "idle-closed":
        return `- ${name(event)}: Phew closed it after ${event.minutes} idle minutes.`;
      default:
        return "";
    }
  });
  return `(Terminal update)\n${lines.join("\n")}`;
}

/** What to do when the agent asks for a new terminal. */
export function newTerminalPlan(input: {
  readonly size: number;
  readonly limit: number;
  /** Terminals where nothing runs, the longest idle first. */
  readonly idle: readonly string[];
}): { readonly kind: "new" } | { readonly kind: "reuse"; readonly id: string } | { readonly kind: "full" } {
  if (input.size < Math.max(1, input.limit)) return { kind: "new" };
  const id = input.idle[0];
  return id ? { kind: "reuse", id } : { kind: "full" };
}

/** Extra terminals that have been idle for long: never terminal 1, never one that waits or runs. */
export function idleTerminalsToClose(
  terminals: readonly { readonly id: string; readonly state: TerminalState; readonly idleSince?: number }[],
  now: number,
  afterMs: number,
): string[] {
  return terminals
    .filter(
      (terminal) =>
        terminal.id !== "1" &&
        (terminal.state === "idle" || terminal.state === "stopped") &&
        terminal.idleSince !== undefined &&
        now - terminal.idleSince >= afterMs,
    )
    .map((terminal) => terminal.id);
}
