/** One contiguous block of changed lines with surrounding context. */
export interface Hunk {
  /** Stable index of the hunk in the diff, starting at 0. */
  readonly index: number;
  /** First line of the hunk in the original text, zero-based. */
  readonly oldStart: number;
  /** Number of original lines that the hunk replaces, without context. */
  readonly oldLength: number;
  /** First line of the replacement in the new text, zero-based. */
  readonly newStart: number;
  /** Lines that replace the original lines. */
  readonly newLines: readonly string[];
  /** Original lines that the hunk removes. */
  readonly oldLines: readonly string[];
}

type Operation = { readonly kind: "equal" | "delete" | "insert"; readonly oldIndex: number; readonly newIndex: number };

/** Splits text into lines. A final line break does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Returns the line ending style of the text. */
export function detectEol(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Computes a minimal line edit script with the Myers algorithm. */
function editScript(oldLines: readonly string[], newLines: readonly string[]): Operation[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  const operations: Operation[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const state = trace[d];
    const k = x - y;
    let previousK: number;
    if (k === -d || (k !== d && state[offset + k - 1] < state[offset + k + 1])) previousK = k + 1;
    else previousK = k - 1;
    const previousX = d === 0 ? 0 : state[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      operations.push({ kind: "equal", oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (x === previousX) operations.push({ kind: "insert", oldIndex: x, newIndex: previousY });
      else operations.push({ kind: "delete", oldIndex: previousX, newIndex: y });
    }
    x = previousX;
    y = previousY;
  }
  return operations.reverse();
}

/** Groups the changed lines between two texts into hunks. */
export function computeHunks(oldText: string, newText: string): Hunk[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const operations = editScript(oldLines, newLines);
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < operations.length) {
    if (operations[i].kind === "equal") {
      i++;
      continue;
    }
    const first = operations[i];
    const removed: string[] = [];
    const added: string[] = [];
    while (i < operations.length && operations[i].kind !== "equal") {
      const operation = operations[i];
      if (operation.kind === "delete") removed.push(oldLines[operation.oldIndex]);
      else added.push(newLines[operation.newIndex]);
      i++;
    }
    hunks.push({
      index: hunks.length,
      oldStart: first.oldIndex,
      oldLength: removed.length,
      newStart: first.newIndex,
      oldLines: removed,
      newLines: added,
    });
  }
  return hunks;
}

/**
 * Applies only the selected hunks to the original text.
 * Unselected hunks keep the original lines.
 */
export function applyHunks(oldText: string, hunks: readonly Hunk[], selected: ReadonlySet<number>): string {
  const eol = detectEol(oldText);
  const oldLines = splitLines(oldText);
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    if (!selected.has(hunk.index)) continue;
    result.push(...oldLines.slice(cursor, hunk.oldStart), ...hunk.newLines);
    cursor = hunk.oldStart + hunk.oldLength;
  }
  result.push(...oldLines.slice(cursor));
  if (result.length === 0) return "";
  const trailing = oldText.length === 0 || /\r?\n$/.test(oldText) ? eol : "";
  return result.join(eol) + trailing;
}

/** Returns a short unified-diff style preview for the model and the user interface. */
export function formatHunk(hunk: Hunk): string {
  const header = `@@ -${hunk.oldStart + 1},${hunk.oldLength} +${hunk.newStart + 1},${hunk.newLines.length} @@`;
  return [header, ...hunk.oldLines.map((line) => `-${line}`), ...hunk.newLines.map((line) => `+${line}`)].join("\n");
}
