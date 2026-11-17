import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseSkill, projectSkillFolders, type SkillInfo, uniqueSkills, userSkillFolders } from "../core/skills";
import { readSettings } from "./settings";

const maximumSkillFile = 200_000;

/** Finds Agent Skills in the project, in the home folder, and in configured folders. */
export class SkillStore {
  private cache: { key: string; time: number; skills: SkillInfo[] } | undefined;

  async list(roots: readonly vscode.Uri[]): Promise<SkillInfo[]> {
    const settings = readSettings(roots[0]);
    if (!settings.skillsEnabled) return [];
    const key = JSON.stringify([roots.map((root) => root.fsPath), settings.skillPaths, vscode.workspace.isTrusted]);
    if (this.cache && this.cache.key === key && Date.now() - this.cache.time < 10_000) return this.cache.skills;
    const folders: { folder: string; source: string }[] = [];
    if (vscode.workspace.isTrusted) {
      for (const root of roots) {
        for (const folder of projectSkillFolders)
          folders.push({ folder: path.join(root.fsPath, folder), source: folder });
      }
    }
    for (const folder of settings.skillPaths) {
      folders.push({ folder: folder.replace(/^~(?=$|[/\\])/, os.homedir()), source: folder });
    }
    for (const folder of userSkillFolders)
      folders.push({ folder: path.join(os.homedir(), folder), source: `~/${folder}` });

    const skills: SkillInfo[] = [];
    for (const { folder, source } of folders) {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder));
      } catch {
        continue;
      }
      for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        if (type !== vscode.FileType.Directory) continue;
        const skillFolder = path.join(folder, name);
        const text = await this.readText(path.join(skillFolder, "SKILL.md"));
        const parsed = text === undefined ? undefined : parseSkill(text, name);
        if (parsed) skills.push({ name: parsed.name, description: parsed.description, folder: skillFolder, source });
      }
    }
    const result = uniqueSkills(skills);
    this.cache = { key, time: Date.now(), skills: result };
    return result;
  }

  async load(roots: readonly vscode.Uri[], name: string): Promise<string> {
    const skill = await this.find(roots, name);
    const text = (await this.readText(path.join(skill.folder, "SKILL.md"))) ?? "";
    const parsed = parseSkill(text, path.basename(skill.folder));
    const files = await this.files(skill.folder);
    return [
      `# Skill: ${skill.name}`,
      `Folder: ${skill.folder}`,
      "",
      parsed?.body ?? text,
      "",
      files.length > 0
        ? `Files of this skill (read them with read_skill_file):\n${files.map((file) => `- ${file}`).join("\n")}`
        : "",
    ].join("\n");
  }

  async readFile(roots: readonly vscode.Uri[], name: string, file: string): Promise<string> {
    const skill = await this.find(roots, name);
    const absolute = path.resolve(skill.folder, file);
    const relative = path.relative(skill.folder, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("The path is outside the skill folder.");
    const text = await this.readText(absolute);
    if (text === undefined) throw new Error(`The skill file ${file} does not exist or is too large.`);
    if (text.includes("\0")) throw new Error(`The skill file ${file} is binary.`);
    return text;
  }

  private async find(roots: readonly vscode.Uri[], name: string): Promise<SkillInfo> {
    const skills = await this.list(roots);
    const skill = skills.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
    if (!skill)
      throw new Error(`No skill named "${name}". Available: ${skills.map((item) => item.name).join(", ") || "none"}.`);
    return skill;
  }

  private async files(folder: string, prefix = "", depth = 0): Promise<string[]> {
    if (depth > 3) return [];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(folder, prefix)));
    } catch {
      return [];
    }
    const result: string[] = [];
    for (const [name, type] of entries) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (type === vscode.FileType.Directory) result.push(...(await this.files(folder, relative, depth + 1)));
      else if (relative !== "SKILL.md") result.push(relative);
      if (result.length >= 50) break;
    }
    return result.slice(0, 50);
  }

  private async readText(file: string): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.file(file);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maximumSkillFile) return undefined;
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }
}
