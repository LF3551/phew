import { spawn } from "node:child_process";

export interface CommandResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

const maximumOutput = 200_000;

/** Runs a shell command with a timeout and an output limit. */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let cancelled = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const append = (chunk: Buffer) => {
      if (output.length >= maximumOutput) return;
      output += chunk.toString("utf8");
      if (output.length > maximumOutput) output = `${output.slice(0, maximumOutput)}\n[Output truncated]`;
    };
    const kill = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSeconds * 1000);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.stdin?.end();
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, output: stripAnsi(output), timedOut, cancelled });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with a control character.
const ansiPattern = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ansiPattern, "");
}

export function describeResult(command: string, result: CommandResult): string {
  const status = result.cancelled
    ? "cancelled"
    : result.timedOut
      ? "timed out"
      : result.exitCode === null
        ? "could not start"
        : `exit code ${result.exitCode}`;
  return `$ ${command}\n[${status}]\n${result.output.trim() || "(no output)"}`;
}
