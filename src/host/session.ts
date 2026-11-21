import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { achievementList } from "../core/achievements";
import { type AgentResult, runAgent, type VerificationResult } from "../core/agent";
import type { Attachment } from "../core/attachments";
import { type ChatMessage, type ModelClient, type ToolCall, trimHistory, truncateMiddle } from "../core/chat";
import { failureLine, isStalled } from "../core/chatStatus";
import { buildTitleMessages, cleanTitle, firstExchange } from "../core/chatTitle";
import { CheckpointStore } from "../core/checkpoints";
import { decideCommand } from "../core/commandPolicy";
import { describeShellResult, parseCommandResult } from "../core/commandResult";
import {
  applyCompaction,
  buildCompactionMessages,
  contextUsage,
  estimateTokens,
  splitForCompaction,
} from "../core/compaction";
import { pruneStaleToolResults } from "../core/contextTrim";
import { CostMeter, formatCost, formatTokens } from "../core/cost";
import { titleFromText } from "../core/export";
import { FallbackClient, fallbackChain, fallbackReason } from "../core/fallback";
import { unfinishedWork } from "../core/handoff";
import { exitCodeOf, type JournalEvent } from "../core/journal";
import { learnRequest, memoryPrompt } from "../core/memory";
import { chooseModelId, pinnedModelId } from "../core/modelChoice";
import { canChange, findMode, type Mode, type ModeDefinition } from "../core/modes";
import { limitForChat, limitForModel } from "../core/outputLimit";
import { personaPrompt } from "../core/persona";
import { emptyPlan, type Plan, planPrompt } from "../core/plan";
import { initRequest } from "../core/projectBrief";
import { buildSystemPrompt } from "../core/prompts";
import { RootSet } from "../core/roots";
import { rulesForFile } from "../core/rules";
import { skillsPrompt } from "../core/skills";
import {
  delegateTool,
  delegateToolName,
  Limiter,
  parseDelegate,
  subagentPrompt,
  subagentResult,
  subagentToolNames,
} from "../core/subagents";
import { type FileChange, fileChange } from "../core/summary";
import { terminalEventsNote } from "../core/terminals";
import type { ModelProfile } from "../providers/profile";
import type { CommandSetting, HostMessage, ReviewSetting } from "../shared/protocol";
import { AgentTerminal } from "./agentTerminal";
import { ApprovalBroker } from "./approvals";
import { resolveAttachments } from "./attachments";
import { ChangeManager, type DiffContentProvider } from "./changes";
import type { CodeIndexManager } from "./codeIndexManager";
import { describeResult, runShellCommand } from "./commandRunner";
import type { StoredConversation } from "./conversationStore";
import type { HandoffService } from "./handoffs";
import type { McpManager } from "./mcpManager";
import type { MemoryStore } from "./memoryStore";
import type { ModelManager } from "./models";
import type { PlanUsageService } from "./planUsage";
import { projectBrief } from "./projectBrief";
import type { RatingService } from "./rating";
import type { ReviewManager } from "./reviewManager";
import { loadRuleSet } from "./rulesLoader";
import { readSettings, type Settings } from "./settings";
import { ShellRegistry, type TerminalInfo } from "./shellRegistry";
import { ptyLoadError } from "./shellSession";
import type { SkillStore } from "./skillStore";
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
  /** The title of a new chat. Defaults to the start of the text. */
  readonly title?: string;
}

export interface FileClaimRegistry {
  claim(sessionId: string, path: string): void;
  owner(path: string, exceptSessionId: string): string | undefined;
  release(sessionId: string): void;
}

/** What a chat tells the user about: a result, a question, a fallback model, or a quiet model. */
export type NotifyEvent = "done" | "failed" | "input" | "fallback" | "stalled";

export interface SessionDependencies {
  readonly context: vscode.ExtensionContext;
  /** The plans of the models, when their providers tell them. */
  readonly plans?: PlanUsageService;
  readonly log: vscode.LogOutputChannel;
  readonly diffs: DiffContentProvider;
  readonly mcp: McpManager;
  readonly stats: StatsStore;
  /** Asks for a rating after a task that went well, now and then. */
  readonly rating?: RatingService;
  readonly models: ModelManager;
  readonly reviews: ReviewManager;
  readonly index: CodeIndexManager;
  readonly memory: MemoryStore;
  readonly skills: SkillStore;
  readonly terminal: TerminalWatcher;
  /** Who listens on a port, in this chat or another one, for a program that cannot start. */
  readonly portOwner?: (port: number, sessionId: string) => string | undefined;
  /** The text of another chat of the workspace, for @chat. */
  readonly chatDigest?: (id: string) => Promise<{ title: string; text: string } | undefined>;
  readonly modes: () => readonly ModeDefinition[];
  readonly claims: FileClaimRegistry;
  readonly handoffs: HandoffService;
  /** Delivers a message of this session to the views that show it. */
  readonly emit: (session: AgentSession, message: HostMessage) => void;
  readonly onChange: (session: AgentSession) => void;
  readonly persist: (session: AgentSession) => Promise<void>;
  /** Tells the user that the session finished or needs input, for example with a notification and a sound. */
  readonly notify: (session: AgentSession, event: NotifyEvent, seconds?: number) => void;
}

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly repository: string;
}

export interface ApprovalOverrides {
  readonly review?: ReviewSetting;
  readonly commands?: CommandSetting;
  readonly mcp?: boolean;
}

interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

const maximumHistoryCharacters = 400_000;
const maximumTranscript = 3_000;

/**
 * Keeps the chat messages so that a view can rebuild itself after VS Code disposes a hidden webview,
 * after a switch between sessions, and after a restart. Streaming deltas are replaced by the final message.
 */
export class Transcript {
  private items: HostMessage[] = [];

  constructor(initial: readonly HostMessage[] = []) {
    this.items = [...initial];
  }

  /** Adds a message and returns it with a time stamp. */
  add(message: HostMessage): HostMessage {
    const stamped: HostMessage = message.at ? message : { ...message, at: Date.now() };
    const transient = [
      "state",
      "sessions",
      "mentions",
      "addAttachment",
      "focusInput",
      "openPanel",
      "queue",
      "sound",
      "ratingAsk",
    ];
    if (transient.includes(stamped.type)) return stamped;
    if (stamped.type === "assistantDiscard") {
      this.items = this.items.filter(
        (item) =>
          !(
            (item.type === "assistantDelta" || item.type === "assistantStart" || item.type === "reasoningDelta") &&
            item.id === stamped.id
          ),
      );
      return stamped;
    }
    if (stamped.type === "cleared") {
      this.items = [];
      return stamped;
    }
    if (stamped.type === "assistantEnd") {
      this.items = this.items.filter(
        (item) => !((item.type === "assistantDelta" || item.type === "assistantStart") && item.id === stamped.id),
      );
    }
    if (stamped.type === "reasoningEnd") {
      this.items = this.items.filter((item) => !(item.type === "reasoningDelta" && item.id === stamped.id));
    }
    if (stamped.type === "plan") this.items = this.items.filter((item) => item.type !== "plan");
    // A subagent card changes while it works: the newest state takes the place of the old one.
    if (stamped.type === "subagent") {
      const index = this.items.findIndex((item) => item.type === "subagent" && item.id === stamped.id);
      if (index >= 0) {
        this.items[index] = stamped;
        return stamped;
      }
    }
    this.items.push(stamped);
    if (this.items.length > maximumTranscript) this.items.splice(0, this.items.length - maximumTranscript);
    return stamped;
  }

  all(): readonly HostMessage[] {
    return this.items;
  }

  /** The transcript for saving: open approvals are marked as cancelled because they cannot survive a restart. */
  persistable(): HostMessage[] {
    const resolved = new Set(this.items.filter((item) => item.type === "approvalResolved").map((item) => item.id));
    const result: HostMessage[] = [];
    for (const item of this.items) {
      if (item.type === "assistantStart" || item.type === "assistantDelta" || item.type === "reasoningDelta") continue;
      result.push(item);
      if (item.type === "approval" && !resolved.has(item.id)) {
        result.push({ type: "approvalResolved", id: item.id, decision: "cancelled", at: Date.now() });
      }
    }
    return result;
  }
}

