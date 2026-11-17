import type { ToolDefinition } from "./chat";
import type { Mode } from "./modes";

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
      "Run a shell command in the workspace root and return its exit code and output. Use it for tests, builds, and linters. Do not start servers that do not stop.",
    parameters: object({ command: { type: "string", description: "The command to run." } }, ["command"]),
  },
];

/** Returns the built-in tools that a mode allows. */
export function toolsForMode(mode: Mode): ToolDefinition[] {
  return mode === "code" ? [...readTools, ...changeTools] : [...readTools];
}

export const changeToolNames: ReadonlySet<string> = new Set(changeTools.map((tool) => tool.name));
