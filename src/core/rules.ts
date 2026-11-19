/** Files with project rules. Phew also reads the formats of other coding agents to make a switch easy. */
export const ruleFileCandidates: readonly string[] = [
  "AGENTS.md",
  ".phew/rules.md",
  "CLAUDE.md",
  ".clinerules",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

/** Directories that contain rule files in Markdown. */
export const ruleDirectoryCandidates: readonly string[] = [".phew/rules", ".clinerules", ".cursor/rules"];

export interface RuleFile {
  readonly path: string;
  readonly content: string;
}

/** Maximum combined size of the rules that are added to the system prompt. */
export const maximumRuleCharacters = 24_000;

/** Combines rule files into one prompt section. Empty files are skipped and long text is cut. */
export function combineRules(files: readonly RuleFile[], limit = maximumRuleCharacters): string {
  const parts: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const content = file.content.trim();
    if (content.length === 0 || seen.has(content)) continue;
    seen.add(content);
    const header = `### ${file.path}\n`;
    const available = limit - used - header.length;
    if (available <= 0) break;
    const body = content.length > available ? `${content.slice(0, available)}\n[Rules truncated]` : content;
    parts.push(header + body);
    used += header.length + body.length;
  }
  return parts.join("\n\n");
}

// Rules with a scope. Each tool keeps its rules in its own folder with its own front matter; Phew reads them all,
// so a team keeps one set of rules for every agent.

/**
 * How a rule reaches the agent:
 * - `always`: in the system prompt of every chat;
 * - `scoped`: added to the result of a tool that reads or changes a matching file;
 * - `described`: listed with its description, and the agent reads it when the task fits;
 * - `manual`: only when the user attaches it.
 */
export type RuleMode = "always" | "scoped" | "described" | "manual";

export interface Rule {
  readonly path: string;
  readonly mode: RuleMode;
  /** For scoped rules: the file patterns, relative to the workspace root. */
  readonly globs: readonly string[];
  readonly description?: string;
  readonly body: string;
}

/** Folders with rule files of other tools, and what a file without front matter means there. */
export const ruleFolders: readonly { readonly dir: string; readonly pattern: RegExp; readonly plain: RuleMode }[] = [
  { dir: ".phew/rules", pattern: /\.(md|mdc|txt)$/i, plain: "always" },
  { dir: ".agents/rules", pattern: /\.md$/i, plain: "always" },
  { dir: ".clinerules", pattern: /\.(md|txt)$/i, plain: "always" },
  { dir: ".cursor/rules", pattern: /\.(md|mdc)$/i, plain: "always" },
  // Copilot applies an instructions file only through applyTo, or when the user attaches it.
  { dir: ".github/instructions", pattern: /\.instructions\.md$/i, plain: "manual" },
  { dir: ".claude/rules", pattern: /\.md$/i, plain: "always" },
  { dir: ".windsurf/rules", pattern: /\.md$/i, plain: "always" },
  { dir: ".kiro/steering", pattern: /\.md$/i, plain: "always" },
];

type FrontValue = string | boolean | string[];

/** Reads simple YAML front matter: `key: value`, quoted strings, booleans, and lists. */
export function parseFrontMatter(content: string): { data: Record<string, FrontValue>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { data: {}, body: content };
  const data: Record<string, FrontValue> = {};
  let listKey: string | undefined;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = Array.isArray(data[listKey]) ? (data[listKey] as string[]) : [];
      list.push(unquote(item[1] ?? ""));
      data[listKey] = list;
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1] ?? "";
    const raw = (pair[2] ?? "").trim();
    listKey = raw === "" ? key : undefined;
    if (raw === "") continue;
    if (/^\[.*\]$/.test(raw))
      data[key] = raw
        .slice(1, -1)
        .split(",")
        .map((part) => unquote(part.trim()))
        .filter(Boolean);
    else if (raw === "true" || raw === "false") data[key] = raw === "true";
    else data[key] = unquote(raw);
  }
  return { data, body: content.slice(match[0].length) };
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, "$2").trim();
}

