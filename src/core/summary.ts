import { computeHunks } from "./diff";

/** The result of a task for the summary card: changed files with line counts, the check, and the time. */

export interface FileChange {
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly added: number;
  readonly removed: number;
}

/** Above this size, line counts are skipped: the diff would cost more than it helps. */
const maximumCharacters = 400_000;

export function fileChange(path: string, before: string | null, after: string | null): FileChange | undefined {
  if (before === after) return undefined;
  const kind = before === null ? "added" : after === null ? "deleted" : "modified";
  const oldText = before ?? "";
  const newText = after ?? "";
  if (oldText.length + newText.length > maximumCharacters) return { path, kind, added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const hunk of computeHunks(oldText, newText)) {
    added += hunk.newLines.length;
    removed += hunk.oldLines.length;
  }
  if (kind === "modified" && added === 0 && removed === 0) return undefined;
  return { path, kind, added, removed };
}

export interface TaskOutcomeView {
  readonly status: string;
  readonly seconds: number;
  readonly files: readonly FileChange[];
  readonly check?: { readonly command: string; readonly passed: boolean; readonly attempts: number };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** "Phew! Fixed and checked in 42 s" and similar headlines. */
export function summaryHeadline(outcome: TaskOutcomeView): string {
  const time = formatDuration(outcome.seconds);
  if (outcome.status === "aborted") return `Stopped after ${time}`;
  if (outcome.status !== "done") return `Not finished after ${time}`;
  if (outcome.check?.passed) return `Phew! Done and checked in ${time}`;
  if (outcome.check) return `Done in ${time}, but the check fails`;
  return `Phew! Done in ${time}`;
}

export function summaryTotals(files: readonly FileChange[]): string {
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return `${files.length} ${files.length === 1 ? "file" : "files"} changed, +${added} −${removed}`;
}
