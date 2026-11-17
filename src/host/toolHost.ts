import * as vscode from "vscode";
import type { ToolResult } from "../core/agent";
import {
  numberArgument,
  parseArguments,
  stringArgument,
  type ToolCall,
  type ToolDefinition,
  truncateMiddle,
} from "../core/chat";
import { decideCommand } from "../core/commandPolicy";
import { detectEol } from "../core/diff";
import type { Mode } from "../core/modes";
import { resolveInside, toRelative } from "../core/paths";
import { isSensitivePath, redactSecrets } from "../core/secrets";
import { changeToolNames, toolsForMode } from "../core/tools";
import type { ApprovalBroker } from "./approvals";
import type { ChangeManager } from "./changes";
import { readWorkspaceText } from "./changes";
import { describeResult, runShellCommand } from "./commandRunner";
import type { McpManager } from "./mcpManager";
import type { Settings } from "./settings";

const maximumToolOutput = 40_000;
const maximumReadLines = 2_000;
const maximumSearchFiles = 3_000;
const maximumSearchResults = 200;

export interface ToolHostOptions {
  readonly root: vscode.WorkspaceFolder;
  readonly mode: Mode;
  readonly settings: Settings;
  readonly broker: ApprovalBroker;
  readonly changes: ChangeManager;
  readonly mcp: McpManager;
  readonly log: vscode.LogOutputChannel;
}

/** Executes the tool calls of the agent inside one workspace folder. */
export class ToolHost {
  private mcpDefinitions: ToolDefinition[] = [];

  constructor(private readonly options: ToolHostOptions) {}

  async definitions(): Promise<ToolDefinition[]> {
    const builtIn = toolsForMode(this.options.mode);
    if (this.options.mode !== "code" || Object.keys(this.options.settings.mcpServers).length === 0) return builtIn;
    const bindings = await this.options.mcp.tools(this.options.settings.mcpServers, this.options.root.uri.fsPath);
    this.mcpDefinitions = bindings.map((binding) => binding.definition);
    return [...builtIn, ...this.mcpDefinitions];
  }

  get mcpToolNames(): string[] {
    return this.mcpDefinitions.map((definition) => definition.name);
  }

  /** Short human-readable summary of a tool call for the chat view. */
  static summarize(call: ToolCall): string {
    let args: Record<string, unknown> = {};
    try {
      args = parseArguments(call);
    } catch {
      return call.name;
    }
    const value = args.path ?? args.pattern ?? args.query ?? args.command;
    return typeof value === "string" ? `${call.name} ${value.slice(0, 120)}` : call.name;
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const args = parseArguments(call);
    if (changeToolNames.has(call.name) && this.options.mode !== "code") {
      throw new Error(`The tool ${call.name} is not available in ${this.options.mode} mode.`);
    }
    if (changeToolNames.has(call.name) && !vscode.workspace.isTrusted) {
      throw new Error("The workspace is not trusted, so Phew cannot change files or run commands.");
    }
    this.options.log.info(`[audit] tool=${call.name} ${ToolHost.summarize(call).slice(call.name.length).trim()}`);
    let result: ToolResult;
    switch (call.name) {
      case "list_files":
        result = await this.listFiles(args);
        break;
      case "read_file":
        result = await this.readFile(args);
        break;
      case "search_text":
        result = await this.searchText(args, signal);
        break;
      case "get_problems":
        result = this.getProblems(args);
        break;
      case "edit_file":
        result = await this.editFile(args, signal);
        break;
      case "write_file":
        result = await this.writeFile(args, signal);
        break;
      case "run_command":
        result = await this.runCommand(args, signal);
        break;
      default:
        result = await this.callMcp(call.name, args, signal);
    }
    const content = this.options.settings.redactSecrets
      ? redactSecrets(result.content)
      : { text: result.content, found: [] };
    if (content.found.length > 0)
      this.options.log.warn(`[audit] redacted ${content.found.join(", ")} from ${call.name}`);
    return { ...result, content: truncateMiddle(content.text, maximumToolOutput) };
  }

  private resolve(input: string, allowSensitive = false): { uri: vscode.Uri; relative: string } {
    const absolute = resolveInside(this.options.root.uri.fsPath, input);
    if (!absolute) throw new Error(`The path "${input}" is outside the workspace.`);
    const relative = toRelative(this.options.root.uri.fsPath, absolute);
    if (!allowSensitive && isSensitivePath(relative, this.options.settings.sensitiveNames)) {
      throw new Error(`Phew does not open "${relative}" because it can contain secrets.`);
    }
    return { uri: vscode.Uri.file(absolute), relative };
  }

