/**
 * The outline of a large file: its functions, classes, types, and headings with their line numbers. When the agent
 * reads a long file without a range, it gets this and the first lines instead of thousands of lines, and then reads
 * only the part it needs. Simple patterns cover the common languages; no language server is needed.
 */

const patterns: readonly RegExp[] = [
  // TypeScript and JavaScript.
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+[\w$]+/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[\w$]+/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+[\w$]+/,
  /^\s*(?:export\s+)?(?:const|let)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/,
  /^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)[\w$]+\s*\([^)]*\)\s*(?::\s*[^={]+)?\s*\{\s*$/,
  // Python.
  /^\s*(?:async\s+)?def\s+\w+/,
  /^\s*class\s+\w+/,
  // Go.
  /^func\s+(?:\([^)]*\)\s*)?\w+/,
  /^type\s+\w+\s+(?:struct|interface)\b/,
  // Rust.
  /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+/,
  /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:struct|enum|trait|mod)\s+\w+/,
  /^\s*impl\b/,
  // Java, C#, and Kotlin.
  /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|abstract\s+|final\s+|sealed\s+|partial\s+)*(?:class|interface|record|enum|object)\s+\w+/,
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+|final\s+|override\s+|abstract\s+|async\s+|virtual\s+)*[\w<>[\],.?\s]+\s+\w+\s*\([^;]*$/,
  /^\s*(?:override\s+|private\s+|internal\s+|suspend\s+)*fun\s+[\w.<>]+/,
  // PHP and Ruby.
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+\w+/,
  /^\s*(?:def|module)\s+[\w.?!]+/,
  // Markdown headings.
  /^#{1,3}\s+\S/,
];

/** The outline entries of a file: line number and the line, at most `limit` of them. */
export function outlineOf(lines: readonly string[], limit = 80): { line: number; text: string }[] {
  const entries: { line: number; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length > 400 || !patterns.some((pattern) => pattern.test(line))) continue;
    entries.push({
      line: index + 1,
      text: line
        .trim()
        .replace(/\s*\{\s*$/, "")
        .slice(0, 120),
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

/** Files longer than this get an outline and their first lines when the agent reads them without a range. */
export const outlineFromLines = 400;
export const firstLinesOfLargeFile = 150;

/** The answer of read_file for a large file without a range. */
export function largeFileView(relative: string, lines: readonly string[]): string {
  const outline = outlineOf(lines);
  const width = String(lines.length).length;
  const number = (line: number) => String(line).padStart(width);
  const head = lines
    .slice(0, firstLinesOfLargeFile)
    .map((line, index) => `${number(index + 1)}| ${line}`)
    .join("\n");
  const outlineText =
    outline.length > 0
      ? outline.map((entry) => `${number(entry.line)}| ${entry.text}`).join("\n")
      : "(no functions, classes, or headings found)";
  return [
    `${relative} has ${lines.length} lines, so here are its outline and its first ${firstLinesOfLargeFile} lines. Read the part you need with start_line and end_line.`,
    "",
    "Outline:",
    outlineText,
    "",
    `Lines 1-${firstLinesOfLargeFile}:`,
    head,
  ].join("\n");
}
