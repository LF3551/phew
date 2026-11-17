import { spawn } from "node:child_process";
import type { GitIdentity } from "../core/commit";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs Git without a shell, so arguments are never interpreted by a shell. */
export function git(cwd: string, args: readonly string[], input?: string, timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", [...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 5_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function gitOrThrow(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const result = await git(cwd, args, input);
  if (result.code !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 500) || "unknown error"}`,
    );
  }
  return result.stdout;
}

export async function repositoryRoot(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function config(cwd: string, key: string): Promise<string | undefined> {
  const result = await git(cwd, ["config", "--get", key]);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

/** The commit identity and the signing configuration of Git in a folder. */
export async function gitIdentity(cwd: string): Promise<GitIdentity> {
  const [name, email, signingKey, gpgSign, gpgFormat] = await Promise.all([
    config(cwd, "user.name"),
    config(cwd, "user.email"),
    config(cwd, "user.signingkey"),
    config(cwd, "commit.gpgsign"),
    config(cwd, "gpg.format"),
  ]);
  return { name, email, signingKey, gpgSign: gpgSign === "true", gpgFormat };
}

/** Staged changes, or all uncommitted changes when nothing is staged. */
export async function diffForCommit(cwd: string): Promise<{ diff: string; staged: boolean }> {
  const staged = await git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff"]);
  if (staged.code === 0 && staged.stdout.trim()) return { diff: staged.stdout, staged: true };
  const all = await git(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff"]);
  return { diff: all.code === 0 ? all.stdout : "", staged: false };
}

export async function recentSubjects(cwd: string, count = 10): Promise<string[]> {
  const result = await git(cwd, ["log", `-${count}`, "--pretty=format:%s"]);
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}
