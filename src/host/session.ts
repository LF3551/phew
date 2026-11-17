import * as os from "node:os";
import * as vscode from "vscode";
import { type AgentResult, runAgent, type VerificationResult } from "../core/agent";
import { type ChatMessage, trimHistory, truncateMiddle } from "../core/chat";
import { CheckpointStore } from "../core/checkpoints";
import { decideCommand } from "../core/commandPolicy";
import { CostMeter, formatCost, formatTokens } from "../core/cost";
import { type Mode, modeInfo } from "../core/modes";
import { buildSystemPrompt } from "../core/prompts";
import type { ModelProfile } from "../providers/profile";
import type { HostMessage, ViewState } from "../shared/protocol";
import { ApprovalBroker } from "./approvals";
import { ChangeManager, type DiffContentProvider } from "./changes";
import { describeResult, runShellCommand } from "./commandRunner";
import type { McpManager } from "./mcpManager";
import { type ModelManager, providerNames } from "./models";
import { loadRules } from "./rulesLoader";
import { readSettings, type Settings } from "./settings";
import type { StatsStore } from "./statsStore";
import { ToolHost } from "./toolHost";

export interface TaskRequest {
  /** The full request for the model. */
  readonly text: string;
  /** The short text that the chat view shows. Defaults to `text`. */
  readonly display?: string;
  /** `fix` tasks count as fixed bugs when they succeed. */
  readonly kind: "chat" | "fix";
  readonly mode?: Mode;
}

export interface SessionDependencies {
  readonly context: vscode.ExtensionContext;
  readonly log: vscode.LogOutputChannel;
  readonly post: (message: HostMessage) => void;
  readonly diffs: DiffContentProvider;
  readonly mcp: McpManager;
  readonly stats: StatsStore;
  readonly models: ModelManager;
  readonly onBusyChange: (busy: boolean) => void;
}

const maximumHistoryCharacters = 400_000;
const modeKey = "phew.mode";

/** One conversation with the agent in the current window. */
export class AgentSession {
  readonly broker: ApprovalBroker;
  private readonly checkpoints = new CheckpointStore();
  private readonly changes: ChangeManager;
  private history: ChatMessage[] = [];
  private mode: Mode;
  private controller: AbortController | undefined;
  private counter = 0;
  private sessionTokens = 0;
  private sessionCost = 0;

  constructor(private readonly deps: SessionDependencies) {
    this.broker = new ApprovalBroker(deps.post);
    this.changes = new ChangeManager(this.broker, deps.diffs, this.checkpoints);
    const saved = deps.context.workspaceState.get<Mode>(modeKey);
    this.mode = saved && saved in modeInfo ? saved : readSettings().defaultMode;
  }

  get busy(): boolean {
    return this.controller !== undefined;
  }

  get currentMode(): Mode {
    return this.mode;
  }

  async setMode(mode: Mode): Promise<void> {
    this.mode = mode;
    await this.deps.context.workspaceState.update(modeKey, mode);
    this.postState();
  }

  state(): ViewState {
    const settings = readSettings();
    const profile = this.deps.models.active();
    return {
      mode: this.mode,
      model: profile?.name ?? "No model",
      provider: profile ? providerNames[profile.provider] : "Not configured",
      configured: profile !== undefined,
      busy: this.busy,
      trusted: vscode.workspace.isTrusted,
      tokens: formatTokens(this.sessionTokens),
      cost: this.sessionCost > 0 ? formatCost(this.sessionCost) : "",
      celebrate: settings.celebrate,
      stats: this.deps.stats.summary(settings.minutesPerBug),
    };
  }

  postState(): void {
    this.deps.post({ type: "state", state: this.state() });
  }

  stop(): void {
    this.controller?.abort();
    this.broker.cancelAll();
  }

  newChat(): void {
    this.stop();
    this.history = [];
    this.checkpoints.clear();
    this.sessionTokens = 0;
    this.sessionCost = 0;
    this.deps.post({ type: "cleared" });
    this.postState();
  }

