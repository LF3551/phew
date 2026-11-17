import * as os from "node:os";
import * as vscode from "vscode";
import { type AgentResult, runAgent, type VerificationResult } from "../core/agent";
import type { Attachment } from "../core/attachments";
import { type ChatMessage, trimHistory, truncateMiddle } from "../core/chat";
import { CheckpointStore } from "../core/checkpoints";
import { decideCommand } from "../core/commandPolicy";
import { CostMeter, formatCost, formatTokens } from "../core/cost";
import { titleFromText } from "../core/export";
import { canChange, findMode, type Mode, type ModeDefinition } from "../core/modes";
import { buildSystemPrompt } from "../core/prompts";
import type { ModelProfile } from "../providers/profile";
import type { HostMessage } from "../shared/protocol";
import { ApprovalBroker } from "./approvals";
import { resolveAttachments } from "./attachments";
import { ChangeManager, type DiffContentProvider } from "./changes";
import type { CodeIndexManager } from "./codeIndexManager";
import { describeResult, runShellCommand } from "./commandRunner";
import type { StoredConversation } from "./conversationStore";
import type { McpManager } from "./mcpManager";
import type { MemoryStore } from "./memoryStore";
import type { ModelManager } from "./models";
import type { ReviewManager } from "./reviewManager";
import { loadRules } from "./rulesLoader";
import { readSettings, type Settings } from "./settings";
import type { StatsStore } from "./statsStore";
import type { TerminalWatcher } from "./terminalWatcher";
import { type SessionRoot, ToolHost } from "./toolHost";

export interface TaskRequest {
  /** The request for the model. */
  readonly text: string;
  /** The short text that the chat view shows. Defaults to `text`. */
  readonly display?: string;
  /** `fix` tasks count as fixed bugs when they succeed. */
  readonly kind: "chat" | "fix";
  readonly mode?: Mode;
  readonly attachments?: readonly Attachment[];
}

export interface SessionDependencies {
  readonly context: vscode.ExtensionContext;
  readonly log: vscode.LogOutputChannel;
  readonly diffs: DiffContentProvider;
  readonly mcp: McpManager;
  readonly stats: StatsStore;
  readonly models: ModelManager;
  readonly reviews: ReviewManager;
  readonly index: CodeIndexManager;
  readonly memory: MemoryStore;
  readonly terminal: TerminalWatcher;
  readonly modes: () => readonly ModeDefinition[];
  /** Delivers a message of this session to the view, when the session is visible. */
  readonly emit: (session: AgentSession, message: HostMessage) => void;
  readonly onChange: (session: AgentSession) => void;
  readonly persist: (session: AgentSession) => Promise<void>;
}

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly repository: string;
}

const maximumHistoryCharacters = 400_000;
const maximumTranscript = 3_000;

/**
 * Keeps the chat messages so that the view can rebuild itself after VS Code disposes a hidden webview,
 * after a switch between sessions, and after a restart. Streaming deltas are replaced by the final message.
 */
export class Transcript {
  private items: HostMessage[] = [];

  constructor(initial: readonly HostMessage[] = []) {
    this.items = [...initial];
  }

  add(message: HostMessage): void {
    if (message.type === "state" || message.type === "sessions" || message.type === "mentions") return;
    if (message.type === "addAttachment" || message.type === "focusInput" || message.type === "openPanel") return;
    if (message.type === "cleared") {
      this.items = [];
      return;
    }
    if (message.type === "assistantEnd") {
      this.items = this.items.filter(
        (item) => !((item.type === "assistantDelta" || item.type === "assistantStart") && item.id === message.id),
      );
    }
    this.items.push(message);
    if (this.items.length > maximumTranscript) this.items.splice(0, this.items.length - maximumTranscript);
  }

  all(): readonly HostMessage[] {
    return this.items;
  }

