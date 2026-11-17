import { describe, expect, test } from "vitest";
import { applyHunks, computeHunks, formatHunk, splitLines } from "../src/core/diff";

describe("computeHunks", () => {
  test("returns no hunks for equal text", () => {
    expect(computeHunks("a\nb\n", "a\nb\n")).toEqual([]);
  });

  test("finds separate hunks for separate changes", () => {
    const hunks = computeHunks("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\nf\n");
    expect(hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newLines])).toEqual([
      [1, ["b"], ["B"]],
      [4, ["e"], ["E", "f"]],
    ]);
  });

  test("handles a new file and a deleted file", () => {
    expect(computeHunks("", "x\ny\n")).toHaveLength(1);
    expect(computeHunks("x\ny\n", "")[0].oldLines).toEqual(["x", "y"]);
  });

  test("formats a hunk like a unified diff", () => {
    expect(formatHunk(computeHunks("a\nb\n", "a\nc\n")[0])).toBe("@@ -2,1 +2,1 @@\n-b\n+c");
  });
});

describe("applyHunks", () => {
  const oldText = "one\ntwo\nthree\nfour\nfive\n";
  const newText = "one\nTWO\nthree\nfour\nFIVE\nsix\n";
  const hunks = computeHunks(oldText, newText);

  test("applies all hunks to get the new text", () => {
    expect(applyHunks(oldText, hunks, new Set([0, 1]))).toBe(newText);
  });

  test("applies only the selected hunk", () => {
    expect(applyHunks(oldText, hunks, new Set([1]))).toBe("one\ntwo\nthree\nfour\nFIVE\nsix\n");
    expect(applyHunks(oldText, hunks, new Set([0]))).toBe("one\nTWO\nthree\nfour\nfive\n");
  });

  test("keeps Windows line endings", () => {
    const crlf = "a\r\nb\r\n";
    const result = applyHunks(crlf, computeHunks(crlf, "a\r\nc\r\n"), new Set([0]));
    expect(result).toBe("a\r\nc\r\n");
  });

  test("matches a random sample of edits", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 200; round++) {
      const before = Array.from({ length: Math.floor(random() * 12) }, () => String(Math.floor(random() * 5)));
      const after = before.flatMap((line) =>
        random() < 0.3 ? [] : random() < 0.2 ? [line, String(Math.floor(random() * 5))] : [line],
      );
      const oldText = before.length > 0 ? `${before.join("\n")}\n` : "";
      const newText = after.length > 0 ? `${after.join("\n")}\n` : "";
      const result = computeHunks(oldText, newText);
      expect(splitLines(applyHunks(oldText, result, new Set(result.map((hunk) => hunk.index))))).toEqual(after);
    }
  });
});