  private async listFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = stringArgument(args, "pattern") as string;
    const limit = Math.min(Math.max(1, numberArgument(args, "limit") ?? 200), 1000);
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.options.root, pattern),
      undefined,
      limit,
    );
    const paths = files.map((file) => toRelative(this.options.root.uri.fsPath, file.fsPath)).sort();
    return { content: paths.length > 0 ? paths.join("\n") : "No files match." };
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolResult> {
    const { uri, relative } = this.resolve(stringArgument(args, "path") as string);
    const text = await readWorkspaceText(uri);
    if (text === null) throw new Error(`The file ${relative} does not exist.`);
    if (text.includes("\0")) throw new Error(`The file ${relative} is binary.`);
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(numberArgument(args, "start_line") ?? 1));
    const end = Math.min(lines.length, Math.floor(numberArgument(args, "end_line") ?? start + maximumReadLines - 1));
    if (start > lines.length) return { content: `${relative} has only ${lines.length} lines.` };
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(width)}| ${line}`)
      .join("\n");
    const more =
      end < lines.length ? `\n[Lines ${end + 1}-${lines.length} not shown. Use start_line to read more.]` : "";
    return { content: `${relative} (lines ${start}-${end} of ${lines.length})\n${body}${more}` };
  }

  private async searchText(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const query = stringArgument(args, "query") as string;
    const include = stringArgument(args, "include", false) ?? "**/*";
    let matcher: RegExp;
    try {
      matcher =
        args.is_regex === true ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch {
      throw new Error("The regular expression is not valid.");
    }
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.options.root, include),
      undefined,
      maximumSearchFiles,
    );
    const results: string[] = [];
    for (const file of files) {
      if (signal.aborted || results.length >= maximumSearchResults) break;
      const relative = toRelative(this.options.root.uri.fsPath, file.fsPath);
      if (isSensitivePath(relative, this.options.settings.sensitiveNames)) continue;
      let text: string | null;
      try {
        text = await readWorkspaceText(file);
      } catch {
        continue;
      }
      if (text === null || text.includes("\0") || text.length > 2_000_000) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maximumSearchResults; index++) {
        if (matcher.test(lines[index])) results.push(`${relative}:${index + 1}: ${lines[index].trim().slice(0, 300)}`);
      }
    }
    if (results.length === 0) return { content: "No matches." };
    const limit =
      results.length >= maximumSearchResults ? `\n[Only the first ${maximumSearchResults} matches are shown.]` : "";
    return { content: results.join("\n") + limit };
  }

  private getProblems(args: Record<string, unknown>): ToolResult {
    const path = stringArgument(args, "path", false);
    const entries = path
      ? [[this.resolve(path, true).uri, vscode.languages.getDiagnostics(this.resolve(path, true).uri)] as const]
      : vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diagnostics] of entries) {
      const absolute = resolveInside(this.options.root.uri.fsPath, uri.fsPath);
      if (!absolute) continue;
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
        const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
        const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
        lines.push(
          `${toRelative(this.options.root.uri.fsPath, absolute)}:${diagnostic.range.start.line + 1}: ${severity}${source} ${diagnostic.message}`,
        );
        if (lines.length >= 300) break;
      }
    }
    return { content: lines.length > 0 ? lines.join("\n") : "No errors or warnings." };
  }

  private async editFile(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const { uri, relative } = this.resolve(stringArgument(args, "path") as string);
    const original = await readWorkspaceText(uri);
    if (original === null) throw new Error(`The file ${relative} does not exist. Use write_file to create it.`);
    const eol = detectEol(original);
    const normalize = (text: string) => (eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n"));
    const oldText = normalize(stringArgument(args, "old_text") as string);
    const newText = normalize(stringArgument(args, "new_text") as string);
    if (oldText.length === 0) throw new Error("old_text must not be empty.");
    const first = original.indexOf(oldText);
    if (first < 0) throw new Error(`old_text was not found in ${relative}. Read the file and copy the exact text.`);
    if (original.indexOf(oldText, first + 1) >= 0) {
      throw new Error(`old_text occurs more than once in ${relative}. Add surrounding lines to make it unique.`);
    }
    const newContent = original.slice(0, first) + newText + original.slice(first + oldText.length);
    return this.options.changes.propose({
      uri,
      relativePath: relative,
      newContent,
      requireApproval: this.options.settings.requireEditApproval,
      signal,
    });
  }

  private async writeFile(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const { uri, relative } = this.resolve(stringArgument(args, "path") as string);
    return this.options.changes.propose({
      uri,
      relativePath: relative,
      newContent: stringArgument(args, "content") as string,
      requireApproval: this.options.settings.requireEditApproval,
      signal,
    });
  }

  private async runCommand(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const command = (stringArgument(args, "command") as string).trim();
    const decision = decideCommand(command, this.options.settings.commands);
    if (decision.kind === "deny") throw new Error(decision.reason);
    if (decision.kind === "ask") {
      const answer = await this.options.broker.request(
        { kind: "command", title: "Run command", detail: command, reason: decision.reason },
        signal,
      );
      if (!answer.allowed) {
        this.options.log.info(`[audit] command denied: ${command}`);
        return { content: `The user did not allow the command: ${command}` };
      }
    }
    this.options.log.info(`[audit] command run: ${command}`);
    const result = await runShellCommand(
      command,
      this.options.root.uri.fsPath,
      this.options.settings.commandTimeoutSeconds,
      signal,
    );
    return { content: describeResult(command, result) };
  }

  private async callMcp(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const binding = this.options.mcp.binding(name);
    if (!binding || this.options.mode !== "code") throw new Error(`The tool ${name} does not exist.`);
    if (this.options.settings.mcpRequireApproval) {
      const answer = await this.options.broker.request(
        {
          kind: "mcp",
          title: `Use ${binding.tool} from MCP server ${binding.server}`,
          detail: truncateMiddle(JSON.stringify(args, null, 2), 4000),
        },
        signal,
      );
      if (!answer.allowed) return { content: `The user did not allow the MCP tool ${binding.tool}.` };
    }
    const result = await this.options.mcp.call(binding, args);
    return { content: `${result.isError ? "MCP tool error: " : ""}${result.text || "(no output)"}` };
  }
}
