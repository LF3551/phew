import * as vscode from "vscode";
import { type Appearance, safeColor, safeFontFamily } from "../core/appearance";
import type { AutoApproveMode, CommandPolicySettings } from "../core/commandPolicy";
import type { CommitSettings, CommitStyle, GpgMode } from "../core/commit";
import type { BudgetLimits } from "../core/cost";
import { isModeId, type Mode } from "../core/modes";
import { type Assistant, parseAssistant } from "../core/persona";

export const section = "phew";

/** How Phew shows file changes: before applying them in the chat, after applying them in the editor, or not at all. */
export type ReviewMode = "chat" | "editor" | "none";

export interface Settings {
  readonly defaultMode: Mode;
  readonly maxSteps: number;
  readonly reviewMode: ReviewMode;
  readonly commands: CommandPolicySettings & { readonly mode: AutoApproveMode };
  readonly commandTimeoutSeconds: number;
  /** Mirrors the agent's commands in a terminal of the chat and opens it with the first command. */
  readonly commandsTerminal: "open" | "background" | "off";
  /** The shell of the terminal of the chat. Empty means the user's shell. */
  readonly commandsShell: string;
  /** Whether the terminal of the chat loads the user's startup files (.bashrc, .zshrc, profiles). */
  readonly commandsStartupFiles: boolean;
  /** How many terminals one chat may have. */
  readonly commandsMaxTerminals: number;

