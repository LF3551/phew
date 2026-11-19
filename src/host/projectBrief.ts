import * as vscode from "vscode";
import { buildProjectBrief } from "../core/projectBrief";
import { git } from "./git";

const briefFiles = ["package.json", "Makefile", "pyproject.toml", "README.md", "docs/ARCHITECTURE.md"];
const maximumFileSize = 64_000;
/** The brief is gathered again after this long, so new scripts or folders show up. */
const lifetimeMs = 60_000;

const cache = new Map<string, { at: number; text: string }>();

async function readSmall(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) return undefined;
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes.slice(0, maximumFileSize));
  } catch {
    return undefined;
  }
}

/**
 * The project brief of a workspace folder for the system prompt. In an untrusted workspace the README is left
 * out, because its text could try to instruct the agent.
 */
export async function projectBrief(root: vscode.Uri): Promise<string> {
  const key = root.toString();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < lifetimeMs) return cached.text;
  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return "";
  }
  const files: Record<string, string> = {};
  for (const name of briefFiles) {
    if (name === "README.md" && !vscode.workspace.isTrusted) continue;
    const text = await readSmall(vscode.Uri.joinPath(root, name));
    if (text !== undefined) files[name] = text;
  }
  const branch = await git(root.fsPath, ["rev-parse", "--abbrev-ref", "HEAD"])
    .then((result) => (result.code === 0 ? result.stdout.trim() : undefined))
    .catch(() => undefined);
  const text = buildProjectBrief({
    entries: entries.map(([name, type]) => ({ name, directory: (type & vscode.FileType.Directory) !== 0 })),
    files,
    branch: branch && branch !== "HEAD" ? branch : undefined,
  });
  cache.set(key, { at: Date.now(), text });
  return text;
}
