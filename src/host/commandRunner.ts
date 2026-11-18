import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export interface CommandResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** The folder of the shell after the command, so `cd` carries over to the next command. POSIX only. */
  readonly cwd?: string;
}

/** Bash when it exists, so commands behave the same on systems where /bin/sh is a smaller shell. */
const posixShell = process.platform === "win32" ? undefined : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

const maximumOutput = 200_000;

export interface ShellOptions {
  /** A file with the exported variables of the chat's shell, so `export` carries over to the next command. */
  readonly envFile?: string;
  /** Receives the raw output with colors, for the terminal of the chat. */
  readonly onRaw?: (text: string) => void;
  /** Gets the input of the command, for the terminal of the chat. Without it the input is closed. */
  readonly onInput?: (input: { write(text: string): void; end(): void }) => void;
}

/** Variables that belong to one shell and must not come back from the snapshot. */
const shellOwnVariables = "PWD|OLDPWD|SHLVL|_|SHELLOPTS|BASHOPTS|BASH_[A-Z_]*|PPID|UID|EUID";

/** Runs a shell command with a timeout and an output limit. */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  signal: AbortSignal,
  /** Receives the output as it arrives, without terminal escape codes. */
  onData?: (text: string) => void,
  options: ShellOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let cancelled = false;
    // After the command, the shell writes its folder to a file, keeping the exit code.
    const cwdFile = posixShell
      ? path.join(tmpdir(), `phew-cwd-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
      : undefined;
    // The variables that earlier commands exported come back first, and the new ones are saved after.
    const envFile = cwdFile ? options.envFile : undefined;
    const restore = envFile ? `[ -f '${envFile}' ] && . '${envFile}' >/dev/null 2>&1\n` : "";
    const save = envFile
      ? ` export -p 2>/dev/null | grep -v -E '^(declare -x|export) (${shellOwnVariables})(=|$)' > '${envFile}';`
      : "";
    const script = cwdFile
      ? `${restore}${command}\n__phew_exit=$?; pwd -P > '${cwdFile}' 2>/dev/null;${save} exit $__phew_exit`
      : command;
    const color = options.onRaw !== undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, CI: process.env.CI ?? "1", PAGER: "cat", GIT_PAGER: "cat" };
    // The terminal of the chat shows colors; the chat removes them.
    if (color) {
      env.FORCE_COLOR = "1";
      delete env.NO_COLOR;
    } else {
      env.FORCE_COLOR = "0";
      env.NO_COLOR = "1";
    }
    const child = spawn(script, {
      cwd,
      shell: posixShell ?? true,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const append = (chunk: Buffer) => {
      if (output.length >= maximumOutput) return;
      const text = chunk.toString("utf8");
      options.onRaw?.(text);
      onData?.(stripAnsi(text));
      output += text;
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
    if (options.onInput && child.stdin) {
      const stdin = child.stdin;
      stdin.on("error", () => undefined);
      options.onInput({
        write: (text) => {
          if (!stdin.destroyed) stdin.write(text);
        },
        end: () => stdin.end(),
      });
    } else child.stdin?.end();
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      let finalCwd: string | undefined;
      if (cwdFile) {
        try {
          finalCwd = readFileSync(cwdFile, "utf8").trim() || undefined;
          rmSync(cwdFile, { force: true });
        } catch {
          // The command exited early, for example with `exit`; the folder stays as it was.
        }
      }
      resolve({ exitCode, output: stripAnsi(output), timedOut, cancelled, ...(finalCwd ? { cwd: finalCwd } : {}) });
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

/** Output of a terminal: no escape codes, no carriage returns that only redraw a line. */
export function cleanTerminalText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}
