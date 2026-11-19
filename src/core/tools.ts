import type { ToolDefinition } from "./chat";
import type { ModeDefinition, ToolGroup } from "./modes";

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const readTools: readonly ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List workspace files that match a glob pattern. Files excluded by the VS Code settings are not listed.",
    parameters: object(
      {
        pattern: { type: "string", description: "Glob pattern relative to the workspace, for example src/**/*.ts." },
        limit: { type: "number", description: "Maximum number of results. Default 200." },
      },
      ["pattern"],
    ),
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace. Lines are numbered from 1. Use a line range for large files.",
    parameters: object(
      {
        path: { type: "string", description: "Path relative to the workspace root." },
        start_line: { type: "number", description: "First line to read, starting at 1." },
        end_line: { type: "number", description: "Last line to read." },
      },
      ["path"],
    ),
  },
  {
    name: "search_text",
    description: "Search for text in workspace files. Returns matching lines with their paths and line numbers.",
    parameters: object(
      {
        query: { type: "string", description: "Text to find." },
        is_regex: { type: "boolean", description: "Treat the query as a regular expression." },
        include: { type: "string", description: "Glob pattern of files to search. Default all files." },
      },
      ["query"],
    ),
  },
  {
    name: "search_code",
    description:
      "Find the code that is most relevant to a question in the code index, for example 'where is the login handled'. Returns ranked code snippets with paths and line numbers.",
    parameters: object(
      {
        query: { type: "string", description: "What you are looking for, in words or identifiers." },
        limit: { type: "number", description: "Maximum number of snippets. Default 8." },
      },
      ["query"],
    ),
  },
  {
    name: "git_diff",
    description: "Show the uncommitted Git changes of the workspace. Use staged=true for the staged changes only.",
    parameters: object(
      {
        staged: { type: "boolean", description: "Show only the staged changes." },
        path: { type: "string", description: "Limit the diff to one path." },
      },
      [],
    ),
  },
  {
    name: "get_problems",
    description: "Get the errors and warnings from the VS Code Problems panel, optionally for one file.",
    parameters: object({ path: { type: "string", description: "Path relative to the workspace root." } }, []),
  },
];

export const changeTools: readonly ToolDefinition[] = [
  {
    name: "edit_file",
    description:
      "Replace one exact occurrence of old_text with new_text in a file. Include enough context to make old_text unique. The user reviews the change before it is applied.",
    parameters: object(
      {
        path: { type: "string", description: "Path relative to the workspace root." },
        old_text: { type: "string", description: "Exact text to replace, including whitespace." },
        new_text: { type: "string", description: "Replacement text." },
      },
      ["path", "old_text", "new_text"],
    ),
  },
  {
    name: "write_file",
    description:
      "Create a file or replace all of its content. Prefer edit_file for small changes. The user reviews the change before it is applied.",
    parameters: object(
      {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Complete new file content." },
      },
      ["path", "content"],
    ),
  },
  {
    name: "run_command",
    description:
      "Run a command in the terminal of this chat: one real, interactive shell that the user sees and can type into. The session stays between commands: `cd`, variables, activated environments, and programs such as `ssh` or a REPL carry over. " +
      "When a program waits for input (a prompt, a question, a remote shell after ssh), the result says so, and your next run_command types into that program: an answer, or the next command inside ssh. Set interrupt to press Ctrl+C first. " +
      "Never type passwords or secrets: ask the user to type them in the terminal, then continue. Prefer non-interactive flags (for example --yes, --no-pager). For servers and watchers, set background: the command keeps running and you get its first output.",
    parameters: object(
      {
        command: {
          type: "string",
          description:
            "The command, or the text to type into the program that waits for input. Empty with interrupt to only stop.",
        },
        description: {
          type: "string",
          description:
            'What the command does, in 3 to 8 plain words for the user, for example "Run the unit tests" or "List files in src". Do not repeat the command.',
        },
        cwd: {
          type: "string",
          description: "Folder for this command only, relative to the workspace. Default: where the shell is now.",
        },
        background: {
          type: "boolean",
          description:
            "For servers and watchers that do not stop: return after the first seconds of output and keep it running.",
        },
        interrupt: {
          type: "boolean",
          description: "Press Ctrl+C before the command, to stop a running program.",
        },
        terminal: {
          type: "string",
          description:
            'Which terminal of this chat: "1" by default, "new" to open another one (for example for a server while you run tests), or the number of one that you opened before.',
        },
      },
      ["command"],
    ),
  },
];

