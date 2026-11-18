import * as os from "node:os";
import * as path from "node:path";
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
import { formatHits } from "../core/codeIndex";
import { allowPrefix, decideCommand, whyAllowed } from "../core/commandPolicy";
import { describeShellResult } from "../core/commandResult";
import { adjustAgentGitCommand, describeCommitIdentity } from "../core/commit";
import { detectEol } from "../core/diff";
import { LineEditor } from "../core/lineEditor";
import type { ModeDefinition } from "../core/modes";
import { limitForModel } from "../core/outputLimit";
import { type Plan, parsePlanUpdate, parseQuestion } from "../core/plan";
import type { RootSet } from "../core/roots";
import { isSensitivePath, redactSecrets } from "../core/secrets";
import { toolGroup, toolsForMode } from "../core/tools";
import { type AgentTerminal, toTerminal } from "./agentTerminal";
import type { ApprovalBroker } from "./approvals";
import type { ChangeManager } from "./changes";
import { readWorkspaceText } from "./changes";
import type { CodeIndexManager } from "./codeIndexManager";
import { describeResult, runShellCommand } from "./commandRunner";
import { git, gitIdentity } from "./git";
import type { McpManager } from "./mcpManager";
import type { MemoryStore } from "./memoryStore";
import type { Settings } from "./settings";
import type { ShellRegistry } from "./shellRegistry";
import type { SkillStore } from "./skillStore";

const maximumToolOutput = 40_000;
const maximumReadLines = 2_000;
const maximumSearchFiles = 3_000;
const maximumSearchResults = 200;

/** The folder where a session works: a workspace folder or a Git worktree. */
export interface SessionRoot {
  readonly uri: vscode.Uri;
  readonly name: string;
}

export interface ToolHostOptions {
  readonly root: SessionRoot;
  readonly roots: RootSet;
  readonly skills: SkillStore;
  readonly plan: { get(): Plan; set(plan: Plan): void };
  readonly mode: ModeDefinition;
  readonly settings: Settings;
  readonly broker: ApprovalBroker;
  /** The terminal of the chat, which mirrors the commands while they run (when no real shell is available). */
  readonly terminal?: AgentTerminal;
  /** The terminals of the chat (real shells), like the terminals of the Copilot agent. */
  readonly shells?: ShellRegistry;
  /** Where a command runs, for the chat: a real terminal or the background. */
  readonly onCommandStart?: (
    callId: string,
    where: "terminal" | "background",
    terminal?: string,
    approval?: string,
  ) => void;
  /** The folder of the chat's shell. `cd` in one command carries over to the next, like in Claude Code. */
  readonly shell?: { cwd?: string; envFile?: string };
  /** Live output of a running command, by the id of the tool call. */
  readonly onCommandOutput?: (callId: string, text: string) => void;
  readonly changes: ChangeManager;
  readonly mcp: McpManager;
  readonly index: CodeIndexManager;
  readonly memory: MemoryStore;
  readonly log: vscode.LogOutputChannel;
}

/** Executes the tool calls of the agent inside one root folder. */
export class ToolHost {
  private mcpDefinitions: ToolDefinition[] = [];

  constructor(private readonly options: ToolHostOptions) {}

  private get rootPath(): string {
    return this.options.roots.primary.path;
  }

  private get rootUris(): vscode.Uri[] {
    return this.options.roots.roots.map((root) => vscode.Uri.file(root.path));
  }

  async definitions(): Promise<ToolDefinition[]> {
    const { mode, settings } = this.options;
    const skills = settings.skillsEnabled ? await this.options.skills.list(this.rootUris) : [];
    const builtIn = toolsForMode(mode, {
      memory: settings.memoryEnabled,
      index: settings.index.enabled,
      skills: skills.length > 0,
      // read_terminal needs the real terminals of the chat.
      terminals: settings.commandsTerminal !== "off" && this.options.shells !== undefined,
    });
    if (!mode.tools.has("mcp") || !vscode.workspace.isTrusted) return builtIn;
    try {
      const bindings = await this.options.mcp.tools(this.options.root.uri);
      this.mcpDefinitions = bindings.map((binding) => binding.definition);
    } catch (error) {
      this.options.log.warn(`MCP tools are not available: ${error instanceof Error ? error.message : String(error)}`);
      this.mcpDefinitions = [];
    }
    return [...builtIn, ...this.mcpDefinitions];
  }

  get mcpToolNames(): string[] {
    return this.mcpDefinitions.map((definition) => definition.name);
  }

