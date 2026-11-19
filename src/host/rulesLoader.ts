import * as os from "node:os";
import * as vscode from "vscode";
import {
  combineRules,
  nestedRule,
  type Rule,
  type RuleFile,
  ruleFileCandidates,
  ruleFolders,
  ruleFrom,
  rulesIndex,
} from "../core/rules";

const maximumRuleFileSize = 64_000;
/** Nested AGENTS.md files in big repositories: enough for real projects, bounded for huge ones. */
const maximumNestedFiles = 60;

async function readSmallText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > maximumRuleFileSize) return undefined;
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function readFolder(
  root: vscode.Uri,
  dir: string,
  pattern: RegExp,
  label: string,
): Promise<{ path: string; content: string }[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, dir));
  } catch {
    return [];
  }
  const files: { path: string; content: string }[] = [];
  for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (type !== vscode.FileType.File || !pattern.test(name)) continue;
    const content = await readSmallText(vscode.Uri.joinPath(root, dir, name));
    if (content !== undefined) files.push({ path: `${label}/${name}`, content });
  }
  return files;
}

/** The rules of a chat: the text for the system prompt and the rules that come with matching files. */
export interface RuleSet {
  /** Rules that are always on, and the list of the others, for the system prompt. */
  readonly prompt: string;
  /** Rules that apply to some files, for the tool results. */
  readonly scoped: readonly Rule[];
}

/**
 * Loads the rules: your personal rules (~/.phew), and the rules of the project in the formats of Phew and other
 * agents. Rules of an untrusted workspace are left out because they can contain prompt injection.
 */
export async function loadRuleSet(root: vscode.Uri): Promise<RuleSet> {
  const rules: Rule[] = [];
  const home = vscode.Uri.file(os.homedir());
  const personal = await readSmallText(vscode.Uri.joinPath(home, ".phew", "AGENTS.md"));
  if (personal !== undefined) rules.push(ruleFrom("~/.phew/AGENTS.md", personal));
  for (const file of await readFolder(home, ".phew/rules", /\.md$/i, "~/.phew/rules"))
    rules.push(ruleFrom(file.path, file.content));

  if (vscode.workspace.isTrusted) {
    for (const path of [...ruleFileCandidates, "GEMINI.md"]) {
      const content = await readSmallText(vscode.Uri.joinPath(root, path));
      if (content !== undefined) rules.push(ruleFrom(path, content));
    }
    for (const folder of ruleFolders)
      for (const file of await readFolder(root, folder.dir, folder.pattern, folder.dir))
        rules.push(ruleFrom(file.path, file.content, folder.plain));
    // AGENTS.md (and CLAUDE.md, GEMINI.md) in a subfolder applies to the files of that folder.
    const nested = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, "*/**/{AGENTS,CLAUDE,GEMINI}.md"),
      "**/{node_modules,.git,dist,build,out,vendor,target,.venv,venv}/**",
      maximumNestedFiles,
    );
    for (const uri of nested.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      if (!uri.fsPath.startsWith(root.fsPath)) continue;
      const relative = uri.fsPath.slice(root.fsPath.length + 1).replace(/\\/g, "/");
      const content = await readSmallText(uri);
      if (content !== undefined) rules.push(nestedRule(relative, content));
    }
  }

  const always: RuleFile[] = rules
    .filter((rule) => rule.mode === "always")
    .map((rule) => ({ path: rule.path, content: rule.body }));
  const prompt = [combineRules(always), rulesIndex(rules)].filter(Boolean).join("\n\n");
  return { prompt, scoped: rules.filter((rule) => rule.mode === "scoped") };
}

/** The text of the rules for the system prompt (rules that are always on, and the list of the others). */
export async function loadRules(root: vscode.Uri): Promise<string> {
  return (await loadRuleSet(root)).prompt;
}