function globsOf(value: FrontValue | undefined): string[] {
  if (value === undefined || typeof value === "boolean") return [];
  const parts = Array.isArray(value) ? value : value.split(",");
  return parts.map((part) => part.trim().replace(/^\.\//, "")).filter(Boolean);
}

/**
 * One rule from its file. Understands the front matter of Copilot (`applyTo`), Claude (`paths`),
 * Cursor (`globs`, `alwaysApply`, `description`), Antigravity and Windsurf (`trigger`, `globs`),
 * and Kiro (`inclusion`, `fileMatchPattern`).
 */
export function ruleFrom(path: string, content: string, plain: RuleMode = "always"): Rule {
  const { data, body } = parseFrontMatter(content);
  const description = typeof data.description === "string" && data.description ? data.description : undefined;
  const globs = globsOf(data.globs ?? data.glob ?? data.applyTo ?? data.paths ?? data.fileMatchPattern);
  const trigger =
    typeof data.trigger === "string" ? data.trigger : typeof data.inclusion === "string" ? data.inclusion : "";
  const rule = (mode: RuleMode, patterns: readonly string[] = []): Rule => ({
    path,
    mode,
    globs: patterns,
    ...(description ? { description } : {}),
    body: body.trim(),
  });
  if (data.alwaysApply === true || trigger === "always_on" || trigger === "always") return rule("always");
  if (trigger === "manual") return rule("manual");
  if (globs.length > 0) {
    // "**" means every file: the rule is simply always on.
    if (globs.some((glob) => glob === "**" || glob === "**/*" || glob === "*")) return rule("always");
    return rule("scoped", globs);
  }
  if (trigger === "model_decision") return rule("described");
  if (Object.keys(data).length === 0) return rule(plain);
  // Cursor: alwaysApply is false here; with a description the agent decides, without one only the user attaches it.
  if ("alwaysApply" in data) return rule(description ? "described" : "manual");
  // Claude, Antigravity, Windsurf, and Kiro rules without a pattern are always on.
  if (plain === "always") return rule("always");
  // Copilot instructions without applyTo: by description, or only when attached.
  return rule(description ? "described" : "manual");
}

/** A nested AGENTS.md or CLAUDE.md applies to the files of its folder. */
export function nestedRule(path: string, content: string): Rule {
  const folder = path.slice(0, path.lastIndexOf("/"));
  return { path, mode: "scoped", globs: [`${folder}/**`], body: content.trim() };
}

const globCache = new Map<string, RegExp>();

function globRegex(glob: string): RegExp {
  let cached = globCache.get(glob);
  if (cached) return cached;
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? "";
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const slash = glob[index + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end < 0) source += "\\{";
      else {
        source += `(?:${glob
          .slice(index + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        index = end;
      }
    } else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  cached = new RegExp(`^${source}$`);
  globCache.set(glob, cached);
  return cached;
}

/**
 * True when a workspace path matches a pattern. A pattern without a slash, such as `*.ts`, matches the file
 * name in any folder; a folder such as `src/api/` means everything inside it.
 */
export function matchesGlob(glob: string, path: string): boolean {
  let pattern = glob.trim().replace(/^\.?\//, "");
  if (!pattern) return false;
  if (pattern.endsWith("/")) pattern += "**";
  const file = path.replace(/^\.?\//, "");
  if (!pattern.includes("/")) return globRegex(pattern).test(file.slice(file.lastIndexOf("/") + 1));
  return globRegex(pattern).test(file);
}

/** The part of the system prompt about rules that do not apply all the time. */
export function rulesIndex(rules: readonly Rule[]): string {
  const scoped = rules.filter((rule) => rule.mode === "scoped");
  const described = rules.filter((rule) => rule.mode === "described");
  const lines: string[] = [];
  if (scoped.length > 0)
    lines.push(
      "Some rules apply only to some files. Phew adds such a rule to the tool result when you read or change a matching file, so follow the rules that come with tool results:",
      ...scoped
        .slice(0, 40)
        .map((rule) => `- ${rule.path}: ${rule.globs.join(", ")}${rule.description ? ` (${rule.description})` : ""}`),
    );
  if (described.length > 0)
    lines.push(
      "Rules to read with read_file when the task fits their description:",
      ...described.slice(0, 40).map((rule) => `- ${rule.path}: ${rule.description ?? "no description"}`),
    );
  return lines.join("\n");
}

/** The scoped rules for a file that the agent did not get yet in this task, as text for the tool result. */
export function rulesForFile(
  rules: readonly Rule[],
  path: string,
  delivered: Set<string>,
  limit = 8000,
): string | undefined {
  const parts: string[] = [];
  for (const rule of rules) {
    if (rule.mode !== "scoped" || delivered.has(rule.path)) continue;
    if (!rule.globs.some((glob) => matchesGlob(glob, path))) continue;
    delivered.add(rule.path);
    const body = rule.body.length > limit ? `${rule.body.slice(0, limit)}\n[Rule truncated]` : rule.body;
    parts.push(`Rules from ${rule.path} apply to ${path}. Follow them:\n${body}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
