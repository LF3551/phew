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
    .replace(/\n?The shell (is now in|stays in) .*$/, "")
    .replace(/^\(no output\)$/, "");
  return { command: lines[start]?.slice(2), status, exitCode: exit ? Number(exit[1]) : undefined, output };
}