  /** The transcript for saving: open approvals are marked as cancelled because they cannot survive a restart. */
  persistable(): HostMessage[] {
    const resolved = new Set(this.items.filter((item) => item.type === "approvalResolved").map((item) => item.id));
    const result: HostMessage[] = [];
    for (const item of this.items) {
      if (item.type === "assistantStart" || item.type === "assistantDelta") continue;
      result.push(item);
      if (item.type === "approval" && !resolved.has(item.id)) {
        result.push({ type: "approvalResolved", id: item.id, decision: "cancelled" });
      }
    }
    return result;
  }
}

/** One conversation with the agent in a root folder. */
export class AgentSession {
  readonly broker: ApprovalBroker;
  readonly transcript: Transcript;
  readonly createdAt: number;
  private checkpoints: CheckpointStore;
  private readonly changes: ChangeManager;
  private history: ChatMessage[];
  private modeId: Mode;
  private controller: AbortController | undefined;
  private counter = 0;
  private sessionTokens: number;
  private sessionCost: number;
  private pendingApprovals = 0;
  title: string;
  updatedAt: number;

  constructor(
    private readonly deps: SessionDependencies,
    readonly id: string,
    readonly root: SessionRoot,
    readonly worktree?: WorktreeInfo,
    restored?: StoredConversation,
  ) {
    this.transcript = new Transcript(restored?.transcript);
    this.broker = new ApprovalBroker((message) => {
      if (message.type === "approval") this.pendingApprovals++;
      if (message.type === "approvalResolved") this.pendingApprovals = Math.max(0, this.pendingApprovals - 1);
      this.emit(message);
    });
    this.checkpoints = restored ? CheckpointStore.fromJSON(restored.checkpoints) : new CheckpointStore();
    this.changes = new ChangeManager(this.broker, deps.diffs, this.checkpoints, deps.reviews);
    this.history = restored ? [...restored.history] : [];
    this.modeId = restored?.mode ?? readSettings(root.uri).defaultMode;
    this.title = restored?.title ?? (worktree ? `Agent: ${worktree.branch}` : "New chat");
    this.createdAt = restored?.createdAt ?? Date.now();
    this.updatedAt = restored?.updatedAt ?? this.createdAt;
    this.sessionTokens = restored?.tokens ?? 0;
    this.sessionCost = restored?.cost ?? 0;
  }

  get busy(): boolean {
    return this.controller !== undefined;
  }

  get needsApproval(): boolean {
    return this.pendingApprovals > 0;
  }

  get isEmpty(): boolean {
    return this.history.length === 0;
  }

  get mode(): ModeDefinition {
    return findMode(this.modeId, this.deps.modes());
  }

  get usage(): { tokens: string; cost: string } {
    return { tokens: formatTokens(this.sessionTokens), cost: this.sessionCost > 0 ? formatCost(this.sessionCost) : "" };
  }

  get conversation(): readonly ChatMessage[] {
    return this.history;
  }

  setMode(id: Mode): void {
    this.modeId = findMode(id, this.deps.modes()).id;
    this.deps.onChange(this);
  }

  toStored(): StoredConversation {
    return {
      version: 1,
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      mode: this.modeId,
      root: this.root.uri.fsPath,
      ...(this.worktree ? { worktree: this.worktree } : {}),
      history: this.history,
      transcript: this.transcript.persistable(),
      checkpoints: this.checkpoints.toJSON(),
      tokens: this.sessionTokens,
      cost: this.sessionCost,
    };
  }

  stop(): void {
    this.controller?.abort();
    this.broker.cancelAll();
  }

  /** The model profile of this session: the profile of the mode, or the active profile. */
  private profile(): ModelProfile | undefined {
    const modeModel = this.mode.model;
    const profiles = this.deps.models.profiles().profiles;
    return (modeModel && profiles.find((profile) => profile.id === modeModel)) || this.deps.models.active();
  }

