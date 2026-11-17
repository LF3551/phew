import * as os from "node:os";
import * as vscode from "vscode";
import { achievementList } from "../core/achievements";
import { type AgentResult, runAgent, type VerificationResult } from "../core/agent";
import type { Attachment } from "../core/attachments";
import { type ChatMessage, type ModelClient, trimHistory, truncateMiddle } from "../core/chat";
import { CheckpointStore } from "../core/checkpoints";
import { decideCommand } from "../core/commandPolicy";
import {
  applyCompaction,
  buildCompactionMessages,
  contextUsage,
  estimateTokens,
  splitForCompaction,
} from "../core/compaction";
import { CostMeter, formatCost, formatTokens } from "../core/cost";
import { titleFromText } from "../core/export";
import { canChange, findMode, type Mode, type ModeDefinition } from "../core/modes";
import { personaPrompt } from "../core/persona";
import { emptyPlan, type Plan, planPrompt } from "../core/plan";
import { buildSystemPrompt } from "../core/prompts";
import { RootSet } from "../core/roots";
import { skillsPrompt } from "../core/skills";
import type { ModelProfile } from "../providers/profile";
import type { CommandSetting, HostMessage, ReviewSetting } from "../shared/protocol";
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
}

export interface FileClaimRegistry {
  claim(sessionId: string, path: string): void;
  owner(path: string, exceptSessionId: string): string | undefined;
  release(sessionId: string): void;
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
  readonly skills: SkillStore;
  readonly terminal: TerminalWatcher;
  readonly modes: () => readonly ModeDefinition[];
  readonly claims: FileClaimRegistry;
  /** Delivers a message of this session to the views that show it. */
  readonly emit: (session: AgentSession, message: HostMessage) => void;
  readonly onChange: (session: AgentSession) => void;
  readonly persist: (session: AgentSession) => Promise<void>;
  /** Tells the user that the session finished or needs input, for example with a notification and a sound. */
  readonly notify: (session: AgentSession, event: "done" | "failed" | "input") => void;
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
    const transient = ["state", "sessions", "mentions", "addAttachment", "focusInput", "openPanel", "queue", "sound"];
    if (transient.includes(stamped.type)) return stamped;
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
export class AgentSession {
  readonly broker: ApprovalBroker;
  readonly transcript: Transcript;
  readonly createdAt: number;
  private checkpoints: CheckpointStore;
  private readonly changes: ChangeManager;
  private history: ChatMessage[];
  private modeId: Mode;
  private controller: AbortController | undefined;
  private readonly side = new Set<AbortController>();
  private counter = 0;
  private sessionTokens: number;
  private sessionCost: number;
  private lastInputTokens = 0;
  private verifyAttempts = 0;
  private queue: QueuedMessage[] = [];
  private currentPlan: Plan;
  overrides: ApprovalOverrides;
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
    this.modeId = restored?.mode ?? readSettings(root.uri).defaultMode;
    this.title = restored?.title ?? (worktree ? `Agent: ${worktree.branch}` : "New chat");
    this.createdAt = restored?.createdAt ?? Date.now();
    this.updatedAt = restored?.updatedAt ?? this.createdAt;
    this.sessionTokens = restored?.tokens ?? 0;
    this.sessionCost = restored?.cost ?? 0;
    this.currentPlan = restored?.plan ?? emptyPlan;
    this.overrides = restored?.overrides ?? {};
  }

  get busy(): boolean {
    return this.controller !== undefined;
  }

  get needsApproval(): boolean {
    return this.broker.pendingCount > 0;
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
    this.deps.onChange(this);
    void this.deps.persist(this);
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
      plan: this.currentPlan,
      overrides: this.overrides,
    };
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
    const command = /^\/(btw|goal|compact)\b\s*([\s\S]*)$/i.exec(text.trim());
    if (command) {
      const [, name, rest] = command;
      if (name.toLowerCase() === "btw") await this.btw(rest.trim() || "What are you doing right now?");
      else if (name.toLowerCase() === "goal") this.setGoal(rest.trim());
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

    const checkpointId = `cp_${Date.now().toString(36)}_${++this.counter}`;
    this.checkpoints.begin(checkpointId, request.display ?? request.text);
    if (this.history.length === 0) this.title = titleFromText(request.display ?? request.text);
    await this.pushUser(request.text, request.attachments ?? [], settings, checkpointId, request.display);

    const meter = new CostMeter(profile.price, settings.budget);
    this.verifyAttempts = 0;
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
      this.deps.claims.release(this.id);
    }
    await this.finish(request, result, controller.signal.aborted, meter, settings);
    this.deps.onChange(this);
    await this.deps
      .persist(this)
      .catch((error: unknown) => this.deps.log.warn(`Could not save the chat: ${String(error)}`));
    this.deps.notify(this, controller.signal.aborted ? "failed" : result?.status === "done" ? "done" : "failed");

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

