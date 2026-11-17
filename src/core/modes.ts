/** Tool groups that a mode can allow. */
export type ToolGroup = "read" | "edit" | "command" | "mcp" | "memory";

export const toolGroups: readonly ToolGroup[] = ["read", "edit", "command", "mcp", "memory"];

/** A mode is an identifier. Built-in modes and user modes share the same shape. */
export type Mode = string;

export interface ModeDefinition {
  readonly id: Mode;
  readonly name: string;
  readonly description: string;
  /** Instructions for the model in this mode. */
  readonly instructions: string;
  readonly tools: ReadonlySet<ToolGroup>;
  /** Optional model profile that this mode uses instead of the active model. */
  readonly model?: string;
  readonly builtIn: boolean;
}

const set = (...groups: ToolGroup[]): ReadonlySet<ToolGroup> => new Set(groups);

export const builtInModes: readonly ModeDefinition[] = [
  {
    id: "ask",
    name: "Ask",
    description: "Answers questions about your code.",
    instructions: [
      "You are in Ask mode.",
      "Answer the question with the read-only tools.",
      "Do not propose file changes unless the user asks for an example.",
    ].join("\n"),
    tools: set("read", "memory"),
    builtIn: true,
  },
  {
    id: "plan",
    name: "Plan",
    description: "Explores the code and writes a plan.",
    instructions: [
      "You are in Plan mode.",
      "Explore the code with the read-only tools, then write a numbered implementation plan.",
      "List the files to change, the risks, and how to verify the result.",
      "Do not change files.",
    ].join("\n"),
    tools: set("read", "memory"),
    builtIn: true,
  },
  {
    id: "code",
    name: "Code",
    description: "Edits files and runs commands with your approval.",
    instructions: [
      "You are in Code mode.",
      "Make the smallest correct change that solves the task.",
      "Read the relevant code before you edit it.",
      "Change files only with the tools: edit_file for focused changes and write_file for new files or full rewrites.",
      "Showing code in the answer does not change any file.",
      "Run the relevant tests or checks with run_command when they exist.",
    ].join("\n"),
    tools: set("read", "edit", "command", "mcp", "memory"),
    builtIn: true,
  },
  {
    id: "debug",
    name: "Debug",
    description: "Finds the root cause of a bug, then fixes it.",
    instructions: [
      "You are in Debug mode.",
      "Reproduce the problem first, for example with a test or a command.",
      "Form hypotheses, check them with the tools, and find the root cause before you change code.",
      "Fix the root cause with the smallest correct change, then run the reproduction again.",
    ].join("\n"),
    tools: set("read", "edit", "command", "mcp", "memory"),
    builtIn: true,
  },
  {
    id: "review",
    name: "Review",
    description: "Reviews changes for bugs, security, and style.",
    instructions: [
      "You are in Review mode.",
      "Review the current changes with git_diff and the read-only tools.",
      "Report concrete findings ordered by severity: bugs, security problems, missing tests, then style.",
      "For each finding, give the file, the line, the problem, and a suggested fix. Do not change files.",
    ].join("\n"),
    tools: set("read", "memory"),
    builtIn: true,
  },
];

/** Validates user-defined modes from the settings or `.phew/modes.json`. Invalid entries are skipped. */
export function parseCustomModes(
  value: unknown,
  existing: readonly ModeDefinition[] = builtInModes,
): {
  modes: ModeDefinition[];
  errors: string[];
} {
  const modes: ModeDefinition[] = [];
  const errors: string[] = [];
  const taken = new Set(existing.map((mode) => mode.id));
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      errors.push("A custom mode needs an id with lowercase letters, digits, and dashes.");
      continue;
    }
    if (taken.has(id)) {
      errors.push(`The mode id "${id}" is already used.`);
      continue;
    }
    const tools: ToolGroup[] = Array.isArray(item.tools)
      ? item.tools.filter((group): group is ToolGroup => (toolGroups as readonly unknown[]).includes(group))
      : ["read"];
    taken.add(id);
    modes.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 40) : id,
      description: typeof item.description === "string" ? item.description.slice(0, 200) : "",
      instructions: typeof item.instructions === "string" ? item.instructions.slice(0, 8000) : "",
      tools: new Set(tools),
      model: typeof item.model === "string" && item.model.trim() ? item.model.trim() : undefined,
      builtIn: false,
    });
  }
  return { modes, errors };
}

export function canChange(mode: ModeDefinition): boolean {
  return mode.tools.has("edit") || mode.tools.has("command") || mode.tools.has("mcp");
}

export function isModeId(value: unknown): value is Mode {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
}

export function findMode(id: string, all: readonly ModeDefinition[]): ModeDefinition {
  return all.find((mode) => mode.id === id) ?? (builtInModes.find((mode) => mode.id === "code") as ModeDefinition);
}
