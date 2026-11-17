import * as path from "node:path";

/** Builds a safe Git branch name from a task. */
export function branchName(task: string, prefix = "phew/"): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const safePrefix = prefix.replace(/[^A-Za-z0-9/_-]/g, "").replace(/^\/+/, "");
  return `${safePrefix}${slug || "task"}`;
}

/** Valid Git branch names, a practical subset of `git check-ref-format`. */
export function isValidBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.endsWith(".")
  );
}

/** The folder of a new worktree: `<location>/<repo>-<branch>`, or next to the repository by default. */
export function worktreeFolder(repositoryRoot: string, branch: string, location = ""): string {
  const repositoryName = path.basename(repositoryRoot);
  const base = location.trim()
    ? path.resolve(repositoryRoot, location.trim())
    : path.join(path.dirname(repositoryRoot), `${repositoryName}.phew-worktrees`);
  return path.join(base, branch.replace(/[/\\]+/g, "-"));
}

export interface WorktreeInfo {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    let current: { path?: string; head?: string; branch?: string } = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) current = { path: line.slice(9).trim() };
      else if (line.startsWith("HEAD ")) current.head = line.slice(5).trim();
      else if (line.startsWith("branch "))
        current.branch = line
          .slice(7)
          .trim()
          .replace(/^refs\/heads\//, "");
    }
    if (current.path) result.push({ path: current.path, head: current.head, branch: current.branch });
  }
  return result;
}
