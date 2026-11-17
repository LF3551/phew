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