/** Reading a terminal that keeps running: a server, a watcher, or ssh. */
export const terminalTools: readonly ToolDefinition[] = [
  {
    name: "read_terminal",
    description:
      "Read the new output of a terminal of this chat where a program keeps running (a server, a watcher, a build in the background, ssh), since the last read. " +
      "With wait_for, wait until the new output contains that text, the program ends, or timeout_seconds pass, for example until a server says that it listens. It does not type anything.",
    parameters: object(
      {
        terminal: { type: "string", description: 'The terminal, for example "2". Default: "1".' },
        wait_for: {
          type: "string",
          description: 'Text to wait for, case-insensitive, for example "listening on" or "compiled successfully".',
        },
        timeout_seconds: { type: "number", description: "How long to wait for wait_for. Default 30, at most 600." },
      },
      [],
    ),
  },
];

/** Tools to talk with the user and to keep the checklist. Every mode with the read group has them. */
export const interactionTools: readonly ToolDefinition[] = [
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when the request is ambiguous or a decision is needed. Offer short options when possible. Do not ask for things that you can find in the code.",
    parameters: object(
      {
        question: { type: "string", description: "The question." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Up to 8 short answers that the user can click.",
        },
        allow_text: { type: "boolean", description: "Allow a free text answer. Default true." },
      },
      ["question"],
    ),
  },
  {
    name: "update_plan",
    description:
      "Create or update the checklist of the task for multi-step work. Send the full list each time. Mark one item in_progress while you work on it.",
    parameters: object(
      {
        goal: { type: "string", description: "The goal of the task, in one sentence." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["text", "status"],
            additionalProperties: false,
          },
        },
      },
      ["items"],
    ),
  },
];

export const skillTools: readonly ToolDefinition[] = [
  {
    name: "load_skill",
    description: "Load the full instructions of a skill by name, with the list of its files.",
    parameters: object({ name: { type: "string", description: "The skill name." } }, ["name"]),
  },
  {
    name: "read_skill_file",
    description: "Read a file that belongs to a skill, for example a template or a reference document.",
    parameters: object(
      {
        name: { type: "string", description: "The skill name." },
        path: { type: "string", description: "Path inside the skill folder." },
      },
      ["name", "path"],
    ),
  },
];

export const memoryTools: readonly ToolDefinition[] = [
  {
    name: "remember",
    description:
      "Save a short, durable fact to memory: a fact about this project (scope project, for example a build command, a convention, or a pitfall), or a preference of the user for every project (scope personal). Use replaces to correct an older note. Do not save secrets or temporary details.",
    parameters: object(
      {
        note: { type: "string", description: "One concise fact, at most 300 characters." },
        scope: {
          type: "string",
          enum: ["project", "personal"],
          description: "project (default): about this code; personal: how the user likes to work, in every project.",
        },
        source: {
          type: "string",
          description: "The file that shows the fact, relative to the workspace, so later chats can check it.",
        },
        replaces: { type: "string", description: "The text of an older note that this note corrects." },
      },
      ["note"],
    ),
  },
  {
    name: "forget",
    description: "Remove a note from memory when it is wrong or no longer true.",
    parameters: object({ note: { type: "string", description: "The text of the note, or words that only it has." } }, [
      "note",
    ]),
  },
];

const groupOf: Readonly<Record<string, ToolGroup>> = {
  ...Object.fromEntries([...readTools, ...interactionTools, ...skillTools].map((tool) => [tool.name, "read"])),
  edit_file: "edit",
  write_file: "edit",
  run_command: "command",
  read_terminal: "command",
  remember: "memory",
  forget: "memory",
};

/** The tool group of a built-in tool. MCP tools belong to the `mcp` group. */
export function toolGroup(name: string): ToolGroup {
  return groupOf[name] ?? "mcp";
}

/** Returns the built-in tools that a mode allows. */
export function toolsForMode(
  mode: ModeDefinition,
  options: { memory?: boolean; index?: boolean; skills?: boolean; terminals?: boolean } = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (mode.tools.has("read")) {
    tools.push(...readTools.filter((tool) => tool.name !== "search_code" || options.index !== false));
    tools.push(...interactionTools);
    if (options.skills) tools.push(...skillTools);
  }
  if (mode.tools.has("edit")) tools.push(...changeTools.filter((tool) => tool.name !== "run_command"));
  if (mode.tools.has("command")) {
    tools.push(...changeTools.filter((tool) => tool.name === "run_command"));
    if (options.terminals !== false) tools.push(...terminalTools);
  }
  if (mode.tools.has("memory") && options.memory !== false) tools.push(...memoryTools);
  return tools;
}

export const changeToolNames: ReadonlySet<string> = new Set(changeTools.map((tool) => tool.name));
