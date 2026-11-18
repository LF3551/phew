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
    .replace(/\n?(The program waits for input|It keeps running in the terminal|Ran in terminal \d+\.)[\s\S]*$/, "")
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
          ? "running in the background"
          : outcome.state === "timeout"
            ? `timed out after ${timeoutSeconds} s`
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
    lines.push("It keeps running in the terminal of the chat. Set interrupt in a later run_command to stop it.");
  if (outcome.state === "timeout")
    lines.push("Phew pressed Ctrl+C. For a long command, set background or a longer timeout in the settings.");
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