  /** The full command of a run_command call, for the terminal in the chat. */
  static commandOf(call: ToolCall): string | undefined {
    if (call.name !== "run_command") return undefined;
    try {
      const args = parseArguments(call);
      return typeof args.command === "string" ? args.command.slice(0, 10_000) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The plain-words description of a run_command call, for the user. */
  static descriptionOf(call: ToolCall): string | undefined {
    if (call.name !== "run_command") return undefined;
    try {
      const value = parseArguments(call).description;
      return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Short human-readable summary of a tool call for the chat view. */
  static summarize(call: ToolCall): string {
    let args: Record<string, unknown> = {};
    try {
      args = parseArguments(call);
    } catch {
      return call.name;
    }
    const value =
      args.path ?? args.pattern ?? args.query ?? args.command ?? args.note ?? args.question ?? args.name ?? args.goal;
    return typeof value === "string" ? `${call.name} ${value.slice(0, 120)}` : call.name;
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const args = parseArguments(call);
    const group = toolGroup(call.name);
    if (!this.options.mode.tools.has(group)) {
      throw new Error(`The tool ${call.name} is not available in ${this.options.mode.name} mode.`);
    }
    if ((group === "edit" || group === "command" || group === "mcp") && !vscode.workspace.isTrusted) {
      throw new Error("The workspace is not trusted, so Phew cannot change files, run commands, or use MCP tools.");
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
      case "search_code":
        result = await this.searchCode(args, signal);
        break;
      case "git_diff":
        result = await this.gitDiff(args);
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
        result = await this.runCommand(args, signal, call.id);
        break;
      case "read_terminal":
        result = await this.readTerminal(args, signal);
        break;
      case "remember":
        result = await this.remember(args);
        break;
      case "ask_user":
        result = await this.askUser(args, signal);
        break;
      case "update_plan":
        this.options.plan.set(parsePlanUpdate(args, this.options.plan.get()));
        result = { content: "The checklist is updated." };
        break;
      case "load_skill":
        result = { content: await this.options.skills.load(this.rootUris, stringArgument(args, "name") as string) };
        break;
      case "read_skill_file":
        result = {
          content: await this.options.skills.readFile(
            this.rootUris,
            stringArgument(args, "name") as string,
            stringArgument(args, "path") as string,
          ),
        };
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
    const absolute = this.options.roots.resolve(input);
    if (!absolute) throw new Error(`The path "${input}" is outside the workspace.`);
    const relative = this.options.roots.display(absolute);
    if (!allowSensitive && isSensitivePath(relative, this.options.settings.sensitiveNames)) {
      throw new Error(`Phew does not open "${relative}" because it can contain secrets.`);
    }
    return { uri: vscode.Uri.file(absolute), relative };
  }

  private async listFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = stringArgument(args, "pattern") as string;
    const limit = Math.min(Math.max(1, numberArgument(args, "limit") ?? 200), 1000);
    const files = (
      await Promise.all(
        this.rootUris.map((root) =>
          vscode.workspace.findFiles(new vscode.RelativePattern(root, pattern), undefined, limit),
        ),
      )
    ).flat();
    const paths = files
      .map((file) => this.options.roots.display(file.fsPath))
      .sort()
      .slice(0, limit);
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
    const files = (
      await Promise.all(
        this.rootUris.map((root) =>
          vscode.workspace.findFiles(
            new vscode.RelativePattern(root, include),
            "**/{node_modules,.git,dist,out,build,coverage}/**",
            maximumSearchFiles,
          ),
        ),
      )
    ).flat();
    const results: string[] = [];
    for (const file of files) {
      if (signal.aborted || results.length >= maximumSearchResults) break;
      const relative = this.options.roots.display(file.fsPath);
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

  private async searchCode(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const query = stringArgument(args, "query") as string;
    const limit = Math.min(Math.max(1, numberArgument(args, "limit") ?? 8), 20);
    const all = (
      await Promise.all(
        this.rootUris.map(async (root) =>
          (
            await this.options.index.search(root, query, limit, signal)
          ).map((hit) => ({ ...hit, path: this.options.roots.display(hit.path) })),
        ),
      )
    ).flat();
    return { content: formatHits(all.sort((a, b) => b.score - a.score).slice(0, limit)) };
  }

  private async gitDiff(args: Record<string, unknown>): Promise<ToolResult> {
    const path = stringArgument(args, "path", false);
    const target = path ? this.resolve(path).uri.fsPath : undefined;
    const cwd = target ? (this.options.roots.rootOf(target)?.path ?? this.rootPath) : this.rootPath;
    const extra = target ? ["--", target] : [];
    const result = await git(cwd, [
      "diff",
      ...(args.staged === true ? ["--cached"] : ["HEAD"]),
      "--no-color",
      "--no-ext-diff",
      ...extra,
    ]);
    if (result.code !== 0) return { content: `git diff failed: ${result.stderr.trim() || "not a Git repository"}` };
    const status = await git(cwd, ["status", "--short"]);
    return {
      content: `${status.stdout.trim() ? `Status:\n${status.stdout.trim()}\n\n` : ""}${result.stdout.trim() || "No changes."}`,
    };
  }

  private getProblems(args: Record<string, unknown>): ToolResult {
    const path = stringArgument(args, "path", false);
    const target = path ? this.resolve(path, true).uri : undefined;
    const entries: (readonly [vscode.Uri, readonly vscode.Diagnostic[]])[] = target
      ? [[target, vscode.languages.getDiagnostics(target)]]
      : vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diagnostics] of entries) {
      if (!this.options.roots.rootOf(uri.fsPath)) continue;
      const absolute = uri.fsPath;
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
        const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
        const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
        lines.push(
          `${this.options.roots.display(absolute)}:${diagnostic.range.start.line + 1}: ${severity}${source} ${diagnostic.message}`,
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
      reviewMode: this.options.settings.reviewMode,
      signal,
    });
  }

  private async writeFile(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const { uri, relative } = this.resolve(stringArgument(args, "path") as string);
    return this.options.changes.propose({
      uri,
      relativePath: relative,
      newContent: stringArgument(args, "content") as string,
      reviewMode: this.options.settings.reviewMode,
      signal,
    });
  }

  /** New output of a terminal where a program keeps running, and waiting for a text in it. */
  private async readTerminal(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const shells = this.options.settings.commandsTerminal !== "off" ? this.options.shells : undefined;
    if (!shells) return { content: "The commands of this chat run in processes, so there is no terminal to read." };
    const name = stringArgument(args, "terminal", false)?.trim() || "1";
    const session = shells.get(name.replace(/^#/, ""));
    if (!session) {
      const known = shells.list().map((terminal) => terminal.id);
      throw new Error(`There is no terminal "${name}". The terminals of this chat: ${known.join(", ") || "none"}.`);
    }
    const waitFor = stringArgument(args, "wait_for", false)?.trim();
    const seconds = Math.min(600, Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : 30));
    const pattern = waitFor ? new RegExp(waitFor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : undefined;
    const read = await session.readNew({ pattern, timeoutMs: seconds * 1000, signal });
    const state =
      read.state === "ended"
        ? `the program ended${read.exitCode !== undefined ? ` with exit code ${read.exitCode}` : ""}`
        : read.state === "idle"
          ? "nothing runs, the shell waits for a command"
          : read.state === "waiting"
            ? "a program waits for input"
            : read.state === "closed"
              ? "the terminal was closed"
              : "a program keeps running";
    const found = waitFor
      ? read.matched
        ? `Found "${waitFor}". `
        : `"${waitFor}" did not appear in ${seconds} s. `
      : "";
    return {
      content: `[terminal ${name}: ${state}] ${found}\n${limitForModel(read.output) || "(no new output)"}`,
    };
  }

  private readonly runningCommands = new Map<string, AbortController>();
  private readonly commandInputs = new Map<string, LineEditor>();

  /** Keys typed in a terminal of the chat for a running command. */
  commandInput(callId: string, data: string): void {
    const shellSession = this.options.settings.commandsTerminal !== "off" ? this.options.shells?.main : undefined;
    if (shellSession) shellSession.userInput(data);
    else this.commandInputs.get(callId)?.feed(data);
  }

  /** Stops one running command. The agent goes on and sees that the command was cancelled. */
  stopCommand(callId: string): boolean {
    const controller = this.runningCommands.get(callId);
    controller?.abort();
    return controller !== undefined;
  }

  private async runCommand(args: Record<string, unknown>, signal: AbortSignal, callId = ""): Promise<ToolResult> {
    const requested = (stringArgument(args, "command") as string).trim();
    const interrupt = args.interrupt === true;
    const background = args.background === true;
    const shells = this.options.settings.commandsTerminal !== "off" ? this.options.shells : undefined;
    const picked = shells?.pick(stringArgument(args, "terminal", false));
    const shellSession = picked?.session;
    if (!requested) {
      if (!interrupt) throw new Error("The command is empty.");
      shellSession?.interrupt();
      return { content: `Phew pressed Ctrl+C in terminal ${picked?.id ?? 1} of the chat.` };
    }
    const folder = stringArgument(args, "cwd", false);
    const shellCwd = this.options.shell?.cwd;
    const remembered = shellCwd && this.options.roots.resolve(shellCwd) ? shellCwd : undefined;
    const cwd = folder ? this.options.roots.resolve(folder) : (remembered ?? this.rootPath);
    if (!cwd) throw new Error(`The folder "${folder}" is outside the workspace.`);
    const { command, notes } = adjustAgentGitCommand(requested, this.options.settings.commit);
    const decision = decideCommand(command, this.options.settings.commands);
    if (decision.kind === "deny") throw new Error(decision.reason);
    const isCommit = notes.length > 0 || /^\s*git\s+(-[Cc]\s+\S+\s+)*commit\b/.test(command);
    // Why it runs, for the chat: the rule that allowed it, or the decision of the user.
    let approval =
      decision.kind === "allow" && !isCommit
        ? `Auto-approved: ${whyAllowed(command, this.options.settings.commands)}`
        : "";
    if (decision.kind === "ask" || isCommit) {
      // Dangerous commands always ask, so they get no "Always allow".
      const always =
        decision.kind === "ask" && decision.reason?.startsWith("Dangerous") ? undefined : allowPrefix(command);
      const identity = isCommit ? describeCommitIdentity(this.options.settings.commit, await gitIdentity(cwd)) : "";
      const answer = await this.options.broker.request(
        {
          kind: "command",
          title: isCommit ? "Commit with Git" : "Run command",
          detail: folder ? `${command}\n(in ${this.options.roots.display(cwd)})` : command,
          reason: [decision.kind === "ask" ? decision.reason : undefined, identity, ...notes].filter(Boolean).join(" "),
          ...(always && !isCommit ? { alwaysAllow: always } : {}),
        },
        signal,
      );
      if (!answer.allowed) {
        this.options.log.info(`[audit] command denied: ${command}`);
        return { content: `The user did not allow the command: ${command}` };
      }
      // "Always allow" adds the prefix to the allowlist in the user settings.
      approval = answer.answer === "always" && always ? `Always allowed: ${always}` : "Approved by you";
      if (answer.answer === "always" && always) {
        const config = vscode.workspace.getConfiguration("phew");
        const current = config.get<string[]>("commands.autoApprove") ?? [];
        if (!current.includes(always))
          await config.update("commands.autoApprove", [...current, always], vscode.ConfigurationTarget.Global);
        this.options.log.info(`[audit] always allowed: ${always}`);
      }
    }
    this.options.log.info(`[audit] command run: ${command}`);
    const own = new AbortController();
    const onAbort = () => own.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.runningCommands.set(callId, own);
    if (shellSession) {
      // Like the Copilot agent: the command runs in the real shell of the chat, which the user sees and can type into.
      try {
        this.options.onCommandStart?.(callId, "terminal", picked?.id, approval);
        if (interrupt) shellSession.interrupt();
        const timeoutSeconds = this.options.settings.commandTimeoutSeconds;
        const line = folder
          ? process.platform === "win32"
            ? `Push-Location ${shellQuote(cwd)}; ${command}; Pop-Location`
            : `(cd ${shellQuote(cwd)} && ${command})`
          : command;
        const outcome = await shellSession.run(line, {
          timeoutMs: timeoutSeconds * 1000,
          signal: own.signal,
          onOutput: (text) => this.options.onCommandOutput?.(callId, text),
          background,
          reveal: this.options.settings.commandsTerminal === "open",
        });
        if (outcome.state === "busy")
          throw new Error(
            "The terminal of the chat runs a command that the user started. Wait for it, or ask the user.",
          );
        let note = "";
        if (outcome.cwd && this.options.shell && outcome.cwd !== this.options.shell.cwd) {
          this.options.shell.cwd = outcome.cwd;
          note = `\nThe shell is now in ${this.options.roots.resolve(outcome.cwd) ? this.options.roots.display(outcome.cwd) : outcome.cwd}.`;
        }
        const prefix = notes.length > 0 ? `${notes.join(" ")}\n` : "";
        // With several terminals the model learns which one ran the command and what the others do.
        const where = shells && shells.size > 1 ? `\nRan in terminal ${picked?.id}. ${shells.summary()}` : "";
        return { content: prefix + describeShellResult(command, outcome, timeoutSeconds) + note + where };
      } finally {
        this.runningCommands.delete(callId);
        signal.removeEventListener("abort", onAbort);
      }
    }
    let result: Awaited<ReturnType<typeof runShellCommand>>;
    try {
      const timeout = this.options.settings.commandTimeoutSeconds;
      // Like the Copilot agent: the terminal in the chat and the terminal in the panel show the same output,
      // in color, and typing in either one goes to the command through one input line.
      const mode = this.options.settings.commandsTerminal;
      const terminal = mode !== "off" ? this.options.terminal : undefined;
      const show = (text: string) => {
        terminal?.output(text);
        this.options.onCommandOutput?.(callId, text);
      };
      let input: { write(text: string): void; end(): void } | undefined;
      const line = new LineEditor({
        echo: show,
        submit: (text) => input?.write(text),
        interrupt: () => own.abort(),
        endOfInput: () => input?.end(),
      });
      this.commandInputs.set(callId, line);
      terminal?.start(
        command,
        // The full folder, with ~ for the home folder, like a shell prompt.
        os.homedir() && cwd.startsWith(os.homedir()) ? `~${cwd.slice(os.homedir().length)}` : cwd,
        (data) => line.feed(data),
        mode === "open",
      );
      this.options.onCommandStart?.(callId, terminal ? "terminal" : "background", undefined, approval);
      const started = Date.now();
      result = await runShellCommand(command, cwd, timeout, own.signal, undefined, {
        envFile: this.options.shell?.envFile,
        onRaw: (text) => show(toTerminal(text)),
        onInput: (handle) => {
          input = handle;
        },
      });
      if (terminal) {
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const label = result.cancelled ? "stopped" : result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`;
        terminal.finish(`${label} · ${seconds} s`, result.exitCode === 0 && !result.cancelled && !result.timedOut);
      }
    } finally {
      this.runningCommands.delete(callId);
      this.commandInputs.delete(callId);
      signal.removeEventListener("abort", onAbort);
    }
    // The next command starts where this one ended, inside the workspace only.
    let cwdNote = "";
    if (this.options.shell && result.cwd && !folder && path.resolve(result.cwd) !== path.resolve(cwd)) {
      if (this.options.roots.resolve(result.cwd)) {
        this.options.shell.cwd = result.cwd;
        cwdNote = `\nThe shell is now in ${this.options.roots.display(result.cwd)}.`;
      } else cwdNote = `\nThe shell stays in ${this.options.roots.display(cwd)}: Phew keeps it inside the workspace.`;
    }
    if (result.cancelled && !signal.aborted) {
      const prefix = notes.length > 0 ? `${notes.join(" ")}\n` : "";
      return {
        content: `${prefix}${describeResult(command, result)}\nThe user stopped this command. Do not run it again unless the user asks.`,
      };
    }
    const prefix = notes.length > 0 ? `${notes.join(" ")}\n` : "";
    return { content: prefix + describeResult(command, result) + cwdNote };
  }

  private async askUser(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const question = parseQuestion(args);
    const answer = await this.options.broker.request(
      {
        kind: "question",
        title: question.question,
        detail: "",
        options: question.options,
        allowText: question.allowText,
      },
      signal,
    );
    if (!answer.allowed)
      return { content: "The user skipped the question. Make a reasonable choice and say which one." };
    return { content: `The user answered: ${answer.answer ?? ""}` };
  }

  private async remember(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.options.settings.memoryEnabled) return { content: "The project memory is turned off." };
    if (!vscode.workspace.isTrusted)
      return { content: "The workspace is not trusted, so Phew does not write the memory." };
    const note = stringArgument(args, "note") as string;
    const added = await this.options.memory.add(this.options.root.uri, note);
    this.options.log.info(`[audit] memory ${added ? "added" : "skipped"}: ${note.slice(0, 120)}`);
    return {
      content: added ? "Saved to the project memory." : "The memory already has this note, or the note is empty.",
    };
  }

  private async callMcp(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const binding = this.options.mcp.binding(name);
    if (!binding) throw new Error(`The tool ${name} does not exist.`);
    if (!this.options.settings.mcpAutoApprove) {
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

/** Quotes a path for the shell of the terminal: single quotes, which POSIX shells and PowerShell both read. */
function shellQuote(value: string): string {
  return process.platform === "win32" ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}