  /** Restores the first checkpoint without a confirmation. Only the integration tests use it. */
  async restoreFirstForTest(): Promise<void> {
    const first = this.checkpoints.list()[0];
    if (first) await this.restore(first.id, this.checkpoints.changedSince(first.id));
  }

  dispose(): void {
    this.stop();
  }

  private profile(): ModelProfile | undefined {
    const modeModel = this.mode.model;
    const profiles = this.deps.models.profiles().profiles;
    return (modeModel && profiles.find((profile) => profile.id === modeModel)) || this.deps.models.active();
  }

  private async pushUser(
    text: string,
    attachments: readonly Attachment[],
    settings: Settings,
    checkpointId: string,
    display?: string,
    queued = false,
  ): Promise<void> {
    const resolved = await resolveAttachments(attachments, this.root.uri, settings, this.deps.terminal);
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
    this.history.push({ role: "user", content, ...(resolved.images.length > 0 ? { images: resolved.images } : {}) });
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

  private emit(message: HostMessage): void {
    this.deps.emit(this, this.transcript.add(message));
  }

  private emitQueue(): void {
    this.emit({ type: "queue", items: this.queued });
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.emit({ type: "notice", level, text });
  }

  /** Summarizes the older part of the history. Returns true when the history became shorter. */
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
    const client = await this.deps.models.client(profile);
    const roots = this.roots;
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
      skills: this.deps.skills,
      plan: {
        get: () => this.currentPlan,
        set: (plan) => {
          this.currentPlan = plan;
          this.emit({ type: "plan", plan });
        },
      },
      log: this.deps.log,
    });
    const definitions = await tools.definitions();
    const memory = settings.memoryEnabled ? await this.deps.memory.read(this.root.uri) : [];
    const skills = settings.skillsEnabled
      ? await this.deps.skills.list(roots.roots.map((root) => vscode.Uri.file(root.path)))
      : [];
    const basePrompt = buildSystemPrompt({
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
    const extra = [
      personaPrompt(settings.assistant),
      roots.multi ? roots.describe() : "",
      skillsPrompt(skills),
      planPrompt(this.currentPlan),
    ].filter(Boolean);
    const systemPrompt = [basePrompt, ...extra].join("\n\n");
    const window = profile.contextWindow ?? settings.defaultContextWindow;

    let assistantId: string | undefined;
    let reasoningId: string | undefined;
    let reasoningText = "";
    const toolIds = new Map<string, string>();
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
      executeTool: (call, toolSignal) => tools.execute(call, toolSignal),
      verify,
      maxVerifyAttempts: settings.verifyMaxAttempts,
      requireChanges: mode.tools.has("edit") && request.kind === "fix",
      maxSteps: settings.maxSteps,
      meter,
      signal,
      beforeStep: async () => {
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
            `${profile.name}: ${info.reason}. Retrying in ${Math.ceil(info.delayMs / 1000)} s (attempt ${info.attempt} of ${info.maxAttempts}).`,
          ),
        onToolStart: (call) => {
          const id = `t_${++this.counter}_${Date.now().toString(36)}`;
          toolIds.set(call.id, id);
          this.emit({ type: "tool", id, name: call.name, summary: ToolHost.summarize(call), status: "running" });
        },
        onToolEnd: (call, toolResult) => {
          this.emit({
            type: "tool",
            id: toolIds.get(call.id) ?? call.id,
            name: call.name,
            summary: ToolHost.summarize(call),
            status: toolResult.content.startsWith("Error:") ? "error" : "done",
            detail: truncateMiddle(toolResult.content, 4000),
          });
        },
        onUsage: (usage) => {
          if (usage.lastInputTokens > 0) this.lastInputTokens = usage.lastInputTokens;
          this.deps.onChange(this);
        },
        onVerify: (attempt, verification) => {
          this.verifyAttempts = attempt;
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
  ): Promise<void> {
    const status = aborted ? "aborted" : (result?.status ?? "error");
    const success = status === "done";
    const filesChanged = this.checkpoints.list().at(-1)?.files.size ?? 0;
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
