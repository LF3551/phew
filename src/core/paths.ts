import * as path from "node:path";

/**
 * Resolves a path from the model inside the workspace root.
 * Returns undefined when the path leaves the workspace.
 */
export function resolveInside(root: string, input: string): string | undefined {
  const cleaned = input.trim().replace(/^["']|["']$/g, "");
  if (cleaned.length === 0 || cleaned.includes("\0")) return undefined;
  const absolute = path.resolve(root, cleaned);
  const relative = path.relative(root, absolute);
  if (relative === "") return absolute;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return absolute;
}

/** Returns a workspace-relative path with forward slashes. */
export function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}
