import { applyHunks, computeHunks, type Hunk } from "./diff";

/**
 * Editor review: the agent's change is already in the file, and the user keeps or undoes each hunk.
 * `original` is the accepted baseline and `current` is the file content.
 */
export interface ReviewTexts {
  readonly original: string;
  readonly current: string;
}

export function reviewHunks(texts: ReviewTexts): Hunk[] {
  return computeHunks(texts.original, texts.current);
}

/** Accepts one hunk into the baseline. The file content does not change. */
export function keepHunk(texts: ReviewTexts, index: number): ReviewTexts {
  const hunks = reviewHunks(texts);
  if (!hunks.some((hunk) => hunk.index === index)) return texts;
  return { original: applyHunks(texts.original, hunks, new Set([index])), current: texts.current };
}

/** Reverts one hunk in the file content. The baseline does not change. */
export function undoHunk(texts: ReviewTexts, index: number): ReviewTexts {
  const hunks = reviewHunks(texts);
  if (!hunks.some((hunk) => hunk.index === index)) return texts;
  const others = new Set(hunks.filter((hunk) => hunk.index !== index).map((hunk) => hunk.index));
  return { original: texts.original, current: applyHunks(texts.original, hunks, others) };
}

/** The zero-based line where the CodeLens of a hunk appears in the current text. */
export function hunkAnchorLine(hunk: Hunk, lineCount: number): number {
  return Math.max(0, Math.min(hunk.newStart, Math.max(0, lineCount - 1)));
}
