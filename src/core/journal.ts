import { redactSecrets } from "./secrets";

/**
 * The session journal: an append-only JSON Lines log of what really happened. It is the source of truth for the
 * facts in a handoff, so the model cannot invent which files changed or which checks passed.
 */

export type JournalEvent =
  | {
      readonly t: "session";
      readonly at: number;
      readonly session: string;
      readonly title: string;
      readonly branch?: string;
      readonly head?: string;
    }
  | { readonly t: "user"; readonly at: number; readonly text: string }
  | {
      readonly t: "tool";
      readonly at: number;
      readonly name: string;
      readonly summary: string;
      readonly ok: boolean;
      /** The changed file, for edit and write tools. */
      readonly file?: string;
      /** The command and its exit code, for commands. */
      readonly command?: string;
      readonly exit?: number | null;
    }
  | {
      readonly t: "verify";
      readonly at: number;
      readonly command: string;
      readonly passed: boolean;
      readonly attempt: number;
    }
  | {
      readonly t: "task";
      readonly at: number;
      readonly status: string;
      readonly files: readonly string[];
      readonly message?: string;
    }
  | { readonly t: "plan"; readonly at: number; readonly goal?: string; readonly done: number; readonly total: number }
  | { readonly t: "handoff"; readonly at: number; readonly file: string; readonly narrative: HandoffNarrative }
  | { readonly t: "continued"; readonly at: number; readonly from: string; readonly narrative?: HandoffNarrative };

export interface Decision {
  readonly id: string;
  readonly text: string;
  readonly status: "active" | "replaced" | "dropped";
}

/** The part of a handoff that the model writes: the meaning, not the facts. */
export interface HandoffNarrative {
  readonly title: string;
  readonly status: "in-progress" | "done" | "blocked";
  readonly summary: string;
  readonly decisions: readonly Decision[];
  readonly deadEnds: readonly string[];
  readonly nextSteps: readonly string[];
  readonly openQuestions: readonly string[];
  readonly preferences: readonly string[];
}

const maximumText = 2000;

function clean(text: string, maximum = maximumText): string {
  const redacted = redactSecrets(text).text.replace(/\r\n/g, "\n");
  return redacted.length > maximum ? `${redacted.slice(0, maximum - 1)}…` : redacted;
}

/** One redacted line of the journal. Long texts are cut so the journal stays small. */
export function journalLine(event: JournalEvent): string {
  const safe = JSON.parse(JSON.stringify(event), (key, value: unknown) =>
    typeof value === "string" && key !== "t" ? clean(value) : value,
  ) as JournalEvent;
  return `${JSON.stringify(safe)}\n`;
}

/** Reads a journal. Broken lines, for example after a crash in the middle of a write, are skipped. */
export function parseJournal(text: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as JournalEvent;
      if (value && typeof value === "object" && typeof value.t === "string" && typeof value.at === "number")
        events.push(value);
    } catch {
      // Skip a broken line.
    }
  }
  return events;
}

/** The exit code in the output of a command: `[exit code 1]`. */
export function exitCodeOf(output: string): number | null | undefined {
  const match = /^\[(exit code (-?\d+)|timed out|cancelled|could not start)\]$/m.exec(output);
  if (!match) return undefined;
  return match[2] !== undefined ? Number(match[2]) : null;
}

export interface JournalFacts {
  readonly requests: readonly string[];
  /** Changed files with the number of edits, in the order of the first change. */
  readonly files: readonly { readonly path: string; readonly edits: number }[];
  readonly commands: readonly {
    readonly command: string;
    readonly exit: number | null | undefined;
    readonly ok: boolean;
  }[];
  readonly lastCheck?: { readonly command: string; readonly passed: boolean; readonly attempt: number };
  readonly tasks: number;
  readonly lastStatus?: string;
  readonly started?: number;
  readonly ended?: number;
  /** The narrative of the last handoff, or of the handoff that this session continues. */
  readonly previous?: HandoffNarrative;
  readonly continuedFrom?: string;
}

/** Facts that come only from the journal, never from the model. */
export function factsFromJournal(events: readonly JournalEvent[]): JournalFacts {
  const requests: string[] = [];
  const files = new Map<string, number>();
  const commands: { command: string; exit: number | null | undefined; ok: boolean }[] = [];
  let lastCheck: JournalFacts["lastCheck"];
  let tasks = 0;
  let lastStatus: string | undefined;
  let previous: HandoffNarrative | undefined;
  let continuedFrom: string | undefined;
  for (const event of events) {
    switch (event.t) {
      case "user":
        requests.push(event.text.split("\n")[0].slice(0, 200));
        break;
      case "tool":
        if (event.file && event.ok) files.set(event.file, (files.get(event.file) ?? 0) + 1);
        if (event.command !== undefined) commands.push({ command: event.command, exit: event.exit, ok: event.ok });
        break;
      case "verify":
        lastCheck = { command: event.command, passed: event.passed, attempt: event.attempt };
        break;
      case "task":
        tasks++;
        lastStatus = event.status;
        break;
      case "handoff":
        previous = event.narrative;
        break;
      case "continued":
        continuedFrom = event.from;
        if (event.narrative) previous = event.narrative;
        break;
    }
  }
  return {
    requests,
    files: [...files].map(([path, edits]) => ({ path, edits })),
    commands: commands.slice(-30),
    lastCheck,
    tasks,
    lastStatus,
    started: events[0]?.at,
    ended: events.at(-1)?.at,
    previous,
    continuedFrom,
  };
}
