/**
 * Agent Skills: folders with a `SKILL.md` file. The file starts with YAML front matter that has a `name` and a
 * `description`. The agent sees only the names and descriptions, and loads a full skill when it needs it.
 * The format is the same as in Claude Code and other agents.
 */

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  /** Absolute folder of the skill. */
  readonly folder: string;
  /** Where the skill comes from, for example ".claude/skills" in the project. */
  readonly source: string;
}

export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** Project folders with skills, relative to the workspace root. */
export const projectSkillFolders: readonly string[] = [
  ".phew/skills",
  ".agents/skills",
  ".claude/skills",
  ".opencode/skills",
  ".opencode/skill",
];

/** User folders with skills, relative to the home folder. */
export const userSkillFolders: readonly string[] = [
  ".phew/skills",
  ".agents/skills",
  ".claude/skills",
  ".config/opencode/skills",
  ".config/opencode/skill",
];

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parses a SKILL.md file. Returns undefined when the front matter has no name or description. */
export function parseSkill(text: string, fallbackName: string): ParsedSkill | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  let currentKey = "";
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (field) {
      currentKey = field[1].toLowerCase();
      fields[currentKey] = field[2] === ">" || field[2] === "|" ? "" : unquote(field[2]);
    } else if (currentKey && /^\s+\S/.test(line)) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
    }
  }
  const name = (fields.name || fallbackName).trim();
  const description = (fields.description ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name) || !description) return undefined;
  return { name, description: description.slice(0, 1024), body: match[2].trim() };
}

/** Removes duplicate names. The first skill wins, so project skills override user skills. */
export function uniqueSkills(skills: readonly SkillInfo[]): SkillInfo[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The skills section of the system prompt. */
export function skillsPrompt(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return "";
  return [
    "Skills are instructions and resources for special tasks. When a task matches a skill, call load_skill first and follow it.",
    ...skills.slice(0, 100).map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}