/** One conversation with the agent. Several sessions can run at the same time. */
/** A short fingerprint of a text, to see in the log whether the system prompt changed. */
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

export class AgentSession {
  readonly broker: ApprovalBroker;
  transcript: Transcript;
  readonly createdAt: number;
  private checkpoints: CheckpointStore;
  private readonly changes: ChangeManager;
  private history: ChatMessage[];
  private modeId: Mode;
  private controller: AbortController | undefined;
  /** Retry of the current model request, while one runs. */
  private readonly requestControl: { retry?: () => void } = {};
  private readonly side = new Set<AbortController>();
  private counter = 0;
  /** The folder of the chat's shell, kept between commands and turns. */
  private readonly shell: { cwd?: string; envFile?: string } = {
    envFile: path.join(
      os.tmpdir(),
      `phew-env-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    ),
  };
  /** Tool calls of the running turn: the id in the chat by the id of the model call, and back. */
  private readonly toolIdsByCall = new Map<string, string>();
  private readonly callIdsByTool = new Map<string, string>();
  private activeTools: ToolHost | undefined;
  /** Live command output waits here briefly, so the chat gets a few messages per second, not one per chunk. */
  private readonly outputBuffers = new Map<string, string>();
  private outputTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionTokens: number;
  private sessionCost: number;
  private lastInputTokens = 0;
  /** The size of the parts of the last request and a fingerprint of its system prompt, for the log. */
  private requestShape: { system: number; tools: number; fingerprint: string } | undefined;
  /** The model of this chat; older chats get one at their next task. */
  private modelId: string | undefined;
  private lastEventAt = Date.now();
  private fallbackName: string | undefined;
  private taskOutcome: "done" | "failed" | undefined;
  private lastFailure: string | undefined;
  private verifyAttempts = 0;
  private queue: QueuedMessage[] = [];
  private currentPlan: Plan;
  overrides: ApprovalOverrides;
  title: string;
  /** Where the title came from. Only an automatic title is replaced by a generated one. */
  private titleSource: "auto" | "user" | "generated" = "auto";
  private naming = false;
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
      this.emit(message);
      if (message.type === "approval") this.deps.notify(this, "input");
    });
    this.checkpoints = restored ? CheckpointStore.fromJSON(restored.checkpoints) : new CheckpointStore();
    this.changes = new ChangeManager(
      this.broker,
      deps.diffs,
      this.checkpoints,
      deps.reviews,
      (path) => deps.claims.owner(path, this.id),
      (path) => deps.claims.claim(this.id, path),
    );
    this.history = restored ? [...restored.history] : [];
    this.restoredFromStore = (restored?.history.length ?? 0) > 0;
    this.modeId = restored?.mode ?? readSettings(root.uri).defaultMode;
    this.title = restored?.title ?? (worktree ? `Agent: ${worktree.branch}` : "New chat");
    if (restored) {
      // Older chats have no source. A title that still matches the first message was not renamed by the user.
      const first = restored.history.find((message) => message.role === "user")?.content ?? "";
      this.titleSource = restored.titleSource ?? (restored.title === titleFromText(first) ? "auto" : "user");
    }
    this.createdAt = restored?.createdAt ?? Date.now();
    this.updatedAt = restored?.updatedAt ?? this.createdAt;
    this.sessionTokens = restored?.tokens ?? 0;
    this.sessionCost = restored?.cost ?? 0;
    this.currentPlan = restored?.plan ?? emptyPlan;
    this.overrides = restored?.overrides ?? {};
    this.modelId = restored?.model;
  }

  get busy(): boolean {
    return this.controller !== undefined;
  }

  get needsApproval(): boolean {
    return this.broker.pendingCount > 0;
  }

  /** True when the model of a running request has sent nothing for a minute. */
  get stalled(): boolean {
    return this.stalledAt(Date.now());
  }

  /** True when the model of a running request has been quiet for a minute at `now`. */
  stalledAt(now: number): boolean {
    return isStalled({
      busy: this.busy,
      modelRequest: this.requestControl.retry !== undefined,
      needsApproval: this.needsApproval,
      lastEventAt: this.lastEventAt,
      now,
    });
  }

  /** When the chat last heard from its task, to tell a stall apart from a new one. */
  get lastEvent(): number {
    return this.lastEventAt;
  }

  /** The fallback model that answers in the running task, if the model of the chat ran out of quota. */
  get fallbackModel(): string | undefined {
    return this.fallbackName;
  }

  /** How the last task ended, until the user saw it. */
  get outcome(): "done" | "failed" | undefined {
    return this.taskOutcome;
  }

  /** Why the last task failed, in one line. */
  get failure(): string {
    return failureLine(this.lastFailure);
  }

  /** The user saw the result, so the list no longer marks it. */
  clearOutcome(): boolean {
    if (!this.taskOutcome) return false;
    this.taskOutcome = undefined;
    return true;
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

  get plan(): Plan {
    return this.currentPlan;
  }

  get queued(): readonly { id: string; text: string }[] {
    return this.queue.map((item) => ({ id: item.id, text: item.text }));
  }

  /** The folders of this session: the worktree, or all workspace folders with the session root first. */
  get roots(): RootSet {
    if (this.worktree) return new RootSet([{ name: this.root.name, path: this.root.uri.fsPath }]);
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.fsPath !== this.root.uri.fsPath,
    );
    return new RootSet([
      { name: this.root.name, path: this.root.uri.fsPath },
      ...folders.map((folder) => ({ name: folder.name, path: folder.uri.fsPath })),
    ]);
  }

  /** How full the context window is, from the last request or from an estimate. */
  contextState(): { share: number; label: string } {
    const settings = readSettings(this.root.uri);
    const window = this.profile()?.contextWindow ?? settings.defaultContextWindow;
    const tokens = this.lastInputTokens || estimateTokens(this.history);
    const share = contextUsage(tokens, window);
    return { share, label: `${formatTokens(tokens)} of ${formatTokens(window)} context (${Math.round(share * 100)}%)` };
  }

  /** The settings of this chat: the defaults with the approval overrides of the chat. */
  effectiveSettings(): Settings {
    const settings = readSettings(this.root.uri);
    return {
      ...settings,
      reviewMode: this.overrides.review ?? settings.reviewMode,
      commands: { ...settings.commands, mode: this.overrides.commands ?? settings.commands.mode },
      mcpAutoApprove: this.overrides.mcp ?? settings.mcpAutoApprove,
    };
  }

  setOverride(key: keyof ApprovalOverrides, value: ReviewSetting | CommandSetting | boolean | undefined): void {
    this.overrides = { ...this.overrides, [key]: value };
    this.deps.onChange(this);
    void this.deps.persist(this);
  }

  resetOverrides(): void {
    this.overrides = {};
    this.deps.onChange(this);
    void this.deps.persist(this);
  }

  setMode(id: Mode): void {
    this.modeId = findMode(id, this.deps.modes()).id;
    this.deps.onChange(this);
  }

  rename(title: string): void {
    this.title = title.trim().slice(0, 120) || this.title;
    this.titleSource = "user";
    this.deps.onChange(this);
    void this.deps.persist(this);
  }

  toStored(): StoredConversation {
    return {
      version: 1,
      id: this.id,
      title: this.title,
      titleSource: this.titleSource,
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
      plan: this.currentPlan,
      overrides: this.overrides,
      ...(this.modelId ? { model: this.modelId } : {}),
    };
  }

  /**
   * The chat before one of your messages: the history for the model, what the chat shows, and the text of
   * that message. Undefined when the message is no longer in the history, for example after compaction.
   */
  before(checkpointId: string): { history: ChatMessage[]; transcript: HostMessage[]; text: string } | undefined {
    const index = this.history.findIndex((message) => message.role === "user" && message.checkpointId === checkpointId);
    if (index < 0) return undefined;
    const items = this.transcript.persistable();
    const at = items.findIndex((item) => item.type === "user" && item.checkpointId === checkpointId);
    if (at < 0) return undefined;
    const user = items[at];
    return {
      history: this.history.slice(0, index),
      transcript: items.slice(0, at),
      text: user?.type === "user" ? user.text : "",
    };
  }

  /**
   * Edit and resend: the chat goes back to the moment before this message. The later messages go away, and
   * the files that changed after it are restored, after the user agrees.
   */
  async rewindTo(checkpointId: string, confirmed = false): Promise<string | undefined> {
    if (this.busy) {
      this.notice("warning", "Stop the current task before you edit an earlier message.");
      return undefined;
    }
    const earlier = this.before(checkpointId);
    if (!earlier) {
      this.notice(
        "warning",
        "This message is no longer in the history of the chat. Fork from a later message instead.",
      );
      return undefined;
    }
    const later = this.history.length - earlier.history.length;
    const files = this.checkpoints.has(checkpointId) ? this.checkpoints.changedSince(checkpointId) : [];
    const answer = confirmed
      ? "Edit"
      : await vscode.window.showWarningMessage(
          "Edit this message and send it again?",
          {
            modal: true,
            detail: [
              `The ${later} later ${later === 1 ? "message goes" : "messages go"} away.`,
              files.length > 0
                ? `${files.length} ${files.length === 1 ? "file goes" : "files go"} back to the state before this message:\n${files.slice(0, 12).join("\n")}${files.length > 12 ? "\n…" : ""}`
                : "No files changed after this message.",
              "To keep this chat as it is, use Fork from here instead.",
            ].join("\n\n"),
          },
          "Edit",
        );
    if (answer !== "Edit") return undefined;
    if (files.length > 0) await this.restore(checkpointId, files);
    this.history = earlier.history;
    this.transcript = new Transcript(earlier.transcript);
    this.lastInputTokens = 0;
    this.deps.persist(this);
    return earlier.text;
  }

  /** Sends the current model request again, when the model stopped answering. False when no request runs. */
  retryRequest(): boolean {
    const retry = this.requestControl.retry;
    if (!retry) return false;
    retry();
    return true;
  }

  stop(): void {
    this.controller?.abort();
    for (const controller of this.side) controller.abort();
    this.broker.cancelAll();
    this.queue = [];
    this.emitQueue();
  }

  removeQueued(id: string): void {
    this.queue = this.queue.filter((item) => item.id !== id);
    this.emitQueue();
  }

  /**
   * Handles a message from the input. `/btw` asks a side question, `/goal` sets the goal, and `/compact`
   * compacts the history. While a task runs, other messages wait in the queue and reach the agent at its next step.
   */
  async submit(text: string, attachments: readonly Attachment[] = [], interrupt = false): Promise<void> {
    const command = /^\/(btw|goal|compact|handoff|continue|init|learn)\b\s*([\s\S]*)$/i.exec(text.trim());
    if (command) {
      const [, name, rest] = command;
      const lower = name.toLowerCase();
      if (lower === "btw") await this.btw(rest.trim() || "What are you doing right now?");
      else if (lower === "goal") this.setGoal(rest.trim());
      else if (lower === "handoff") await this.writeHandoff(true);
      else if (lower === "continue") await this.continueFrom(rest.trim() || undefined);
      else if (lower === "init") await this.init(rest.trim());
      else if (lower === "learn")
        await this.run({
          text: learnRequest(rest.trim()),
          kind: "chat",
          display: rest.trim() ? `/learn ${rest.trim()}` : "/learn",
        });
      else await this.compactNow();
      return;
    }
    if (this.busy && interrupt) {
      // Stop the current step and continue with the new message at once.
      this.stop();
      for (let waited = 0; this.busy && waited < 15_000; waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.busy) {
      this.queue.push({ id: `q_${Date.now().toString(36)}_${++this.counter}`, text, attachments });
      this.emitQueue();
      return;
    }
    await this.run({ text, kind: "chat", attachments });
  }

  /** /init: the agent writes or improves AGENTS.md from what the project shows; the user reviews it. */
  private async init(extra: string): Promise<void> {
    let existing = false;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.root.uri, "AGENTS.md"));
      existing = true;
    } catch {
      existing = false;
    }
    await this.run({
      text: [initRequest(existing), extra ? `\nAlso: ${extra}` : ""].join(""),
      kind: "chat",
      display: extra ? `/init ${extra}` : "/init",
      mode: "code",
      ...(this.history.length === 0 ? { title: existing ? "Improve AGENTS.md" : "Write AGENTS.md" } : {}),
    });
  }

  setGoal(goal: string): void {
    this.currentPlan = { ...this.currentPlan, goal: goal || undefined };
    this.emit({ type: "plan", plan: this.currentPlan });
    void this.deps.persist(this);
  }

  async run(request: TaskRequest): Promise<void> {
    if (this.busy) {
      await this.submit(request.text, request.attachments);
      return;
    }
    const settings = this.effectiveSettings();
    this.pinModel();
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
    // A new task: the result of the last one is no longer news.
    this.taskOutcome = undefined;
    this.lastFailure = undefined;
    this.fallbackName = undefined;
    this.lastEventAt = Date.now();
    this.deps.onChange(this);

    const checkpointId = `cp_${Date.now().toString(36)}_${++this.counter}`;
    this.checkpoints.begin(checkpointId, request.display ?? request.text);
    if (this.history.length === 0) {
      this.title = request.title ?? titleFromText(request.display ?? request.text);
      this.titleSource = request.title ? "user" : "auto";
    }
    await this.pushUser(request.text, request.attachments ?? [], settings, checkpointId, request.display);
    this.journal({ t: "user", at: Date.now(), text: request.display ?? request.text });

    const meter = new CostMeter(profile.price, settings.budget);
    this.verifyAttempts = 0;
    const startedAt = Date.now();
    let result: AgentResult | undefined;
    try {
      result = await this.execute(request, profile, mode, settings, meter, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastFailure = message;
        this.deps.log.error(`Task failed: ${message}`);
        this.notice("error", message);
      }
    } finally {
      this.controller = undefined;
      this.history = trimHistory(this.history, maximumHistoryCharacters);
      this.sessionTokens += meter.tokens;
      this.sessionCost += meter.cost ?? 0;
      this.updatedAt = Date.now();
      this.deps.claims.release(this.id);
      this.fallbackName = undefined;
    }
    if (!controller.signal.aborted) {
      this.taskOutcome = result?.status === "done" ? "done" : "failed";
      if (this.taskOutcome === "failed") this.lastFailure ??= result?.message;
    }
    await this.finish(request, result, controller.signal.aborted, meter, settings, startedAt);
    this.deps.onChange(this);
    await this.deps
      .persist(this)
      .catch((error: unknown) => this.deps.log.warn(`Could not save the chat: ${String(error)}`));
    // You stopped it yourself, so there is nothing to tell.
    if (!controller.signal.aborted)
      this.deps.notify(this, result?.status === "done" ? "done" : "failed", (Date.now() - startedAt) / 1000);
    if (!controller.signal.aborted) void this.nameChat(profile);

    // Messages that arrived after the last step start the next task.
    const next = this.queue.shift();
    if (next && !controller.signal.aborted) {
      this.emitQueue();
      await this.run({ text: next.text, kind: "chat", attachments: next.attachments });
    }
  }

  /** Answers a side question without tools and without changing the main conversation. */
  async btw(question: string): Promise<void> {
    const profile = this.profile();
    if (!profile) return;
    const controller = new AbortController();
    this.side.add(controller);
    const id = `b_${Date.now().toString(36)}_${++this.counter}`;
    this.emit({ type: "user", id, text: `/btw ${question}`, checkpointId: id });
    this.emit({ type: "assistantStart", id: `${id}_a`, variant: "btw" });
    let text = "";
    try {
      const client = await this.deps.models.client(profile);
      const result = await client.complete(
        {
          messages: [
            {
              role: "system",
              content: `You are ${readSettings(this.root.uri).assistant.name}, a coding agent in VS Code built on Phew. The user asks a quick side question while the main task continues. Answer briefly. Do not change files. Workspace: ${this.root.name}.\n${personaPrompt(readSettings(this.root.uri).assistant)}`,
            },
            ...trimHistory(this.history, 60_000),
            { role: "user", content: question },
          ],
          tools: [],
          signal: controller.signal,
        },
        (delta) => {
          text += delta;
          this.emit({ type: "assistantDelta", id: `${id}_a`, text: delta });
        },
      );
      text = result.content;
    } catch (error) {
      if (!controller.signal.aborted)
        text = `The side question failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.side.delete(controller);
    }
    this.emit({ type: "assistantEnd", id: `${id}_a`, text, variant: "btw" });
  }

