import * as vscode from "vscode";
import { combineRules, type RuleFile, ruleDirectoryCandidates, ruleFileCandidates } from "../core/rules";

const maximumRuleFileSize = 64_000;

async function readSmallText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > maximumRuleFileSize) return undefined;
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Loads the project rules. Rules from untrusted workspaces are ignored because they can contain prompt injection. */
export async function loadRules(root: vscode.Uri): Promise<string> {
  if (!vscode.workspace.isTrusted) return "";
  const files: RuleFile[] = [];
  for (const path of ruleFileCandidates) {
    const content = await readSmallText(vscode.Uri.joinPath(root, path));
    if (content !== undefined) files.push({ path, content });
  }
  for (const directory of ruleDirectoryCandidates) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, directory));
    } catch {
      continue;
    }
    for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      if (type !== vscode.FileType.File || !/\.(md|mdc|txt)$/i.test(name)) continue;
      const path = `${directory}/${name}`;
      const content = await readSmallText(vscode.Uri.joinPath(root, path));
      if (content !== undefined) files.push({ path, content });
    }
  }
  return combineRules(files);
}
