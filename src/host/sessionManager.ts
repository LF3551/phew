import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { achievementList, wrapped } from "../core/achievements";
import type { ActivityCounts } from "../core/activity";
import { type ApprovalLevel, approvalPresets } from "../core/approvals";
import { chatPreview } from "../core/chatList";
import { conversationToMarkdown } from "../core/export";
import { builtInModes, type ModeDefinition, parseCustomModes } from "../core/modes";
import { type Assistant, defaultAssistant, parseAssistant } from "../core/persona";
import { type SetupOption, setupOptions } from "../core/setupOptions";
import { type WhatsNew, whatsNewFor } from "../core/whatsNew";
import { branchName, isValidBranch, worktreeFolder } from "../core/worktree";
import type { HostMessage, SessionSummary, ViewState } from "../shared/protocol";
import { ConversationStore, type StoredConversation } from "./conversationStore";
import { git, gitOrThrow, repositoryRoot } from "./git";
import { providerNames } from "./models";
import { AgentSession, type SessionDependencies, type TaskRequest, type WorktreeInfo } from "./session";
import { readSettings, updateSetting } from "./settings";
import type { SuggestionProvider } from "./suggestions";

export type { AgentSession };

type SharedDependencies = Omit<SessionDependencies, "emit" | "onChange" | "persist" | "modes" | "claims" | "notify">;

/** A chat view: the side bar follows the active chat, and an editor tab shows one pinned chat. */
export interface ChatViewHandle {
  readonly pinnedId?: string;
  readonly visible: boolean;
  post(message: HostMessage): void;
}