  /**
   * Names the chat after its first answer, like "Fix login redirect loop", so the chat list is easy to scan.
   * Runs once in the background and never replaces a name that the user chose.
   */
  private async nameChat(profile: ModelProfile): Promise<void> {
    if (this.titleSource !== "auto" || this.naming || !readSettings(this.root.uri).autoTitle) return;
    const exchange = firstExchange(this.history);
    if (!exchange) return;
    this.naming = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const client = await this.deps.models.client(profile);
      const result = await client.complete(
        { messages: buildTitleMessages(exchange.request, exchange.answer), tools: [], signal: controller.signal },
        () => {},
      );
      const title = cleanTitle(result.content);
      if (!title || this.titleSource !== "auto") return;
      this.title = title;
      this.titleSource = "generated";
      this.deps.onChange(this);
      await this.deps.persist(this);
    } catch (error) {
      this.deps.log.debug?.(`Could not name the chat: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      this.naming = false;
    }
  }

  async compactNow(): Promise<void> {
    if (this.busy) {
      this.notice("info", "Phew compacts the chat automatically while it works.");
      return;
    }
    const profile = this.profile();
    if (!profile) return;
    const compacted = await this.compact(await this.deps.models.client(profile), new AbortController().signal, true);
    if (!compacted) this.notice("info", "The chat is too short to compact.");
    this.deps.onChange(this);
    await this.deps.persist(this);
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

  /** Line counts of the files that a task changed, from the checkpoint and the current text. */
  private async changesOf(originals: ReadonlyMap<string, string | null>): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    for (const [path, before] of [...originals].slice(0, 50)) {
      const absolute = this.roots.resolve(path);
      if (!absolute) continue;
      const uri = vscode.Uri.file(absolute);
      let after: string | null;
      const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath);
      if (open) after = open.getText();
      else {
        try {
          after = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          after = null;
        }
      }
      const change = fileChange(path, before, after);
      if (change) changes.push(change);
    }
    return changes;
  }

  private async handoffHint(settings: Settings): Promise<string> {
    if (!settings.handoff.enabled) return "";
    return unfinishedWork(await this.deps.handoffs.list(this.root.uri.fsPath), this.id);
  }

  private journal(event: JournalEvent): void {
    this.deps.handoffs.record(this.root.uri.fsPath, this.id, this.title, event);
  }

  private journalTool(call: ToolCall, content: string): void {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      // Keep the summary only.
    }
    const ok = !content.startsWith("Error:");
    const file =
      (call.name === "edit_file" || call.name === "write_file") && typeof args.path === "string"
        ? args.path
        : undefined;
    const command = call.name === "run_command" && typeof args.command === "string" ? args.command : undefined;
    const exit = command !== undefined ? exitCodeOf(content) : undefined;
    this.journal({
      t: "tool",
      at: Date.now(),
      name: call.name,
      summary: ToolHost.summarize(call),
      ok: command !== undefined ? ok && (exit === undefined || exit === 0) : ok,
      ...(file ? { file } : {}),
      ...(command !== undefined ? { command, exit } : {}),
    });
  }

  private handoffWriting: Promise<string | undefined> | undefined;

  /** Writes a handoff note for this chat. Manual notes are opened in the editor. */
  async writeHandoff(manual: boolean): Promise<string | undefined> {
    const settings = readSettings(this.root.uri);
    if (!settings.handoff.enabled) {
      if (manual) this.notice("info", "Handoff notes are turned off in the settings (Phew › Handoff).");
      return undefined;
    }
    if (!vscode.workspace.isTrusted) {
      if (manual) this.notice("warning", "Phew writes handoff notes only in trusted workspaces.");
      return undefined;
    }
    if (manual && this.history.length === 0) {
      this.notice("info", "There is nothing to hand off yet.");
      return undefined;
    }
    const profile = this.profile();
    if (!profile) return undefined;
    if (this.handoffWriting) return this.handoffWriting;
    if (manual) this.notice("info", "Writing a handoff note…");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    this.handoffWriting = (async () => {
      try {
        const relative = await this.deps.handoffs.write(
          {
            id: this.id,
            title: this.title,
            root: this.root.uri.fsPath,
            history: this.history,
            plan: this.currentPlan,
            client: await this.deps.models.client(profile),
          },
          controller.signal,
        );
        if (relative) {
          // An automatic note is written quietly; only a note that you asked for shows in the chat.
          this.deps.log.info(`Handoff note ${manual ? "saved" : "updated"}: ${relative}`);
          if (manual) {
            this.emit({ type: "handoff", path: relative, manual });
            await vscode.window.showTextDocument(vscode.Uri.joinPath(this.root.uri, relative), { preview: true });
          }
        }
        return relative;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.warn(`Could not write the handoff note: ${message}`);
        if (manual) this.notice("warning", `Could not write the handoff note: ${message}`);
        return undefined;
      } finally {
        clearTimeout(timer);
        this.handoffWriting = undefined;
      }
    })();
    return this.handoffWriting;
  }

  /** Starts a task that continues the work of a handoff note. */
  async continueFrom(relative?: string): Promise<void> {
    if (this.busy) {
      this.notice("info", "Wait until the current task ends, or stop it first.");
      return;
    }
    const prepared = await this.deps.handoffs.prepareContinue(this.root.uri.fsPath, relative);
    if (!prepared) {
      this.notice(
        "info",
        relative
          ? `${relative} is not a Phew handoff note.`
          : "There is no handoff note yet. Use /handoff in a chat to write one.",
      );
      return;
    }
    if (prepared.meta.goal && !this.currentPlan.goal) this.setGoal(prepared.meta.goal);
    this.journal({ t: "continued", at: Date.now(), from: prepared.path, narrative: prepared.narrative });
    if (!prepared.state.fresh)
      this.notice(
        "warning",
        `${prepared.state.notes.join(" ").replace(/`/g, "")} ${readSettings(this.root.uri).assistant.name} checks this first.`,
      );
    await this.run({
      text: prepared.prompt,
      kind: "chat",
      display: `Continue: ${prepared.meta.title} (${prepared.path})`,
      title: prepared.meta.title,
    });
  }

  /** Restores the first checkpoint without a confirmation. Only the integration tests use it. */
  async restoreFirstForTest(): Promise<void> {
    const first = this.checkpoints.list()[0];
    if (first) await this.restore(first.id, this.checkpoints.changedSince(first.id));
  }

  dispose(): void {
    this.stop();
    this.terminal?.dispose();
    this.shellRegistry?.dispose();
    if (this.shell.envFile) fs.rmSync(this.shell.envFile, { force: true });
  }

  private terminal: AgentTerminal | undefined;
  private readonly commandWhere = new Map<string, "terminal" | "background">();
  private readonly commandApprovals = new Map<string, string>();

  private shellRegistry: ShellRegistry | undefined;
  /** The chat comes from an earlier window: its terminals ended, and the model should know that. */
  private restoredFromStore = false;
  private shellWarned = false;
  /** The terminal where each command of the chat ran, for keys typed in its view. */
  private readonly commandTerminals = new Map<string, string>();

  /** The terminals of the chat (real shells), or undefined when node-pty does not load on this system. */
  private agentShells(): ShellRegistry | undefined {
    if (!this.shellRegistry) {
      const extension = vscode.extensions.getExtension("alekseialeinikov.phew");
      this.shellRegistry = new ShellRegistry(
        extension?.extensionPath,
        () => this.title,
        () => this.shell.cwd ?? this.root.uri.fsPath,
        () => readSettings().commandsShell || undefined,
        () => this.deps.onChange(this),
        () => readSettings().commandsStartupFiles,
        (message) => this.notice("info", message),
        () => readSettings().commandsMaxTerminals,
        (event) => {
          // The person sees at once when a server or a shell ends; the agent hears it at its next step.
          const name = `Terminal ${event.id}${event.label ? ` "${event.label}"` : ""}`;
          if (event.kind === "exited" && event.exitCode)
            this.notice(
              "warning",
              `${name}: ${event.command?.split("\n")[0]?.slice(0, 60)} ended with exit code ${event.exitCode}.`,
            );
          else if (event.kind === "closed") this.notice("info", `${name}: the shell closed.`);
        },
      );
      this.shellRegistry.restoredChat = this.restoredFromStore;
    }
    if (this.shellRegistry.available) return this.shellRegistry;
    if (!this.shellWarned) {
      this.shellWarned = true;
      this.deps.log.warn(
        `The terminal of the chat is not available, so commands run in processes: ${ptyLoadError() ?? "no extension path"}`,
      );
    }
    return undefined;
  }

  /** A file that the output of a terminal names: relative to the folder of the terminal; only existing files. */
  terminalFile(terminal: string, file: string): string | undefined {
    const folder = this.shellRegistry?.get(terminal)?.cwd ?? this.shell.cwd ?? this.root.uri.fsPath;
    const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(folder, expanded);
    try {
      return fs.statSync(absolute).isFile() ? absolute : undefined;
    } catch {
      return undefined;
    }
  }

  /** The recent output of the terminals of the chat, for the attach menu. */
  get terminalSnapshots(): { id: string; state: string; command?: string; output: string }[] {
    return this.shellRegistry?.snapshots() ?? [];
  }

  /** The terminals of the chat for the list in the chat. */
  get terminals(): TerminalInfo[] {
    return this.shellRegistry?.list() ?? [];
  }

  /** Closes extra terminals idle since before `now` minus 15 minutes; the timer of the registry does it each minute. */
  closeIdleTerminals(now: number): string[] {
    return this.shellRegistry?.closeIdle(now) ?? [];
  }

  /** The ports that the programs in the terminals of this chat listen on. */
  get terminalPorts(): { id: string; label?: string; port: number }[] {
    return this.shellRegistry?.portsInUse() ?? [];
  }

  /** Show, Ctrl+C, or close one terminal of the chat. */
  terminalAction(id: string, action: "show" | "interrupt" | "kill"): void {
    const registry = this.shellRegistry;
    if (!registry) return;
    if (action === "kill") registry.kill(id);
    else if (action === "interrupt") registry.get(id)?.stop();
    else registry.get(id)?.reveal(false);
  }

  private agentTerminal(): AgentTerminal {
    this.terminal ??= new AgentTerminal(() => this.title);
    return this.terminal;
  }

  /** Shows the terminal of the chat, where the agent's commands run. */
  showTerminal(): void {
    const shell = this.shellRegistry?.main;
    if (shell) shell.reveal(false);
    else this.agentTerminal().show();
  }

  /** The model that answers in this chat now: the model of the mode, of the chat, or the default. */
  private profile(): ModelProfile | undefined {
    const profiles = this.deps.models.profiles().profiles;
    const id = chooseModelId({
      available: profiles.map((profile) => profile.id),
      modeModel: this.mode.model,
      chatModel: this.modelId,
      defaultModel: this.deps.models.active()?.id,
    });
    return profiles.find((profile) => profile.id === id);
  }

  /** The model that answers in this chat now, for the chat view. */
  get currentProfile(): ModelProfile | undefined {
    return this.profile();
  }

  /** The id of the model of this chat itself, without the model of the mode. */
  get chatModelId(): string | undefined {
    return this.modelId;
  }

  /** Chooses the model of this chat. Other chats keep theirs. */
  setModel(id: string): void {
    if (this.modelId === id) return;
    this.modelId = id;
    this.deps.onChange(this);
    void this.deps.persist(this);
  }

  /** Pins the default model to a chat without its own, so a choice in another chat or window does not move it. */
  private pinModel(): void {
    if (this.modelId) return;
    this.modelId = pinnedModelId({
      available: this.deps.models.profiles().profiles.map((profile) => profile.id),
      defaultModel: this.deps.models.active()?.id,
    });
  }

  private async pushUser(
    text: string,
    attachments: readonly Attachment[],
    settings: Settings,
    checkpointId: string,
    display?: string,
    queued = false,
  ): Promise<void> {
    const resolved = await resolveAttachments(
      attachments,
      this.root.uri,
      settings,
      this.deps.terminal,
      this.deps.chatDigest,
    );
    for (const warning of resolved.warnings) this.notice("warning", warning);
    this.emit({
      type: "user",
      id: checkpointId,
      text: display ?? text,
      checkpointId,
      ...(resolved.labels.length > 0 ? { attachments: resolved.labels } : {}),
    });
    const prefix = queued ? "(The user sent this while you were working. Take it into account now.)\n" : "";
    const content = [prefix + text, resolved.context].filter(Boolean).join("\n\n");
    this.history.push({
      role: "user",
      content,
      checkpointId,
      ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
    });
  }

  private async restore(checkpointId: string, files: string[]): Promise<void> {
    const roots = this.roots;
    const writes = this.checkpoints.restore(checkpointId);
    await this.changes.restore((path) => {
      const absolute = roots.resolve(path);
      return absolute ? vscode.Uri.file(absolute) : undefined;
    }, writes);
    this.history.push({
      role: "user",
      content: `I restored these files to their state before an earlier request: ${files.join(", ")}. Read them again before you edit them.`,
    });
    this.history.push({ role: "assistant", content: "Understood. I will read the files again before I change them." });
    this.deps.log.info(`[audit] checkpoint restored: ${files.join(", ")}`);
    this.emit({ type: "checkpointRestored", checkpointId, files });
    await this.deps.persist(this);
  }

  /** "Phew it!" on a command that failed: a new task that finds the cause and fixes it, with the output attached. */
  async fixCommand(toolId: string): Promise<void> {
    const tool = [...this.transcript.all()]
      .reverse()
      .find((item): item is Extract<HostMessage, { type: "tool" }> => item.type === "tool" && item.id === toolId);
    if (!tool || tool.status === "running") return;
    const command = tool.command ?? tool.summary.replace(/^run_command\s*/, "");
    const parsed = parseCommandResult(tool.detail ?? "");
    const how =
      parsed.exitCode !== undefined
        ? `failed with exit code ${parsed.exitCode}`
        : `ended: ${parsed.status ?? "failed"}`;
    await this.run({
      text: `The command \`${command}\` ${how}. Find the cause in the output, fix it, and run the command again to check.`,
      display: `Phew it! \`${command.split("\n")[0]?.slice(0, 80)}\` ${how}.`,
      kind: "fix",
      attachments: [{ kind: "terminal", command, output: limitForModel(parsed.output, 4_000, 20_000) }],
    });
  }

  /** Runs a command of the chat again, at the request of the user, in a terminal where nothing runs. */
  async rerunCommand(toolId: string): Promise<void> {
    const tool = [...this.transcript.all()]
      .reverse()
      .find((item): item is Extract<HostMessage, { type: "tool" }> => item.type === "tool" && item.id === toolId);
    const registry = this.agentShells();
    if (!tool || !registry) return;
    const command = tool.command ?? tool.summary.replace(/^run_command\s*/, "");
    const picked = registry.pickIdle(this.commandTerminals.get(toolId));
    if (!picked) return;
    const id = `t_${++this.counter}_${Date.now().toString(36)}`;
    const callId = `rerun_${id}`;
    this.toolIdsByCall.set(callId, id);
    this.callIdsByTool.set(id, callId);
    this.commandTerminals.set(id, picked.id);
    const base = {
      type: "tool" as const,
      id,
      name: "run_command",
      summary: `run_command ${command}`,
      command,
      ...(tool.description ? { description: tool.description } : {}),
      where: "terminal" as const,
      terminal: picked.id,
      approval: "Started again by you",
    };
    this.emit({ ...base, status: "running" });
    this.deps.emit(this, {
      type: "toolOutput",
      id,
      text: "",
      where: "terminal",
      terminal: picked.id,
      approval: "Started again by you",
    });
    const settings = readSettings();
    const outcome = await picked.session.run(command, {
      timeoutMs: settings.commandTimeoutSeconds * 1000,
      signal: new AbortController().signal,
      onOutput: (text) => this.bufferOutput(callId, text),
      reveal: false,
    });
    this.flushOutput();
    this.emit({
      ...base,
      status: "done",
      detail: truncateMiddle(describeShellResult(command, outcome, settings.commandTimeoutSeconds), 30_000),
    });
  }

  /** Keys typed in the terminal of a command in the chat. */
  commandInput(toolId: string, data: string): void {
    // The real shell takes keys at any time, also for a program that keeps running after its tool call.
    const terminal = this.commandTerminals.get(toolId);
    const shell = (terminal ? this.shellRegistry?.get(terminal) : undefined) ?? this.shellRegistry?.main;
    if (shell?.started) {
      shell.userInput(data);
      return;
    }
    const callId = this.callIdsByTool.get(toolId);
    if (callId) this.activeTools?.commandInput(callId, data);
  }

  /** Stops one running command from the terminal in the chat. */
  stopCommand(toolId: string): void {
    const callId = this.callIdsByTool.get(toolId);
    if (callId && this.activeTools?.stopCommand(callId)) return;
    // A program that keeps running after its tool call (waiting, in the background) stops with Ctrl+C.
    const terminal = this.commandTerminals.get(toolId);
    ((terminal ? this.shellRegistry?.get(terminal) : undefined) ?? this.shellRegistry?.main)?.stop();
  }

  private bufferOutput(callId: string, text: string): void {
    const id = this.toolIdsByCall.get(callId);
    if (!id || !text) return;
    this.outputBuffers.set(id, (this.outputBuffers.get(id) ?? "") + text);
    this.outputTimer ??= setTimeout(() => this.flushOutput(), 80);
  }

  /** Live output goes to the views only; the final result of the tool is what the transcript keeps. */
  private flushOutput(): void {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = undefined;
    // A command that prints faster than the chat can show sends the newest part and a note about the rest.
    for (const [id, text] of this.outputBuffers)
      this.deps.emit(this, { type: "toolOutput", id, text: limitForChat(text) });
    this.outputBuffers.clear();
  }

  private emit(message: HostMessage): void {
    this.lastEventAt = Date.now();
    this.deps.emit(this, this.transcript.add(message));
  }

  private emitQueue(): void {
    this.emit({ type: "queue", items: this.queued });
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.emit({ type: "notice", level, text });
  }

  /** Summarizes the older part of the history. Returns true when the history became shorter. */
  /**
   * Runs a subagent: a research task with read-only tools and its own model, in parallel with others. Its card in
   * the chat shows the model, the steps, and the report; the report goes back to the agent of the chat.
   */
  private async runSubagent(
    call: ToolCall,
    signal: AbortSignal,
    context: { settings: Settings; meter: CostMeter; limiter: Limiter; rules: string },
  ): Promise<{ content: string }> {
    const { settings } = context;
    const profiles = this.deps.models.profiles().profiles;
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(call.arguments || "{}") as unknown;
      args = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { content: "Error: the arguments of delegate are not valid JSON." };
    }
    const request = parseDelegate(
      args,
      profiles.map((item) => ({ id: item.id, name: item.name })),
    );
    if (typeof request === "string") return { content: `Error: ${request}` };
    // The model: the one the agent chose, else the model for subagents in the settings, else the model of the chat.
    const preferred = request.model ?? settings.subagents.model;
    const profile = profiles.find((item) => item.id === preferred) ?? this.profile();
    if (!profile) return { content: "Error: there is no model for the subagent." };

    const id = `sa_${++this.counter}_${Date.now().toString(36)}`;
    const steps: { name: string; summary: string }[] = [];
    let stepCount = 0;
    let fallback: string | undefined;
    let startedAt = Date.now();
    const card = (
      status: "running" | "done" | "failed" | "stopped",
      extra: { seconds?: number; report?: string; error?: string } = {},
    ) =>
      this.emit({
        type: "subagent",
        id,
        title: request.title,
        task: request.task.slice(0, 4000),
        model: profile.name,
        status,
        steps: steps.slice(-8),
        stepCount,
        ...(fallback ? { fallback } : {}),
        ...extra,
      });
    card("running");

    return context.limiter.run(async () => {
      startedAt = Date.now();
      if (signal.aborted) {
        card("stopped");
        return { content: subagentResult({ model: profile.name, status: "stopped", steps: 0, seconds: 0 }) };
      }
      const chain = [
        profile,
        ...fallbackChain(profile.id, profiles)
          .slice(1)
          .flatMap((next) => profiles.filter((item) => item.id === next)),
      ];
      const childMeter = new CostMeter(profile.price, { maxCostPerTask: 0, maxTokensPerTask: 0 });
      const client = new FallbackClient(
        chain.map((step) => ({ name: step.name, client: () => this.deps.models.client(step) })),
        (from, to, error) => {
          const failed = chain[from] as ModelProfile;
          const next = chain[to] as ModelProfile;
          fallback = next.name;
          childMeter.usePrice(next.price);
          steps.push({ name: "fallback", summary: `${failed.name} ${fallbackReason(error)}; ${next.name} goes on` });
          card("running");
        },
      );
      const ruleSet = await loadRuleSet(this.root.uri);
      const delivered = new Set<string>();
      // Read-only tools: no edits, no commands, no MCP, no questions, no plan, and no memory changes.
      const tools = new ToolHost({
        root: this.root,
        roots: this.roots,
        mode: findMode("ask", this.deps.modes()),
        settings,
        broker: this.broker,
        changes: this.changes,
        mcp: this.deps.mcp,
        index: this.deps.index,
        memory: this.deps.memory,
        rulesFor: (path) => rulesForFile(ruleSet.scoped, path, delivered),
        skills: this.deps.skills,
        plan: { get: () => emptyPlan, set: () => {} },
        log: this.deps.log,
      });
      const definitions = (await tools.definitions()).filter((tool) => subagentToolNames.has(tool.name));
      const history: ChatMessage[] = [{ role: "user", content: request.task }];
      let result: AgentResult | undefined;
      let error: string | undefined;
      try {
        result = await runAgent({
          client,
          systemPrompt: subagentPrompt({
            workspace: this.root.name,
            platform: `${os.platform()} ${os.release()}`,
            date: new Date().toISOString().slice(0, 10),
            rules: context.rules,
          }),
          history,
          tools: definitions,
          // A second check: whatever the model asks, a subagent only reads.
          executeTool: (toolCall, toolSignal) =>
            subagentToolNames.has(toolCall.name)
              ? tools.execute(toolCall, toolSignal)
              : Promise.resolve({ content: `Error: a subagent cannot use ${toolCall.name}. It only reads.` }),
          maxSteps: settings.subagents.maxSteps,
          meter: childMeter,
          signal,
          events: {
            onToolStart: (toolCall) => {
              stepCount++;
              steps.push({ name: toolCall.name, summary: ToolHost.summarize(toolCall) });
              card("running");
            },
          },
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        context.meter.absorb(childMeter);
      }
      const answer = [...history].reverse().find((message) => message.role === "assistant" && message.content)?.content;
      const status = signal.aborted ? "stopped" : result?.status === "done" ? "done" : "failed";
      if (status === "failed") error ??= result?.message ?? "it stopped without a report";
      const seconds = (Date.now() - startedAt) / 1000;
      this.deps.log.info(
        `Subagent ${status}: model=${fallback ?? profile.name} steps=${result?.steps ?? stepCount} tokens=${childMeter.tokens}`,
      );
      card(status, {
        seconds,
        ...(answer ? { report: answer.slice(0, 20_000) } : {}),
        ...(error ? { error: failureLine(error) } : {}),
      });
      return {
        content: subagentResult({
          model: profile.name,
          status,
          answer,
          error,
          steps: result?.steps ?? stepCount,
          seconds,
          fallback,
        }),
      };
    });
  }

  private async compact(client: ModelClient, signal: AbortSignal, manual = false): Promise<boolean> {
    const split = splitForCompaction(this.history, 2) ?? (manual ? splitForCompaction(this.history, 1) : undefined);
    if (!split) return false;
    this.notice("info", "Phew is compacting the chat to free context…");
    const result = await client.complete(
      { messages: buildCompactionMessages(split.older), tools: [], signal },
      () => {},
    );
    if (!result.content.trim()) return false;
    const before = estimateTokens(this.history);
    this.history.splice(0, this.history.length, ...applyCompaction(split.recent, result.content));
    this.lastInputTokens = 0;
    const after = estimateTokens(this.history);
    this.notice("info", `Compacted the chat from about ${formatTokens(before)} to ${formatTokens(after)} tokens.`);
    if (readSettings(this.root.uri).handoff.auto !== "manual") void this.writeHandoff(false);
    this.deps.log.info(`Chat compacted: ${before} -> ${after} estimated tokens.`);
    return true;
  }

  private async execute(
    request: TaskRequest,
    profile: ModelProfile,
    mode: ModeDefinition,
    settings: Settings,
    meter: CostMeter,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const primary = await this.deps.models.client(profile);
    const roots = this.roots;
    const ruleSet = await loadRuleSet(this.root.uri);
    const deliveredRules = new Set<string>();
    const tools = new ToolHost({
      root: this.root,
      roots,
      mode,
      settings,
      broker: this.broker,
      changes: this.changes,
      mcp: this.deps.mcp,
      index: this.deps.index,
      memory: this.deps.memory,
      rulesFor: (path) => rulesForFile(ruleSet.scoped, path, deliveredRules),
      portOwner: (port) => this.deps.portOwner?.(port, this.id),
      skills: this.deps.skills,
      plan: {
        get: () => this.currentPlan,
        set: (plan) => {
          this.currentPlan = plan;
          this.emit({ type: "plan", plan });
        },
      },
      log: this.deps.log,
      onCommandOutput: (callId, text) => this.bufferOutput(callId, text),
      shell: this.shell,
      terminal: vscode.workspace.isTrusted ? this.agentTerminal() : undefined,
      shells: vscode.workspace.isTrusted ? this.agentShells() : undefined,
      onCommandStart: (callId, where, terminal, approval) => {
        const id = this.toolIdsByCall.get(callId);
        if (!id) return;
        this.commandWhere.set(id, where);
        if (terminal) this.commandTerminals.set(id, terminal);
        if (approval) this.commandApprovals.set(id, approval);
        this.deps.emit(this, {
          type: "toolOutput",
          id,
          text: "",
          where,
          ...(approval ? { approval } : {}),
          ...(terminal ? { terminal } : {}),
        });
      },
    });
    this.activeTools = tools;
    this.toolIdsByCall.clear();
    this.callIdsByTool.clear();
    // Subagents: research helpers that read in parallel, with the models of the user.
    const subagents = settings.subagents.enabled && mode.tools.has("read");
    const limiter = new Limiter(settings.subagents.maxParallel);
    const definitions = [
      ...(await tools.definitions()),
      ...(subagents
        ? [
            delegateTool(
              this.deps.models.profiles().profiles.map((item) => ({ id: item.id, name: item.name })),
              settings.subagents,
            ),
          ]
        : []),
    ];
    const memory = settings.memoryEnabled ? await this.deps.memory.notes(this.root.uri) : { project: [], personal: [] };
    const skills = settings.skillsEnabled
      ? await this.deps.skills.list(roots.roots.map((root) => vscode.Uri.file(root.path)))
      : [];
    const basePrompt = buildSystemPrompt({
      mode,
      workspaceName: this.worktree ? `${this.root.name} (worktree on branch ${this.worktree.branch})` : this.root.name,
      platform: `${os.platform()} ${os.release()}`,
      shell: vscode.env.shell || "default",
      date: new Date().toISOString().slice(0, 10),
      rules: ruleSet.prompt,
      verifyCommand: settings.verifyCommand || undefined,
      mcpTools: tools.mcpToolNames,
      memory: memoryPrompt(memory.project, memory.personal),
      brief: await projectBrief(this.root.uri),
    });
    const extra = [
      personaPrompt(settings.assistant),
      await this.handoffHint(settings),
      roots.multi ? roots.describe() : "",
      skillsPrompt(skills),
      planPrompt(this.currentPlan),
    ].filter(Boolean);
    const systemPrompt = [basePrompt, ...extra].join("\n\n");
    // What fills the request, for the log: a change of the system prompt between messages breaks the cache.
    this.requestShape = {
      system: Math.round(systemPrompt.length / 4),
      tools: Math.round(JSON.stringify(definitions).length / 4),
      fingerprint: fingerprint(systemPrompt),
    };
    const window = profile.contextWindow ?? settings.defaultContextWindow;

    let assistantId: string | undefined;
    let reasoningId: string | undefined;
    let reasoningText = "";
    const toolIds = new Map<string, string>();
    /** Removes the part of an answer that a failed request left, before the request goes out again. */
    const discardPartial = () => {
      if (assistantId) this.emit({ type: "assistantDiscard", id: assistantId });
      if (reasoningId) this.emit({ type: "assistantDiscard", id: reasoningId });
      assistantId = undefined;
      reasoningId = undefined;
      reasoningText = "";
    };
    // The model of the chat, then its fallback models, when the user chose any.
    const profiles = this.deps.models.profiles().profiles;
    const steps = [
      profile,
      ...fallbackChain(profile.id, profiles)
        .slice(1)
        .flatMap((id) => profiles.filter((item) => item.id === id)),
    ];
    let answering = profile;
    const client = new FallbackClient(
      steps.map((step, index) => ({
        name: step.name,
        client: () => (index === 0 ? Promise.resolve(primary) : this.deps.models.client(step)),
      })),
      (from, to, error) => {
        const failed = steps[from] as ModelProfile;
        answering = steps[to] as ModelProfile;
        discardPartial();
        meter.usePrice(answering.price);
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.warn(`${failed.name} failed, ${answering.name} takes over: ${message}`);
        this.notice("warning", `${failed.name} ${fallbackReason(error)}. ${answering.name} goes on with the task.`);
        this.fallbackName = answering.name;
        this.deps.onChange(this);
        this.deps.notify(this, "fallback");
      },
    );
    const verify = mode.tools.has("edit") && settings.verifyCommand ? () => this.verify(settings, signal) : undefined;
    const endReasoning = () => {
      if (reasoningId) this.emit({ type: "reasoningEnd", id: reasoningId, text: reasoningText });
      reasoningId = undefined;
      reasoningText = "";
    };

    return runAgent({
      client,
      systemPrompt,
      history: this.history,
      tools: definitions,
      executeTool: (call, toolSignal) =>
        call.name === delegateToolName && subagents
          ? this.runSubagent(call, toolSignal, { settings, meter, limiter, rules: ruleSet.prompt })
          : tools.execute(call, toolSignal),
      concurrent: (call) => call.name === delegateToolName,
      verify,
      maxVerifyAttempts: settings.verifyMaxAttempts,
      requireChanges: mode.tools.has("edit") && request.kind === "fix",
      maxSteps: settings.maxSteps,
      meter,
      signal,
      requestControl: this.requestControl,
      beforeStep: async () => {
        // What changed in the terminals since the last step: a server that ended, a shell that closed.
        const terminalNote = terminalEventsNote(this.shellRegistry?.takeEvents() ?? []);
        const last = this.history.at(-1);
        if (terminalNote && last && (last.role === "tool" || last.role === "user") && typeof last.content === "string")
          this.history[this.history.length - 1] = { ...last, content: `${last.content}\n\n${terminalNote}` };
        // Large outputs of old steps leave the context, in batches, so the prompt cache keeps working.
        const pruned = pruneStaleToolResults(this.history);
        if (pruned.removed > 0) {
          this.history.splice(0, this.history.length, ...pruned.history);
          this.deps.log.info(
            `Context: removed ${pruned.removed} old tool outputs, about ${Math.round(pruned.savedChars / 4)} tokens.`,
          );
        }
        for (const item of this.queue.splice(0)) {
          await this.pushUser(
            item.text,
            item.attachments,
            settings,
            `cp_${Date.now().toString(36)}_${++this.counter}`,
            undefined,
            true,
          );
          this.emitQueue();
        }
        const used = this.lastInputTokens || estimateTokens(this.history);
        if (settings.autoCompact && used > window * settings.compactAt) {
          try {
            await this.compact(client, signal);
          } catch (error) {
            this.deps.log.warn(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
      events: {
        onRequestRestart: () => {
          discardPartial();
          this.notice("info", `Sent the request to ${answering.name} again.`);
        },
        onReasoning: (delta) => {
          if (!settings.showThinking) return;
          if (!reasoningId) reasoningId = `r_${++this.counter}_${Date.now().toString(36)}`;
          reasoningText += delta;
          this.emit({ type: "reasoningDelta", id: reasoningId, text: delta });
        },
        onText: (delta) => {
          endReasoning();
          if (!assistantId) {
            assistantId = `a_${++this.counter}_${Date.now().toString(36)}`;
            this.emit({ type: "assistantStart", id: assistantId });
          }
          this.emit({ type: "assistantDelta", id: assistantId, text: delta });
        },
        onAssistant: (content) => {
          endReasoning();
          if (assistantId) this.emit({ type: "assistantEnd", id: assistantId, text: content });
          assistantId = undefined;
        },
        onRetry: (info) =>
          this.notice(
            "warning",
            `${answering.name}: ${info.reason}. Retrying in ${Math.ceil(info.delayMs / 1000)} s (attempt ${info.attempt} of ${info.maxAttempts}).`,
          ),
        onToolStart: (call) => {
          // A subagent has its own card.
          if (call.name === delegateToolName) return;
          const id = `t_${++this.counter}_${Date.now().toString(36)}`;
          toolIds.set(call.id, id);
          this.toolIdsByCall.set(call.id, id);
          this.callIdsByTool.set(id, call.id);
          const command = ToolHost.commandOf(call);
          const description = ToolHost.descriptionOf(call);
          this.emit({
            type: "tool",
            id,
            name: call.name,
            summary: ToolHost.summarize(call),
            status: "running",
            ...(command ? { command } : {}),
            ...(description ? { description } : {}),
          });
        },
        onToolEnd: (call, toolResult) => {
          this.flushOutput();
          this.journalTool(call, toolResult.content);
          if (call.name === delegateToolName) return;
          this.emit({
            type: "tool",
            id: toolIds.get(call.id) ?? call.id,
            name: call.name,
            summary: ToolHost.summarize(call),
            ...(ToolHost.commandOf(call) ? { command: ToolHost.commandOf(call) } : {}),
            ...(ToolHost.descriptionOf(call) ? { description: ToolHost.descriptionOf(call) } : {}),
            ...(this.commandWhere.has(toolIds.get(call.id) ?? "")
              ? { where: this.commandWhere.get(toolIds.get(call.id) ?? "") }
              : {}),
            ...(this.commandApprovals.has(toolIds.get(call.id) ?? "")
              ? { approval: this.commandApprovals.get(toolIds.get(call.id) ?? "") }
              : {}),
            ...(this.commandTerminals.has(toolIds.get(call.id) ?? "")
              ? { terminal: this.commandTerminals.get(toolIds.get(call.id) ?? "") }
              : {}),
            status: toolResult.content.startsWith("Error:") ? "error" : "done",
            // Commands keep more of their output, so the terminal in the chat can show it.
            detail: truncateMiddle(toolResult.content, call.name === "run_command" ? 30_000 : 4000),
          });
        },
        onUsage: (usage) => {
          if (usage.lastInputTokens > 0) this.lastInputTokens = usage.lastInputTokens;
          this.deps.onChange(this);
        },
        onVerify: (attempt, verification) => {
          this.verifyAttempts = attempt;
          this.journal({
            t: "verify",
            at: Date.now(),
            command: settings.verifyCommand,
            passed: verification.passed,
            attempt,
          });
          this.emit({
            type: "verify",
            attempt,
            passed: verification.passed,
            output: truncateMiddle(verification.output, 4000),
          });
        },
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
    startedAt = Date.now(),
  ): Promise<void> {
    const status = aborted ? "aborted" : (result?.status ?? "error");
    const success = status === "done";
    const changedFiles = [...(this.checkpoints.list().at(-1)?.files.keys() ?? [])];
    const filesChanged = changedFiles.length;
    this.journal({ t: "task", at: Date.now(), status, files: changedFiles, message: result?.message?.slice(0, 500) });
    if (
      !aborted &&
      settings.handoff.enabled &&
      (settings.handoff.auto === "always" || (settings.handoff.auto === "changes" && filesChanged > 0))
    )
      void this.writeHandoff(false);
    const bugFixed = success && filesChanged > 0 && (request.kind === "fix" || result?.verified === true);
    await this.deps.stats.record({ success, bugFixed, filesChanged, tokens: meter.tokens, cost: meter.cost ?? 0 });
    const fresh = await this.deps.stats.recordTask({
      date: new Date(),
      success,
      bugFixed,
      verifiedFirstTry: result?.verified === true && this.verifyAttempts === 1,
      tokens: meter.tokens,
      cost: meter.cost ?? 0,
      model: this.profile()?.model ?? "",
    });
    for (const id of fresh) {
      const achievement = achievementList.find((item) => item.id === id);
      if (achievement) this.emit({ type: "achievement", achievement });
    }
    const checkpoint = this.checkpoints.list().at(-1);
    if (checkpoint && changedFiles.length > 0) {
      const files = await this.changesOf(checkpoint.files);
      if (files.length > 0)
        this.emit({
          type: "summary",
          checkpointId: checkpoint.id,
          status,
          seconds: (Date.now() - startedAt) / 1000,
          files,
          ...(settings.verifyCommand && this.verifyAttempts > 0
            ? {
                check: {
                  command: settings.verifyCommand,
                  passed: result?.verified === true,
                  attempts: this.verifyAttempts,
                },
              }
            : {}),
          pending: this.deps.reviews.pendingFiles.length,
        });
    }
    // A task that went well is a good moment to ask for a rating, now and then; never during work.
    if (!aborted && this.deps.rating) {
      const store = await this.deps.rating.maybeAsk(
        success && (filesChanged > 0 || result?.verified === true),
        settings.askForRating,
      );
      if (store) this.emit({ type: "ratingAsk", store });
    }
    this.emit({
      type: "taskEnd",
      status,
      message: aborted ? "Stopped." : result?.message,
      verified: result?.verified === true,
      celebrate: settings.celebrate && success && filesChanged > 0,
      reviewFiles: this.deps.reviews.pendingFiles.length,
    });
    this.deps.log.info(
      `Request: system ≈${this.requestShape?.system ?? 0} tokens (#${this.requestShape?.fingerprint ?? "-"}), tools ≈${this.requestShape?.tools ?? 0}, history ≈${Math.round(estimateTokens(this.history))}; cache read ${meter.cachedTokens}, written ${meter.cacheWriteTokens}.`,
    );
    this.deps.log.info(
      `Task ${status}: steps=${result?.steps ?? 0} files=${filesChanged} tokens=${meter.tokens}${meter.cachedTokens > 0 ? ` cached=${Math.round((meter.cachedTokens / Math.max(1, meter.inputTokens)) * 100)}%` : ""}${meter.cost !== undefined ? ` cost=${formatCost(meter.cost)}` : ""}`,
    );
    if (bugFixed && request.kind === "fix") void vscode.window.setStatusBarMessage("$(check) Phew! Fixed.", 5000);
  }
}
