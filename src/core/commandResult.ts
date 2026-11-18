import { limitForModel } from "./outputLimit";

/** Reads the result that the host formats as "$ command\n[exit code 0]\noutput". */
export function parseCommandResult(detail: string): {
  command?: string;
  status?: string;
  exitCode?: number;
  output: string;
} {
  const lines = detail.split("\n");
  const start = lines.findIndex((line) => line.startsWith("$ "));
  if (start < 0) return { output: detail };
  const status = /^\[(.+)\]$/.exec(lines[start + 1] ?? "")?.[1];
  const exit = status ? /^exit code (-?\d+)$/.exec(status) : null;
  const rest = lines.slice(start + (status ? 2 : 1)).join("\n");
  // A note from the host after the output, such as "The user stopped this command", is not output.
  const output = rest
    .replace(/\nThe user stopped this command\..*$/s, "")
    .replace(
      /\n?(The program waits for input|It keeps running in the terminal|It watches files|Phew did not stop it|This is a new shell|Ran in terminal \d+\.)[\s\S]*$/,
      "",
    )
    .replace(/\n?The shell (is now in|stays in) .*$/, "")
    .replace(/^\(no output\)$/, "");
  return { command: lines[start]?.slice(2), status, exitCode: exit ? Number(exit[1]) : undefined, output };
}

/** What a command in the terminal of the chat ended with. */
export interface ShellOutcome {
  readonly state: "done" | "waiting" | "running" | "timeout" | "stopped" | "closed" | "busy";
  readonly output: string;
  readonly exitCode?: number;
  readonly prompt?: string;
  readonly watch?: boolean;
}

/** The result for the model: the same "$ command / [status] / output" shape, and what to do next. */
export function describeShellResult(command: string, outcome: ShellOutcome, timeoutSeconds: number): string {
  const output = limitForModel(outcome.output.trim()) || "(no output)";
  const status =
    outcome.state === "done"
      ? `exit code ${outcome.exitCode ?? 0}`
      : outcome.state === "waiting"
        ? "waiting for input"
        : outcome.state === "running"
          ? outcome.watch
            ? "running in watch mode"
            : "running in the background"
          : outcome.state === "timeout"
            ? `still running after ${timeoutSeconds} s`
            : outcome.state === "stopped"
              ? "cancelled"
              : outcome.state === "closed"
                ? "the terminal was closed"
                : "terminal busy";
  const lines = [`$ ${command}`, `[${status}]`, output];
  if (outcome.state === "waiting")
    lines.push(
      `The program waits for input${outcome.prompt ? ` (its last line: "${outcome.prompt.slice(0, 120)}")` : ""}. It keeps running in the terminal of the chat. Your next run_command types into it: an answer, or the next command inside ssh or a REPL. Set interrupt to stop it. Do not type passwords or secrets: ask the user to type them in the terminal.`,
    );
  if (outcome.state === "running")
    lines.push(
      outcome.watch
        ? "It watches files and does not end by itself; it keeps running in the terminal of the chat. Use read_terminal to see its new output after a change, or set interrupt in a later run_command to stop it. For a single run, use the run mode of the tool, for example `vitest run`."
        : "It keeps running in the terminal of the chat. Use read_terminal to see its output or to wait for a text, or set interrupt in a later run_command to stop it.",
    );
  if (outcome.state === "timeout")
    lines.push(
      "Phew did not stop it: it keeps running in the terminal of the chat. Use read_terminal with wait_for to wait until it finishes, or set interrupt in a later run_command to stop it.",
    );
  return lines.join("\n");
}

/** Lines that report errors, for the summary of a failed command. "0 errors" does not count. */
export function countErrors(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (
      /\b(error|errors|failed|failure|fatal|exception|traceback|panic)\b|✗|✕|×/i.test(line) &&
      !/\b0 (errors?|failed|failures?)\b/i.test(line)
    )
      count++;
  }
  return count;
}

/**
 * Links in a line of terminal output: web addresses and file paths with an optional line and column, in the
 * forms that compilers and test runners print: `src/a.ts:12:5`, `src/a.ts(12,5)`, `./a.py`, `/abs/b.go:7`.
 */
export function findLinks(line: string): { start: number; text: string }[] {
  const links: { start: number; text: string }[] = [];
  const pattern =
    /https?:\/\/[^\s'"<>`)\]]+|(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+[\\/])*[\w.@+-]*[A-Za-z_][\w@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))?/g;
  for (const match of line.matchAll(pattern)) {
    let text = match[0].replace(/[.,;:]+$/, "");
    // A bare word with a dot, such as "e.g" or "vitest.config", is a path only with a folder or a line number.
    const isUrl = /^https?:/i.test(text);
    if (
      !isUrl &&
      !/[\\/]/.test(text) &&
      !/[:(]\d/.test(text) &&
      !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|hpp|swift|vue|svelte|json|ya?ml|toml|md|css|scss|html|sh|sql|tf)$/i.test(
        text,
      )
    )
      continue;
    if (!isUrl && /^\d+(\.\d+)+$/.test(text)) continue;
    text = text.replace(/\($/, "");
    links.push({ start: match.index ?? 0, text });
  }
  return links;
}

/** The path, line, and column of a file link from terminal output. */
export function parseFileLink(text: string): { path: string; line?: number; column?: number } | undefined {
  const match = /^(.+?)(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  const line = Number(match[2] ?? match[4]);
  const column = Number(match[3] ?? match[5]);
  return {
    path: match[1],
    ...(Number.isFinite(line) && line > 0 ? { line } : {}),
    ...(Number.isFinite(column) && column > 0 ? { column } : {}),
  };
}