  async run(request: TaskRequest): Promise<void> {
    if (this.busy) {
      this.notice("warning", "Phew is still working. Stop the current task or wait until it is done.");
      return;
    }
    const settings = readSettings(this.root.uri);
    const profile = this.profile();
    if (!profile) {
      this.notice("info", "Add a model first.");
      void vscode.commands.executeCommand("phew.addModel");
      return;
    }
    if (request.mode) this.modeId = findMode(request.mode, this.deps.modes()).id;
    let mode = this.mode;
    if (canChange(mode) && !vscode.workspace.isTrusted) {
      mode = findMode("ask", this.deps.modes());
      this.notice("warning", "This workspace is not trusted, so Phew works in Ask mode and changes nothing.");
    }

    const controller = new AbortController();
    this.controller = controller;
    this.deps.onChange(this);

    const resolved = await resolveAttachments(request.attachments ?? [], this.root.uri, settings, this.deps.terminal);
    for (const warning of resolved.warnings) this.notice("warning", warning);
    const checkpointId = `cp_${Date.now().toString(36)}_${++this.counter}`;
    this.checkpoints.begin(checkpointId, request.display ?? request.text);
    if (this.history.length === 0) this.title = titleFromText(request.display ?? request.text);
    this.emit({
      type: "user",
      id: checkpointId,
      text: request.display ?? request.text,
      checkpointId,
      ...(resolved.labels.length > 0 ? { attachments: resolved.labels } : {}),
    });
    const content = [request.text, resolved.context].filter(Boolean).join("\n\n");
    this.history.push({ role: "user", content, ...(resolved.images.length > 0 ? { images: resolved.images } : {}) });

    const meter = new CostMeter(profile.price, settings.budget);
    let result: AgentResult | undefined;
    try {
      result = await this.execute(request, profile, mode, settings, meter, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.error(`Task failed: ${message}`);
        this.notice("error", message);
      }
    } finally {
      this.controller = undefined;
      this.history = trimHistory(this.history, maximumHistoryCharacters);
      this.sessionTokens += meter.tokens;
      this.sessionCost += meter.cost ?? 0;
      this.updatedAt = Date.now();
    }
    await this.finish(request, result, controller.signal.aborted, meter, settings);
    this.deps.onChange(this);
    await this.deps
      .persist(this)
      .catch((error: unknown) => this.deps.log.warn(`Could not save the chat: ${String(error)}`));
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    if (this.busy) {
      this.notice("warning", "Stop the current task before you restore a checkpoint.");
      return;
    }
    if (!this.checkpoints.has(checkpointId)) {
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
    await this.restore(checkpointId, files);
  }

  /** Restores the first checkpoint without a confirmation. Only the integration tests use it. */
  async restoreFirstForTest(): Promise<void> {
    const first = this.checkpoints.list()[0];
    if (first) await this.restore(first.id, this.checkpoints.changedSince(first.id));
  }

  dispose(): void {
    this.stop();
  }

  private async restore(checkpointId: string, files: string[]): Promise<void> {
    const writes = this.checkpoints.restore(checkpointId);
    await this.changes.restore(this.root.uri, writes);
    this.history.push({
      role: "user",
      content: `I restored these files to their state before an earlier request: ${files.join(", ")}. Read them again before you edit them.`,
    });
    this.history.push({ role: "assistant", content: "Understood. I will read the files again before I change them." });
    this.deps.log.info(`[audit] checkpoint restored: ${files.join(", ")}`);
    this.emit({ type: "checkpointRestored", checkpointId, files });
    await this.deps.persist(this);
  }

  private emit(message: HostMessage): void {
    this.transcript.add(message);
    this.deps.emit(this, message);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.emit({ type: "notice", level, text });
  }

  private async execute(
    request: TaskRequest,
    profile: ModelProfile,
    mode: ModeDefinition,
    settings: Settings,
    meter: CostMeter,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const client = await this.deps.models.client(profile);
    const tools = new ToolHost({
      root: this.root,
      mode,
      settings,
      broker: this.broker,
      changes: this.changes,
      mcp: this.deps.mcp,
      index: this.deps.index,
      memory: this.deps.memory,
      log: this.deps.log,
    });
    const definitions = await tools.definitions();
    const memory = settings.memoryEnabled ? await this.deps.memory.read(this.root.uri) : [];
    const systemPrompt = buildSystemPrompt({
      mode,
      workspaceName: this.worktree ? `${this.root.name} (worktree on branch ${this.worktree.branch})` : this.root.name,
      platform: `${os.platform()} ${os.release()}`,
      shell: vscode.env.shell || "default",
      date: new Date().toISOString().slice(0, 10),
      rules: await loadRules(this.root.uri),
      verifyCommand: settings.verifyCommand || undefined,
      mcpTools: tools.mcpToolNames,
      memory: memory.map((note) => `- ${note}`).join("\n"),
    });

    let assistantId: string | undefined;
    let counter = 0;
    const toolIds = new Map<string, string>();
    const verify = mode.tools.has("edit") && settings.verifyCommand ? () => this.verify(settings, signal) : undefined;

    return runAgent({
      client,
      systemPrompt,
      history: this.history,
      tools: definitions,
      executeTool: (call, toolSignal) => tools.execute(call, toolSignal),
      verify,
      maxVerifyAttempts: settings.verifyMaxAttempts,
      requireChanges: mode.tools.has("edit") && request.kind === "fix",
      maxSteps: settings.maxSteps,
      meter,
      signal,
      events: {
        onText: (delta) => {
          if (!assistantId) {
            assistantId = `a_${++counter}_${Date.now().toString(36)}`;
            this.emit({ type: "assistantStart", id: assistantId });
          }
          this.emit({ type: "assistantDelta", id: assistantId, text: delta });
        },
        onAssistant: (content) => {
          if (assistantId) this.emit({ type: "assistantEnd", id: assistantId, text: content });
          assistantId = undefined;
        },
        onToolStart: (call) => {
          const id = `t_${++counter}_${Date.now().toString(36)}`;
          toolIds.set(call.id, id);
          this.emit({ type: "tool", id, name: call.name, summary: ToolHost.summarize(call), status: "running" });
        },
        onToolEnd: (call, toolResult) => {
          const id = toolIds.get(call.id) ?? call.id;
          this.emit({
            type: "tool",
            id,
            name: call.name,
            summary: ToolHost.summarize(call),
            status: toolResult.content.startsWith("Error:") ? "error" : "done",
            detail: truncateMiddle(toolResult.content, 4000),
          });
        },
        onUsage: () => this.deps.onChange(this),
        onVerify: (attempt, verification) =>
          this.emit({
            type: "verify",
            attempt,
            passed: verification.passed,
            output: truncateMiddle(verification.output, 4000),
          }),
      },
    });
  }

  private async verify(settings: Settings, signal: AbortSignal): Promise<VerificationResult> {
    const decision = decideCommand(settings.verifyCommand, { autoApprove: [], deny: settings.commands.deny });
    if (decision.kind === "deny") return { passed: false, output: `The check command is blocked: ${decision.reason}` };
    this.deps.log.info(`[audit] verify: ${settings.verifyCommand}`);
    const result = await runShellCommand(
      settings.verifyCommand,
      this.root.uri.fsPath,
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
    await this.deps.stats.record({ success, bugFixed, filesChanged, tokens: meter.tokens, cost: meter.cost ?? 0 });
    this.emit({
      type: "taskEnd",
      status,
      message: aborted ? "Stopped." : result?.message,
      verified: result?.verified === true,
      celebrate: settings.celebrate && success && filesChanged > 0,
      reviewFiles: this.deps.reviews.pendingFiles.length,
    });
    this.deps.log.info(
      `Task ${status}: steps=${result?.steps ?? 0} files=${filesChanged} tokens=${meter.tokens}${meter.cost !== undefined ? ` cost=${formatCost(meter.cost)}` : ""}`,
    );
    if (bugFixed && request.kind === "fix") void vscode.window.setStatusBarMessage("$(check) Phew! Fixed.", 5000);
  }
}