/** Keeps all chat sessions of the window, the saved history, and the worktree agents. */
export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private activeId = "";
  private readonly store: ConversationStore;
  private readonly views = new Set<ChatViewHandle>();
  private readonly fileClaims = new Map<string, string>();
  private customModes: ModeDefinition[] = [];
  private workspaceModes: ModeDefinition[] = [];
  private counter = 0;
  private notifiedApprovals = new Set<string>();
  private readonly unseen = new Set<string>();

  constructor(
    private readonly deps: SharedDependencies,
    private readonly onBusyChange: (running: number) => void,
  ) {
    const storage = deps.context.storageUri ?? vscode.Uri.joinPath(deps.context.globalStorageUri, "no-workspace");
    this.store = new ConversationStore(vscode.Uri.joinPath(storage, "chats"), () => readSettings().historyLimit);
    this.reloadModes();
  }

  /** Connects a chat view. Returns a function that disconnects it. */
  attach(view: ChatViewHandle): () => void {
    this.views.add(view);
    return () => this.views.delete(view);
  }

  get activeSessionId(): string {
    return this.activeId;
  }

  /** The session that a view shows. */
  sessionFor(view: ChatViewHandle): AgentSession | undefined {
    return view.pinnedId ? this.sessions.get(view.pinnedId) : this.active;
  }

  session(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  /** Loads a saved chat without making it the active chat, for example to open it in an editor tab. */
  async restore(id: string): Promise<AgentSession | undefined> {
    const open = this.sessions.get(id);
    if (open) return open;
    const stored = await this.store.load(id);
    if (!stored) return undefined;
    const root = stored.worktree
      ? { uri: vscode.Uri.file(stored.worktree.path), name: path.basename(stored.worktree.path) }
      : this.defaultRoot();
    return root ? this.create(root, stored.id, stored.worktree, stored) : undefined;
  }

  private get pinnedChats(): Set<string> {
    return new Set(this.deps.context.workspaceState.get<string[]>("phew.pinnedChats", []));
  }

  /** Pinned chats stay at the top of the chat list. */
  async pin(id: string, pinned: boolean): Promise<void> {
    const ids = this.pinnedChats;
    if (pinned) ids.add(id);
    else ids.delete(id);
    await this.deps.context.workspaceState.update("phew.pinnedChats", [...ids]);
    await this.postSessions();
  }

  private shows(view: ChatViewHandle, session: AgentSession): boolean {
    return view.pinnedId ? view.pinnedId === session.id : session.id === this.activeId;
  }

  /** Sends a message to the views of the active session, or to all views. */
  private post(message: HostMessage, session = this.active): void {
    for (const view of this.views) if (!session || this.shows(view, session)) view.post(message);
  }

  /** Creates the first session, or restores the last chat of this workspace. */
  async initialize(): Promise<void> {
    await this.loadWorkspaceModes();
    const root = this.defaultRoot();
    if (readSettings().restoreLastChat && root) {
      const last = (await this.store.list()).find((item) => !item.worktree);
      const stored = last ? await this.store.load(last.id) : undefined;
      if (stored && stored.root === root.uri.fsPath) {
        const session = this.create(root, stored.id, undefined, stored);
        this.activeId = session.id;
        return;
      }
    }
    this.newSession();
  }

  get active(): AgentSession | undefined {
    return this.sessions.get(this.activeId);
  }

  get runningCount(): number {
    return [...this.sessions.values()].filter((session) => session.busy).length;
  }

  /** Chats that wait for the user, and chats that finished while the side bar was hidden. */
  get activity(): ActivityCounts {
    return {
      waiting: [...this.sessions.values()].filter((session) => session.needsApproval).length,
      unseen: [...this.unseen].filter((id) => this.sessions.has(id)).length,
    };
  }

  /** The user looks at the chats now, so finished chats are no longer news. */
  markSeen(): void {
    if (this.unseen.size === 0) return;
    this.unseen.clear();
    this.onBusyChange(this.runningCount);
  }

  /** "New in Phew" after an update, worked out once; undefined until then. */
  private whatsNewState: { value: WhatsNew | undefined } | undefined;

  /** "New in Phew" after an update; a fresh install remembers its version and shows nothing. */
  private get whatsNew(): WhatsNew | undefined {
    if (!this.whatsNewState) {
      const current = String(this.deps.context.extension.packageJSON.version ?? "");
      const seen = this.deps.context.globalState.get<string>("phew.seenVersion");
      if (!seen) void this.deps.context.globalState.update("phew.seenVersion", current);
      this.whatsNewState = { value: whatsNewFor(current, seen) };
    }
    return this.whatsNewState.value;
  }

  /** Closes "New in Phew" until the next minor version. */
  async dismissWhatsNew(): Promise<void> {
    this.whatsNewState = { value: undefined };
    await this.deps.context.globalState.update(
      "phew.seenVersion",
      String(this.deps.context.extension.packageJSON.version ?? ""),
    );
    this.postState();
  }

  /** The options of the first-run card: ready providers, free ones, and the private one. */
  async setupOptions(): Promise<SetupOption[]> {
    // GitHub Copilot comes only to VS Code itself, not to editors that are based on it.
    const copilotPossible = /visual studio code/i.test(vscode.env.appName);
    return setupOptions(await this.deps.models.detectProviders(), copilotPossible);
  }

  modes(): ModeDefinition[] {
    return [...builtInModes, ...this.customModes, ...this.workspaceModes];
  }

  reloadModes(): void {
    const parsed = parseCustomModes(readSettings().customModes);
    this.customModes = parsed.modes;
    for (const error of parsed.errors) this.deps.log.warn(`phew.modes: ${error}`);
  }

  /** Reads `.phew/modes.json` of the workspace. Only trusted workspaces can add modes. */
  async loadWorkspaceModes(): Promise<void> {
    this.workspaceModes = [];
    const root = this.defaultRoot();
    if (!root || !vscode.workspace.isTrusted) return;
    try {
      const text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, ".phew/modes.json")),
      );
      const parsed = parseCustomModes(JSON.parse(text), [...builtInModes, ...this.customModes]);
      this.workspaceModes = parsed.modes;
      for (const error of parsed.errors) this.deps.log.warn(`.phew/modes.json: ${error}`);
    } catch {
      // No workspace modes.
    }
  }

  state(view?: ChatViewHandle): ViewState {
    const session = view ? this.sessionFor(view) : this.active;
    const settings = readSettings();
    const effective = session?.effectiveSettings() ?? settings;
    const context = session?.contextState() ?? { share: 0, label: "" };
    const active = this.deps.models.active();
    const allProfiles = this.deps.models.profiles().profiles;
    // A mode can name its own model; then that model answers, whatever the menu says.
    const modeModelId = session?.mode.model;
    const modeProfile = modeModelId ? allProfiles.find((item) => item.id === modeModelId) : undefined;
    const profile = modeProfile ?? active;
    return {
      sessionId: session?.id ?? "",
      title: session?.title ?? "New chat",
      worktree: session?.worktree?.branch,
      mode: session?.mode.id ?? settings.defaultMode,
      modes: this.modes().map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
        changes: mode.tools.has("edit") || mode.tools.has("command"),
        builtIn: mode.builtIn,
      })),
      model: profile?.name ?? "No model",
      modelId: profile?.model ?? "",
      terminals: session?.terminals ?? [],
      models: allProfiles.map((item) => ({
        id: item.id,
        name: item.name,
        provider: item.provider,
        model: item.model,
        ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
        active: item.id === active?.id,
      })),
      ...(modeProfile ? { modeModel: modeProfile.name } : {}),
      provider: profile ? providerNames[profile.provider] : "Not configured",
      configured: profile !== undefined,
      busy: session?.busy ?? false,
      trusted: vscode.workspace.isTrusted,
      tokens: session?.usage.tokens ?? "0",
      cost: session?.usage.cost ?? "",
      celebrate: settings.celebrate,
      stats: this.deps.stats.summary(settings.minutesPerBug),
      approvals: {
        review: effective.reviewMode,
        commands: effective.commands.mode,
        mcp: effective.mcpAutoApprove,
        custom: Object.values(session?.overrides ?? {}).some((value) => value !== undefined),
        defaults: { review: settings.reviewMode, commands: settings.commands.mode, mcp: settings.mcpAutoApprove },
        allowlist: effective.commands.autoApprove.slice(0, 50),
      },
      reviewFiles: this.deps.reviews.pendingFiles.length,
      runningSessions: this.runningCount,
      context: context.share,
      contextLabel: context.label,
      fontSize: settings.fontSize,
      sendWith: settings.sendWith,
      appearance: settings.appearance,
      assistant: {
        name: settings.assistant.name,
        avatar: settings.assistant.avatar,
        persona: settings.assistant.persona,
        customPersona: settings.assistant.customPersona,
        userName: settings.assistant.userName,
        language: settings.assistant.language,
      },
      onboarding: !this.deps.context.globalState.get<boolean>("phew.assistantIntroduced"),
      ...(this.whatsNew ? { whatsNew: this.whatsNew } : {}),
      handoff: session && settings.handoff.enabled ? this.deps.handoffs.latest(session.root.uri.fsPath) : undefined,
      showThinking: settings.showThinking,
      pinned: view?.pinnedId !== undefined,
    };
  }

  postState(): void {
    for (const view of this.views) view.post({ type: "state", state: this.state(view) });
    this.updateMenuContext();
  }

  private menuContext = new Map<string, boolean>();

  /** Hides menu items that do nothing now: actions on an empty chat, or a handoff note that does not exist. */
  private updateMenuContext(): void {
    const session = this.active;
    const root = session?.root.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const keys: Record<string, boolean> = {
      "phew.chatEmpty": session?.isEmpty ?? true,
      "phew.hasHandoff":
        root !== undefined && readSettings().handoff.enabled && this.deps.handoffs.latest(root) !== undefined,
    };
    for (const [key, value] of Object.entries(keys)) {
      if (this.menuContext.get(key) === value) continue;
      this.menuContext.set(key, value);
      void vscode.commands.executeCommand("setContext", key, value);
    }
  }

  /** Sends the transcript of the session of each view, for example when a view opens or the active chat changes. */
  replay(only?: ChatViewHandle): void {
    for (const view of only ? [only] : this.views) {
      if (!only && view.pinnedId) continue;
      const session = this.sessionFor(view);
      view.post({ type: "cleared" });
      for (const message of session?.transcript.all() ?? []) view.post(message);
      if (session) {
        view.post({ type: "queue", items: session.queued });
        view.post({ type: "plan", plan: session.plan });
      }
      view.post({ type: "state", state: this.state(view) });
    }
  }

  async run(request: TaskRequest): Promise<void> {
    const session = this.active ?? this.newSession();
    if (!session) return;
    await session.run(request);
  }

  /** Creates a chat that is not active, for example for an editor tab. */
  createDetached(): AgentSession | undefined {
    const root = this.defaultRoot();
    return root ? this.create(root) : undefined;
  }

  async rename(id?: string): Promise<void> {
    const session = this.sessions.get(id ?? this.activeId);
    if (!session) return;
    const title = await vscode.window.showInputBox({
      title: "Phew: Rename chat",
      value: session.title,
      validateInput: (value) => (value.trim() ? undefined : "Enter a name."),
    });
    if (title) session.rename(title);
    await this.postSessions();
  }

  newSession(): AgentSession | undefined {
    const current = this.active;
    if (current?.isEmpty && !current.busy && !current.worktree) {
      this.replay();
      return current;
    }
    const root = this.defaultRoot();
    if (!root) {
      this.post({
        type: "notice",
        level: "warning",
        text: "Open a folder first. Phew works inside a workspace folder.",
      });
      return undefined;
    }
    const session = this.create(root);
    this.activeId = session.id;
    this.dropIdleEmpty();
    this.replay();
    return session;
  }

  switchTo(id: string): void {
    if (!this.sessions.has(id)) return;
    this.activeId = id;
    this.replay();
  }

  async openConversation(id: string): Promise<void> {
    if (this.sessions.has(id)) {
      this.switchTo(id);
      return;
    }
    const stored = await this.store.load(id);
    if (!stored) {
      this.post({ type: "notice", level: "warning", text: "This chat is no longer available." });
      return;
    }
    const root = stored.worktree
      ? { uri: vscode.Uri.file(stored.worktree.path), name: path.basename(stored.worktree.path) }
      : this.defaultRoot();
    if (!root) return;
    if (stored.worktree && !fs.existsSync(stored.worktree.path)) {
      this.post({
        type: "notice",
        level: "warning",
        text: `The worktree ${stored.worktree.path} no longer exists. The chat is read-only.`,
      });
    }
    const session = this.create(root, stored.id, stored.worktree, stored);
    this.activeId = session.id;
    this.dropIdleEmpty();
    this.replay();
  }

  async deleteConversation(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session?.busy) {
      this.post({ type: "notice", level: "warning", text: "Stop this chat before you delete it." });
      return;
    }
    await this.store.delete(id);
    if (this.pinnedChats.has(id)) await this.pin(id, false);
    if (session) {
      session.dispose();
      this.sessions.delete(id);
      if (this.activeId === id) this.newSession();
    }
    await this.postSessions();
  }

  async postSessions(only?: ChatViewHandle): Promise<void> {
    const pinned = this.pinnedChats;
    const sessions: SessionSummary[] = [...this.sessions.values()]
      // An empty new chat is where the user already is, so the list does not show it.
      .filter((session) => !session.isEmpty)
      .map((session) => {
        const preview = chatPreview(session.conversation, session.title);
        return {
          id: session.id,
          title: session.title,
          running: session.busy,
          active: session.id === this.activeId,
          needsApproval: session.needsApproval,
          updatedAt: session.updatedAt,
          ...(pinned.has(session.id) ? { pinned: true } : {}),
          ...(preview ? { preview } : {}),
          ...(session.worktree ? { worktree: session.worktree.branch } : {}),
        };
      });
    const open = new Set(sessions.map((session) => session.id));
    const history = (await this.store.list())
      .filter((item) => !open.has(item.id))
      .map((item) => (pinned.has(item.id) ? { ...item, pinned: true } : item));
    for (const view of only ? [only] : this.views) view.post({ type: "sessions", sessions, history });
  }

  /** Exports an open chat or a saved chat from the history as Markdown. */
  async exportChat(id: string): Promise<void> {
    const open = this.sessions.get(id);
    if (open) {
      await this.exportActive(open);
      return;
    }
    const stored = await this.store.load(id);
    if (!stored || stored.history.length === 0) {
      void vscode.window.showInformationMessage("Phew: this chat is no longer available.");
      return;
    }
    const markdown = conversationToMarkdown(stored.history, {
      title: stored.title,
      mode: stored.mode,
      date: new Date(stored.createdAt),
    });
    const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
    await vscode.window.showTextDocument(document);
  }

  async exportActive(target?: AgentSession): Promise<void> {
    const session = target ?? this.active;
    if (!session || session.isEmpty) {
      void vscode.window.showInformationMessage("Phew: the chat is empty.");
      return;
    }
    const markdown = conversationToMarkdown(session.conversation, {
      title: session.title,
      model: this.deps.models.active()?.name,
      mode: session.mode.name,
      date: new Date(session.createdAt),
    });
    const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
    await vscode.window.showTextDocument(document);
  }

  /** Starts an agent in a new Git worktree, so it works in parallel without touching the current files. */
  async newWorktreeAgent(): Promise<void> {
    const root = this.defaultRoot();
    if (!root || !vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("Phew: open a trusted folder in a Git repository first.");
      return;
    }
    const repository = await repositoryRoot(root.uri.fsPath);
    if (!repository) {
      void vscode.window.showWarningMessage("Phew: this folder is not a Git repository.");
      return;
    }
    const task = await vscode.window.showInputBox({
      title: "Phew: New agent in a worktree (1/2) — task",
      prompt: "The agent works on a new branch in a separate folder. Your current files do not change.",
      placeHolder: "For example: add input validation to the signup form",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "Describe the task."),
    });
    if (!task) return;
    const settings = readSettings();
    const branch = await vscode.window.showInputBox({
      title: "Phew: New agent in a worktree (2/2) — branch",
      value: branchName(task, settings.worktrees.branchPrefix),
      ignoreFocusOut: true,
      validateInput: (value) => (isValidBranch(value.trim()) ? undefined : "Enter a valid branch name."),
    });
    if (!branch) return;
    const folder = worktreeFolder(repository, branch.trim(), settings.worktrees.location);
    try {
      await gitOrThrow(repository, ["worktree", "add", "-b", branch.trim(), folder, "HEAD"]);
    } catch (error) {
      void vscode.window.showErrorMessage(`Phew: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.deps.log.info(`[audit] worktree created: ${folder} on ${branch.trim()}`);
    const info: WorktreeInfo = { path: folder, branch: branch.trim(), repository };
    const session = this.create({ uri: vscode.Uri.file(folder), name: path.basename(folder) }, undefined, info);
    session.setMode("code");
    this.activeId = session.id;
    this.replay();
    void session.run({ text: task.trim(), kind: "chat", mode: "code" }).then(() => this.worktreeDone(session));
  }

  /** Actions for a worktree agent: open, compare, merge, or remove. */
  async worktreeActions(id = this.activeId): Promise<void> {
    const session = this.sessions.get(id);
    const info = session?.worktree;
    if (!session || !info) {
      void vscode.window.showInformationMessage("Phew: the active chat is not a worktree agent.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(git-compare) Show changes", action: "diff" },
        { label: "$(empty-window) Open the worktree in a new window", action: "open" },
        { label: "$(git-merge) Merge the branch into the current branch", action: "merge" },
        { label: "$(trash) Remove the worktree and the branch", action: "remove" },
      ],
      { title: `Phew: ${info.branch}` },
    );
    if (!pick) return;
    if (pick.action === "open") {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(info.path), { forceNewWindow: true });
    } else if (pick.action === "diff") {
      await this.showWorktreeDiff(info);
    } else if (pick.action === "merge") {
      const status = await git(info.path, ["status", "--porcelain"]);
      if (status.stdout.trim()) {
        const commit = await vscode.window.showWarningMessage(
          `The worktree has uncommitted changes. Commit them on ${info.branch} first?`,
          { modal: true },
          "Commit and Merge",
        );
        if (commit !== "Commit and Merge") return;
        await gitOrThrow(info.path, ["add", "-A"]);
        const message = `${session.title.replace(/^Agent: /, "")}`.slice(0, 72);
        const result = await git(info.path, [
          "commit",
          "-m",
          message,
          ...(readSettings().commit.signOff ? ["--signoff"] : []),
        ]);
        if (result.code !== 0) {
          void vscode.window.showErrorMessage(`Phew: git commit failed: ${result.stderr.trim()}`);
          return;
        }
      }
      const answer = await vscode.window.showWarningMessage(
        `Merge ${info.branch} into the current branch?`,
        { modal: true },
        "Merge",
      );
      if (answer !== "Merge") return;
      const result = await git(info.repository, ["merge", "--no-ff", "--no-edit", info.branch]);
      if (result.code === 0) void vscode.window.showInformationMessage(`Phew: merged ${info.branch}.`);
      else
        void vscode.window.showErrorMessage(
          `Phew: merge failed. Resolve it in Git. ${result.stderr.trim().slice(0, 300)}`,
        );
    } else if (pick.action === "remove") {
      const answer = await vscode.window.showWarningMessage(
        `Remove the worktree ${info.path} and delete the branch ${info.branch}? Uncommitted changes are lost.`,
        { modal: true },
        "Remove",
      );
      if (answer !== "Remove") return;
      session.stop();
      // Keep what the agent learned: the note moves to the main repository before the folder is removed.
      const note = await session.writeHandoff(false).catch(() => undefined);
      if (note) {
        try {
          await this.deps.handoffs.ensureGitignore(info.repository);
          await fs.promises.mkdir(path.join(info.repository, ".phew", "handoff"), { recursive: true });
          await fs.promises.copyFile(path.join(info.path, note), path.join(info.repository, note));
          this.deps.log.info(`Handoff of the worktree kept in ${path.join(info.repository, note)}.`);
        } catch (error) {
          this.deps.log.warn(`Could not keep the handoff of the worktree: ${String(error)}`);
        }
      }
      await git(info.repository, ["worktree", "remove", "--force", info.path]);
      await git(info.repository, ["branch", "-D", info.branch]);
      this.deps.log.info(`[audit] worktree removed: ${info.path}`);
      this.sessions.delete(session.id);
      await this.store.delete(session.id);
      if (this.activeId === session.id) this.newSession();
      await this.postSessions();
    }
  }

  /** Changes an approval setting of one chat. The defaults stay in the settings. */
  setApproval(session: AgentSession | undefined, key: "review" | "commands" | "mcp", value: string | boolean): void {
    if (!session) return;
    // A value equal to the default is no override, so the chat counts as "custom" only when it really differs.
    const settings = readSettings();
    const defaults = { review: settings.reviewMode, commands: settings.commands.mode, mcp: settings.mcpAutoApprove };
    session.setOverride(key, defaults[key] === value ? undefined : (value as never));
    this.postState();
  }

  /** Makes a model profile the active model, from the menu under the input. */
  async useModel(id: string): Promise<void> {
    if (!this.deps.models.profiles().profiles.some((profile) => profile.id === id)) return;
    await this.deps.models.setActive(id);
    this.postState();
  }

  /** Sets all three approvals of a chat at once from a level such as Careful or Autopilot. */
  setApprovalLevel(session: AgentSession | undefined, level: ApprovalLevel): void {
    if (!session) return;
    const preset = approvalPresets[level];
    this.setApproval(session, "review", preset.review);
    this.setApproval(session, "commands", preset.commands);
    this.setApproval(session, "mcp", preset.mcp);
  }

  /** Saves the approval settings of a chat as the defaults for new chats. */
  async saveApprovalsAsDefault(session: AgentSession | undefined): Promise<void> {
    if (!session) return;
    const effective = session.effectiveSettings();
    await updateSetting("review.mode", effective.reviewMode);
    await updateSetting("commands.approval", effective.commands.mode);
    await updateSetting("mcp.autoApprove", effective.mcpAutoApprove);
    session.resetOverrides();
    this.postState();
  }

  /** Saves the assistant from the introduction card and hides the card. */
  async introduceAssistant(assistant?: Omit<Assistant, never>): Promise<void> {
    if (assistant) {
      const clean = parseAssistant(assistant);
      await updateSetting("assistant.name", clean.name === defaultAssistant.name ? undefined : clean.name);
      await updateSetting("assistant.avatar", clean.avatar || undefined);
      await updateSetting("assistant.persona", clean.persona === defaultAssistant.persona ? undefined : clean.persona);
      await updateSetting("assistant.customPersona", clean.customPersona || undefined);
      await updateSetting("assistant.userName", clean.userName || undefined);
      await updateSetting("assistant.language", clean.language === "match" ? undefined : clean.language);
    }
    await this.deps.context.globalState.update("phew.assistantIntroduced", true);
    this.postState();
  }

  /** Tasks for the welcome screen. The extension sets it after the commands exist. */
  suggestions: SuggestionProvider | undefined;

  /** Keep, Undo, or Review from the summary card of a task. */
  async taskAction(
    session: AgentSession | undefined,
    action: "keep" | "undo" | "review",
    checkpointId: string,
  ): Promise<void> {
    const pending = this.deps.reviews.pendingFiles.length > 0;
    if (action === "review") {
      if (pending) await vscode.commands.executeCommand("phew.review.next");
      return;
    }
    if (action === "keep") {
      if (pending) await this.deps.reviews.keepAll();
      return;
    }
    // Undo: pending changes are undone in the editor; changes that were kept go back through the checkpoint.
    if (pending) await this.deps.reviews.undoAll();
    else await session?.restoreCheckpoint(checkpointId);
  }

  /** The data for the Phew Wrapped card. */
  wrappedMessage(period: "week" | "month"): HostMessage {
    const settings = readSettings();
    const earned = new Set(this.deps.stats.earned());
    return {
      type: "wrapped",
      wrapped: wrapped(this.deps.stats.activity(), period, settings.minutesPerBug),
      achievements: achievementList.map((item) => ({ ...item, earned: earned.has(item.id) })),
      name: settings.assistant.name,
    };
  }

  listHistory() {
    return this.store.list();
  }

  async restoreFirstCheckpointForTest(): Promise<void> {
    await this.active?.restoreFirstForTest();
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
  }

  private create(
    root: { uri: vscode.Uri; name: string },
    id = `c_${Date.now().toString(36)}_${(++this.counter).toString(36)}`,
    worktree?: WorktreeInfo,
    stored?: StoredConversation,
  ): AgentSession {
    const session = new AgentSession(
      {
        ...this.deps,
        modes: () => this.modes(),
        emit: (source, message) => this.route(source, message),
        onChange: (source) => this.changed(source),
        persist: (source) => this.persist(source),
        notify: (source, event, seconds) => this.notify(source, event, seconds),
        claims: {
          claim: (sessionId, path) => this.fileClaims.set(path, sessionId),
          owner: (path, exceptSessionId) => {
            const owner = this.fileClaims.get(path);
            const session = owner && owner !== exceptSessionId ? this.sessions.get(owner) : undefined;
            return session?.busy ? session.title : undefined;
          },
          release: (sessionId) => {
            for (const [path, owner] of this.fileClaims) if (owner === sessionId) this.fileClaims.delete(path);
          },
        },
      },
      id,
      root,
      worktree,
      stored,
    );
    this.sessions.set(session.id, session);
    return session;
  }

  /** Keeps a session in the list even if it is empty, for example when an editor tab shows it. */
  keep(id: string): void {
    this.pinnedIds.add(id);
  }

  release(id: string): void {
    this.pinnedIds.delete(id);
  }

  private readonly pinnedIds = new Set<string>();

  private route(session: AgentSession, message: HostMessage): void {
    for (const view of this.views) if (this.shows(view, session)) view.post(message);
    // Approvals change the badge of the activity bar.
    if (message.type === "approval" || message.type === "approvalResolved") this.onBusyChange(this.runningCount);
  }

  /** Tells the user that a chat finished or needs input, when the user does not look at it. */
  private notify(session: AgentSession, event: "done" | "failed" | "input", seconds = 0): void {
    const settings = readSettings();
    const visible = [...this.views].some((view) => view.visible && this.shows(view, session));
    const focused = vscode.window.state.focused;
    if (event !== "input" && ![...this.views].some((view) => view.visible)) {
      this.unseen.add(session.id);
      this.onBusyChange(this.runningCount);
    }
    if (settings.sound === "always" || (settings.sound === "unfocused" && (!focused || !visible))) {
      for (const view of this.views) if (view.visible) view.post({ type: "sound", style: settings.soundStyle, event });
    }
    if (settings.notifyOnComplete === "never") return;
    if (settings.notifyOnComplete === "unfocused" && focused && visible) return;
    // A quick answer is not worth a pop-up; the badge on the Phew icon is enough. A question always notifies.
    if (event !== "input" && seconds < settings.notifyMinSeconds) return;
    const key = `${session.id}:${event}:${session.updatedAt}`;
    if (this.notifiedApprovals.has(key)) return;
    this.notifiedApprovals.add(key);
    const name = settings.assistant.name;
    const text =
      event === "input"
        ? `${name} needs your input in "${session.title}".`
        : event === "done"
          ? `Phew! ${name} finished "${session.title}".`
          : `${name} could not finish "${session.title}".`;
    void vscode.window.showInformationMessage(text, "Show", "Notify Less").then(async (answer) => {
      if (answer === "Notify Less") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "phew.notifications");
        return;
      }
      if (answer !== "Show") return;
      if (![...this.views].some((view) => view.pinnedId === session.id)) this.switchTo(session.id);
      void vscode.commands.executeCommand("phew.openChat");
    });
  }

  private changed(_session: AgentSession): void {
    this.onBusyChange(this.runningCount);
    this.postState();
    void this.postSessions();
  }

  private async persist(session: AgentSession): Promise<void> {
    if (session.isEmpty) return;
    await this.store.save(session.toStored());
  }

  private worktreeDone(session: AgentSession): void {
    const info = session.worktree;
    if (!info) return;
    void vscode.window
      .showInformationMessage(`Phew: the agent on ${info.branch} finished.`, "Show Changes", "Open Chat", "More…")
      .then(async (answer) => {
        if (answer === "Show Changes") await this.showWorktreeDiff(info);
        else if (answer === "Open Chat") {
          this.switchTo(session.id);
          await vscode.commands.executeCommand("phew.openChat");
        } else if (answer === "More…") await this.worktreeActions(session.id);
      });
  }

  private async showWorktreeDiff(info: WorktreeInfo): Promise<void> {
    const result = await git(info.path, ["diff", "HEAD", "--no-color"]);
    const committed = await git(info.repository, ["diff", `HEAD...${info.branch}`, "--no-color"]);
    const content = [committed.stdout.trim(), result.stdout.trim()].filter(Boolean).join("\n") || "No changes yet.";
    const document = await vscode.workspace.openTextDocument({ language: "diff", content });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private dropIdleEmpty(): void {
    for (const [id, session] of this.sessions) {
      if (id !== this.activeId && session.isEmpty && !session.busy && !session.worktree && !this.pinnedIds.has(id)) {
        this.sessions.delete(id);
      }
    }
  }

  private defaultRoot(): { uri: vscode.Uri; name: string } | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
    return folder ? { uri: folder.uri, name: folder.name } : undefined;
  }
}
