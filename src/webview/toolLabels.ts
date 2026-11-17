/** Plain words for the tools of the agent: "Reading src/app.ts" instead of "read_file src/app.ts". */

type Category = "read" | "search" | "edit" | "run" | "check" | "other";

const labels: Record<string, readonly [running: string, done: string, category: Category]> = {
  read_file: ["Reading", "Read", "read"],
  read_skill_file: ["Reading", "Read", "read"],
  list_files: ["Listing", "Listed", "search"],
  search_text: ["Searching for", "Searched for", "search"],
  search_code: ["Searching the code for", "Searched the code for", "search"],
  edit_file: ["Editing", "Edited", "edit"],
  write_file: ["Writing", "Wrote", "edit"],
  run_command: ["Running", "Ran", "run"],
  get_problems: ["Checking problems", "Checked problems", "check"],
  git_diff: ["Reading the Git changes", "Read the Git changes", "check"],
  ask_user: ["Asking you", "Asked you", "other"],
  update_plan: ["Updating the plan", "Updated the plan", "other"],
  load_skill: ["Loading the skill", "Loaded the skill", "other"],
  remember: ["Remembering", "Remembered", "other"],
};

/** The tool name and its target from a summary such as "read_file src/app.ts". */
export function splitSummary(name: string, summary: string): string {
  return summary.startsWith(name) ? summary.slice(name.length).trim() : summary;
}

export function toolLabel(name: string, summary: string, running: boolean): string {
  const target = splitSummary(name, summary);
  const known = labels[name];
  if (known) {
    const verb = running ? known[0] : known[1];
    // Targets of plan and question tools are long sentences; the verb alone reads better.
    return target && !["update_plan", "ask_user", "remember"].includes(name) ? `${verb} ${target}` : verb;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const tool = mcp ? `${mcp[2]} (${mcp[1]})` : name;
  return `${running ? "Using" : "Used"} ${tool}${target ? ` ${target}` : ""}`;
}

export function toolCategory(name: string): Category {
  return labels[name]?.[2] ?? "other";
}

/** "Read 3 files, edited 1 file, and ran 2 commands" for a group of tools. */
export function groupSummary(names: readonly string[]): string {
  const counts: Record<Category, number> = { read: 0, search: 0, edit: 0, run: 0, check: 0, other: 0 };
  for (const name of names) counts[toolCategory(name)]++;
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    counts.read ? `read ${plural(counts.read, "file", "files")}` : "",
    counts.search ? `ran ${plural(counts.search, "search", "searches")}` : "",
    counts.edit ? `edited ${plural(counts.edit, "file", "files")}` : "",
    counts.run ? `ran ${plural(counts.run, "command", "commands")}` : "",
    counts.check ? `made ${plural(counts.check, "check", "checks")}` : "",
    counts.other ? `used ${plural(counts.other, "tool", "tools")}` : "",
  ].filter(Boolean);
  const text = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