  readonly verifyCommand: string;
  readonly verifyMaxAttempts: number;
  readonly budget: BudgetLimits;
  readonly sensitiveNames: readonly string[];
  readonly redactSecrets: boolean;
  /** Raw MCP server entries from the settings. The MCP manager validates them. */
  readonly mcpServers: Readonly<Record<string, unknown>>;
  readonly mcpAutoApprove: boolean;
  readonly mcpReadWorkspaceConfigs: boolean;
  readonly mcpDisabledServers: readonly string[];
  readonly mcpDisabledTools: Readonly<Record<string, readonly string[]>>;
  readonly showThinking: boolean;
  readonly autoCompact: boolean;
  readonly compactAt: number;
  readonly defaultContextWindow: number;
  readonly maxRetries: number;
  readonly fontSize: number | null;
  readonly sendWith: "enter" | "ctrlEnter";
  readonly appearance: Appearance;
  readonly notifyOnComplete: "unfocused" | "always" | "never";
  /** A finished task notifies only when it took at least this long. */
  readonly notifyMinSeconds: number;
  /** When to play a sound: never, only when the chat is not visible, or always. */
  readonly sound: "off" | "unfocused" | "always";
  readonly soundStyle: "phew" | "chime";
  readonly assistant: Assistant;
  readonly handoff: {
    readonly enabled: boolean;
    readonly auto: "changes" | "always" | "manual";
    readonly share: "local" | "commit";
    readonly agentsFile: "ask" | "always" | "never";
  };
  readonly skillsEnabled: boolean;
  readonly skillPaths: readonly string[];
  readonly celebrate: boolean;
  /** Ask for a rating now and then, after a task that went well. */
  readonly askForRating: boolean;
  readonly minutesPerBug: number;
  readonly offerTerminalFix: boolean;
  readonly restoreLastChat: boolean;
  readonly historyLimit: number;
  /** Name chats with a short title from the model after the first answer. */
  readonly autoTitle: boolean;
  readonly customModes: unknown;
  readonly memoryEnabled: boolean;
  readonly index: {
    readonly enabled: boolean;
    readonly maxFiles: number;
    readonly exclude: readonly string[];
    readonly embeddingProfile: string;
    readonly embeddingModel: string;
  };
  readonly autocomplete: {
    readonly enabled: boolean;
    readonly model: string;
    readonly debounceMs: number;
    readonly maxLines: number;
  };
  readonly nextEditModel: string;
  readonly commit: CommitSettings & { readonly model: string };
  readonly worktrees: { readonly location: string; readonly branchPrefix: string };
  readonly subagents: {
    readonly enabled: boolean;
    /** The id of the default model of subagents; empty for the model of the chat. */
    readonly model: string;
    readonly maxParallel: number;
    readonly maxSteps: number;
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

const positive = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function toolLists(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [server, tools] of Object.entries(objectValue(value))) result[server] = strings(tools);
  return result;
}

export function readSettings(scope?: vscode.Uri): Settings {
  const config = vscode.workspace.getConfiguration(section, scope);
  const mode = config.get<unknown>("agent.defaultMode");
  const embeddings = (config.get<Record<string, unknown>>("index.embeddings") ?? {}) as Record<string, unknown>;
  return {
    defaultMode: isModeId(mode) ? mode : "code",
    maxSteps: Math.max(1, Math.round(positive(config.get("agent.maxSteps"), 40, 200))),
    reviewMode: oneOf(config.get("review.mode"), ["chat", "editor", "none"] as const, "editor"),
    commands: {
      mode: oneOf(config.get("commands.approval"), ["ask", "allowlist", "safe"] as const, "allowlist"),
      autoApprove: strings(config.get("commands.autoApprove")),
      deny: strings(config.get("commands.deny")),
    },
    commandTimeoutSeconds: Math.max(5, positive(config.get("commands.timeoutSeconds"), 120, 3600)),
    commandsTerminal: oneOf(config.get("commands.terminal"), ["open", "background", "off"] as const, "open"),
    commandsShell: text(config.get("commands.shell")),
    commandsStartupFiles: config.get<boolean>("commands.shellStartupFiles") !== false,
    commandsMaxTerminals: Math.max(1, Math.round(positive(config.get("commands.maxTerminals"), 6, 20))),

    verifyCommand: text(config.get("verify.command")),
    verifyMaxAttempts: Math.max(1, Math.round(positive(config.get("verify.maxAttempts"), 3, 10))),
    budget: {
      maxCostPerTask: positive(config.get("budget.maxCostPerTask"), 0),
      maxTokensPerTask: Math.round(positive(config.get("budget.maxTokensPerTask"), 0)),
    },
    sensitiveNames: strings(config.get("privacy.sensitiveNames")),
    redactSecrets: config.get<boolean>("privacy.redactSecrets") !== false,
    mcpServers: objectValue(config.get("mcp.servers")),
    mcpAutoApprove: config.get<boolean>("mcp.autoApprove") === true,
    mcpReadWorkspaceConfigs: config.get<boolean>("mcp.readWorkspaceConfigs") !== false,
    mcpDisabledServers: strings(config.get("mcp.disabledServers")),
    mcpDisabledTools: toolLists(config.get("mcp.disabledTools")),
    showThinking: config.get<boolean>("chat.showThinking") !== false,
    autoCompact: config.get<boolean>("context.autoCompact") !== false,
    compactAt: Math.min(0.95, Math.max(0.3, positive(config.get("context.compactAt"), 0.8, 0.95))),
    defaultContextWindow: Math.max(
      4000,
      Math.round(positive(config.get("context.defaultWindow"), 128_000, 10_000_000)),
    ),
    maxRetries: Math.round(positive(config.get("model.maxRetries"), 3, 10)),
    fontSize:
      typeof config.get("chat.fontSize") === "number"
        ? Math.min(32, Math.max(8, config.get<number>("chat.fontSize") ?? 13))
        : null,
    sendWith: oneOf(config.get("chat.sendWith"), ["enter", "ctrlEnter"] as const, "enter"),
    appearance: {
      style: oneOf(config.get("appearance.style"), ["bubbles", "classic", "compact"] as const, "bubbles"),
      accentColor: safeColor(config.get("appearance.accentColor")),
      userBubbleColor: safeColor(config.get("appearance.userBubbleColor")),
      fontFamily: safeFontFamily(config.get("appearance.fontFamily")),
      lineHeight:
        typeof config.get("appearance.lineHeight") === "number"
          ? Math.min(2.4, Math.max(1, config.get<number>("appearance.lineHeight") ?? 1.5))
          : null,
      codeFontSize:
        typeof config.get("appearance.codeFontSize") === "number"
          ? Math.min(28, Math.max(8, config.get<number>("appearance.codeFontSize") ?? 12))
          : null,
      timestamps: oneOf(config.get("appearance.timestamps"), ["hover", "always", "never"] as const, "hover"),
      messageActions: oneOf(config.get("appearance.messageActions"), ["hover", "always"] as const, "hover"),
      avatars: config.get<boolean>("appearance.avatars") === true,
      mascot: oneOf(config.get("appearance.mascot"), ["lively", "calm", "still"] as const, "lively"),
      clock: oneOf(config.get("appearance.clock"), ["auto", "24h", "12h"] as const, "auto"),
    },
    notifyOnComplete: oneOf(
      config.get("notifications.onComplete"),
      ["unfocused", "always", "never"] as const,
      "unfocused",
    ),
    notifyMinSeconds: Math.min(3600, Math.max(0, Number(config.get("notifications.minSeconds") ?? 30) || 0)),
    sound: oneOf(config.get("notifications.sound"), ["off", "unfocused", "always"] as const, "off"),
    soundStyle: oneOf(config.get("notifications.soundStyle"), ["phew", "chime"] as const, "phew"),
    handoff: {
      enabled: config.get<boolean>("handoff.enabled") !== false,
      auto: oneOf(config.get("handoff.auto"), ["changes", "always", "manual"] as const, "changes"),
      share: oneOf(config.get("handoff.share"), ["local", "commit"] as const, "local"),
      agentsFile: oneOf(config.get("handoff.agentsFile"), ["ask", "always", "never"] as const, "ask"),
    },
    assistant: parseAssistant({
      name: config.get("assistant.name"),
      avatar: config.get("assistant.avatar"),
      persona: config.get("assistant.persona"),
      customPersona: config.get("assistant.customPersona"),
      userName: config.get("assistant.userName"),
      language: config.get("assistant.language"),
    }),
    skillsEnabled: config.get<boolean>("skills.enabled") !== false,
    skillPaths: strings(config.get("skills.paths")),
    celebrate: config.get<boolean>("ui.celebrate") !== false,
    askForRating: config.get<boolean>("ui.askForRating") !== false,
    minutesPerBug: positive(config.get("stats.minutesPerBug"), 15, 600),
    offerTerminalFix: config.get<boolean>("terminal.offerFix") !== false,
    restoreLastChat: config.get<boolean>("chat.restoreLastChat") !== false,
    autoTitle: config.get<boolean>("chat.autoTitle") !== false,
    historyLimit: Math.max(1, Math.round(positive(config.get("chat.historyLimit"), 200, 5000))),
    customModes: config.get("modes"),
    memoryEnabled: config.get<boolean>("memory.enabled") !== false,
    index: {
      enabled: config.get<boolean>("index.enabled") !== false,
      maxFiles: Math.max(10, Math.round(positive(config.get("index.maxFiles"), 5000, 50_000))),
      exclude: strings(config.get("index.exclude")),
      embeddingProfile: text(embeddings.profile),
      embeddingModel: text(embeddings.model),
    },
    autocomplete: {
      enabled: config.get<boolean>("autocomplete.enabled") === true,
      model: text(config.get("autocomplete.model")),
      debounceMs: Math.round(positive(config.get("autocomplete.debounceMs"), 350, 5000)),
      maxLines: Math.max(1, Math.round(positive(config.get("autocomplete.maxLines"), 8, 50))),
    },
    nextEditModel: text(config.get("nextEdit.model")),
    commit: {
      style: oneOf<CommitStyle>(config.get("commit.style"), ["conventional", "simple"], "conventional"),
      language: text(config.get("commit.language")) || "English",
      maxSubjectLength: Math.max(30, Math.round(positive(config.get("commit.maxSubjectLength"), 72, 200))),
      includeBody: config.get<boolean>("commit.includeBody") !== false,
      signOff: config.get<boolean>("commit.signOff") === true,
      gpgSign: oneOf<GpgMode>(config.get("commit.gpgSign"), ["git", "always", "never"], "git"),
      author: text(config.get("commit.author")),
      trailers: strings(config.get("commit.trailers")),
      assistedBy: config.get<boolean>("commit.assistedByTrailer") === true,
      instructions: text(config.get("commit.instructions")),
      model: text(config.get("commit.model")),
    },
    subagents: {
      enabled: config.get("subagents.enabled") !== false,
      model: text(config.get("subagents.model")),
      maxParallel: Math.max(1, Math.round(positive(config.get("subagents.maxParallel"), 3, 6))),
      maxSteps: Math.max(3, Math.round(positive(config.get("subagents.maxSteps"), 25, 100))),
    },
    worktrees: {
      location: text(config.get("worktrees.location")),
      branchPrefix: text(config.get("worktrees.branchPrefix")) || "phew/",
    },
  };
}

/** Updates a user setting. Toggles in the chat and the settings page use it. */
export async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

/** Removes a setting from the user and the workspace settings, so the default applies everywhere. */
export async function clearSetting(key: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(section);
  const values = config.inspect(key);
  if (values?.globalValue !== undefined) await config.update(key, undefined, vscode.ConfigurationTarget.Global);
  if (values?.workspaceValue !== undefined) await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
}