  async run(request: TaskRequest): Promise<void> {
    if (this.busy) {
      this.notice("warning", "Phew is still working. Stop the current task or wait until it is done.");
      return;
    }
    const folder = this.workspaceFolder();
    if (!folder) {
      this.notice("warning", "Open a folder first. Phew works inside a workspace folder.");
      return;
    }
    const settings = readSettings();
    const profile = this.deps.models.active();
    if (!profile) {
      this.notice("info", "Add a model first.");
      void vscode.commands.executeCommand("phew.addModel");
      return;
    }
    let mode = request.mode ?? this.mode;
    if (mode === "code" && !vscode.workspace.isTrusted) {
      mode = "ask";
      this.notice("warning", "This workspace is not trusted, so Phew works in Ask mode and changes nothing.");
    }

    const controller = new AbortController();
    this.controller = controller;
    this.deps.onBusyChange(true);
    this.postState();

    const checkpointId = `cp_${Date.now().toString(36)}_${++this.counter}`;
    this.checkpoints.begin(checkpointId, request.display ?? request.text);
    this.deps.post({ type: "user", id: checkpointId, text: request.display ?? request.text, checkpointId });
    this.history.push({ role: "user", content: request.text });

    const meter = new CostMeter(profile.price, settings.budget);
    let result: AgentResult | undefined;
    try {
      result = await this.execute(request, profile, mode, folder, settings, meter, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) result = undefined;
      else {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.error(`Task failed: ${message}`);
        this.notice("error", message);
      }
    } finally {
      this.controller = undefined;
      this.history = trimHistory(this.history, maximumHistoryCharacters);
      this.sessionTokens += meter.tokens;
      this.sessionCost += meter.cost ?? 0;
      this.deps.onBusyChange(false);
    }
    await this.finish(request, result, controller.signal.aborted, meter, settings);
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    if (this.busy) {
      this.notice("warning", "Stop the current task before you restore a checkpoint.");
      return;
    }
    const folder = this.workspaceFolder();
    if (!folder || !this.checkpoints.has(checkpointId)) {
      this.notice("warning", "This checkpoint is no longer available.");
      return;
    }
    const files = this.checkpoints.changedSince(checkpointId);
    if (files.length === 0) {
      this.notice("info", "No files changed after this checkpoint.");
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Restore ${files.length} ${files.length === 1 ? "file" : "files"} to the state before this request?`,
      { modal: true, detail: files.slice(0, 20).join("\n") + (files.length > 20 ? "\n…" : "") },
      "Restore",
    );
    if (answer !== "Restore") return;
    const writes = this.checkpoints.restore(checkpointId);
    await this.changes.restore(folder.uri, writes);
    this.history.push({
      role: "user",
      content: `I restored these files to their state before an earlier request: ${files.join(", ")}. Read them again before you edit them.`,
    });
    this.history.push({ role: "assistant", content: "Understood. I will read the files again before I change them." });
    this.deps.log.info(`[audit] checkpoint restored: ${files.join(", ")}`);
    this.deps.post({ type: "checkpointRestored", checkpointId, files });
  }

  /** Restores the first checkpoint without a confirmation. Only the integration tests use it. */
  async restoreLatestForTest(): Promise<void> {
    const folder = this.workspaceFolder();
    const first = this.checkpoints.list()[0];
    if (!folder || !first) return;
    await this.changes.restore(folder.uri, this.checkpoints.restore(first.id));
  }

  dispose(): void {
    this.stop();
  }

  private workspaceFolder(): vscode.WorkspaceFolder | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.deps.post({ type: "notice", level, text });
  }

  private async execute(
    request: TaskRequest,
    profile: ModelProfile,
    mode: Mode,
    folder: vscode.WorkspaceFolder,
    settings: Settings,
    meter: CostMeter,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const client = await this.deps.models.client(profile);
    const tools = new ToolHost({
      root: folder,
      mode,
      settings,
      broker: this.broker,
      changes: this.changes,
      mcp: this.deps.mcp,
      log: this.deps.log,
    });
    let definitions = await tools.definitions().catch((error: unknown) => {
      this.notice("warning", `MCP tools are not available: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    definitions ??= await new ToolHost({
      root: folder,
      mode,
      settings: { ...settings, mcpServers: {} },
      broker: this.broker,
      changes: this.changes,
      mcp: this.deps.mcp,
      log: this.deps.log,
    }).definitions();
    const systemPrompt = buildSystemPrompt({
      mode,
      workspaceName: folder.name,
      platform: `${os.platform()} ${os.release()}`,
      shell: vscode.env.shell || "default",
      date: new Date().toISOString().slice(0, 10),
      rules: await loadRules(folder),
      verifyCommand: settings.verifyCommand || undefined,
      mcpTools: tools.mcpToolNames,
    });

    let assistantId: string | undefined;
    let toolCounter = 0;
    const toolIds = new Map<string, string>();
    const verify = mode === "code" && settings.verifyCommand ? () => this.verify(settings, folder, signal) : undefined;

    return runAgent({
      client,
      systemPrompt,
      history: this.history,
      tools: definitions,
      executeTool: (call, toolSignal) => tools.execute(call, toolSignal),
      verify,
      maxVerifyAttempts: settings.verifyMaxAttempts,
      requireChanges: mode === "code" && request.kind === "fix",
      maxSteps: settings.maxSteps,
      meter,
      signal,
      events: {
        onText: (delta) => {
          if (!assistantId) {
            assistantId = `a_${++toolCounter}_${Date.now().toString(36)}`;
            this.deps.post({ type: "assistantStart", id: assistantId });
          }
          this.deps.post({ type: "assistantDelta", id: assistantId, text: delta });
        },
        onAssistant: (content) => {
          if (assistantId) this.deps.post({ type: "assistantEnd", id: assistantId, text: content });
          assistantId = undefined;
        },
        onToolStart: (call) => {
          const id = `t_${++toolCounter}_${Date.now().toString(36)}`;
          toolIds.set(call.id, id);
          this.deps.post({ type: "tool", id, name: call.name, summary: ToolHost.summarize(call), status: "running" });
        },
        onToolEnd: (call, toolResult) => {
          const id = toolIds.get(call.id) ?? call.id;
          const failed = toolResult.content.startsWith("Error:");
          this.deps.post({
            type: "tool",
            id,
            name: call.name,
            summary: ToolHost.summarize(call),
            status: failed ? "error" : "done",
            detail: truncateMiddle(toolResult.content, 4000),
          });
        },
        onUsage: () => this.postState(),
        onVerify: (attempt, verification) =>
          this.deps.post({
            type: "verify",
            attempt,
            passed: verification.passed,
            output: truncateMiddle(verification.output, 4000),
          }),
      },
    });
  }

  private async verify(
    settings: Settings,
    folder: vscode.WorkspaceFolder,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    const decision = decideCommand(settings.verifyCommand, { autoApprove: [], deny: settings.commands.deny });
    if (decision.kind === "deny") return { passed: false, output: `The check command is blocked: ${decision.reason}` };
    this.deps.log.info(`[audit] verify: ${settings.verifyCommand}`);
    const result = await runShellCommand(
      settings.verifyCommand,
      folder.uri.fsPath,
      settings.commandTimeoutSeconds,
      signal,
    );
    return {
      passed: result.exitCode === 0 && !result.timedOut,
      output: describeResult(settings.verifyCommand, result),
    };
  }

  private async finish(
    request: TaskRequest,
    result: AgentResult | undefined,
    aborted: boolean,
    meter: CostMeter,
    settings: Settings,
  ): Promise<void> {
    const status = aborted ? "aborted" : (result?.status ?? "error");
    const success = status === "done";
    const filesChanged = this.checkpoints.list().at(-1)?.files.size ?? 0;
    const bugFixed = success && filesChanged > 0 && (request.kind === "fix" || result?.verified === true);
    await this.deps.stats.record({
      success,
      bugFixed,
      filesChanged,
      tokens: meter.tokens,
      cost: meter.cost ?? 0,
    });
    const celebrate = settings.celebrate && success && filesChanged > 0;
    this.deps.post({
      type: "taskEnd",
      status,
      message: aborted ? "Stopped." : result?.message,
      verified: result?.verified === true,
      celebrate,
    });
    this.postState();
    this.deps.log.info(
      `Task ${status}: steps=${result?.steps ?? 0} files=${filesChanged} tokens=${meter.tokens}${meter.cost !== undefined ? ` cost=${formatCost(meter.cost)}` : ""}`,
    );
    if (bugFixed && request.kind === "fix") {
      void vscode.window.setStatusBarMessage("$(check) Phew! Fixed.", 5000);
    }
  }
}
