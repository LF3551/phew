import * as vscode from "vscode";
import type { AutoApproveMode, CommandPolicySettings } from "../core/commandPolicy";
import type { CommitSettings, CommitStyle, GpgMode } from "../core/commit";
import type { BudgetLimits } from "../core/cost";
import { isModeId, type Mode } from "../core/modes";

export const section = "phew";

export interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** How Phew shows file changes: before applying them in the chat, after applying them in the editor, or not at all. */
export type ReviewMode = "chat" | "editor" | "none";

export interface Settings {
  readonly defaultMode: Mode;
  readonly maxSteps: number;
  readonly reviewMode: ReviewMode;
  readonly commands: CommandPolicySettings & { readonly mode: AutoApproveMode };
  readonly commandTimeoutSeconds: number;
  readonly verifyCommand: string;
  readonly verifyMaxAttempts: number;
  readonly budget: BudgetLimits;
  readonly sensitiveNames: readonly string[];
  readonly redactSecrets: boolean;
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly mcpAutoApprove: boolean;
  readonly celebrate: boolean;
  readonly minutesPerBug: number;
  readonly offerTerminalFix: boolean;
  readonly restoreLastChat: boolean;
  readonly historyLimit: number;
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
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

const positive = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function mcpServers(value: unknown): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  if (typeof value !== "object" || value === null) return result;
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue;
    const { command, args, env } = raw as Record<string, unknown>;
    if (typeof command !== "string" || command.trim() === "") continue;
    const environment: Record<string, string> = {};
    if (typeof env === "object" && env !== null) {
      for (const [key, item] of Object.entries(env)) if (typeof item === "string") environment[key] = item;
    }
    result[name] = { command, args: strings(args), env: environment };
  }
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
    verifyCommand: text(config.get("verify.command")),
    verifyMaxAttempts: Math.max(1, Math.round(positive(config.get("verify.maxAttempts"), 3, 10))),
    budget: {
      maxCostPerTask: positive(config.get("budget.maxCostPerTask"), 0),
      maxTokensPerTask: Math.round(positive(config.get("budget.maxTokensPerTask"), 0)),
    },
    sensitiveNames: strings(config.get("privacy.sensitiveNames")),
    redactSecrets: config.get<boolean>("privacy.redactSecrets") !== false,
    mcpServers: mcpServers(config.get("mcp.servers")),
    mcpAutoApprove: config.get<boolean>("mcp.autoApprove") === true,
    celebrate: config.get<boolean>("ui.celebrate") !== false,
    minutesPerBug: positive(config.get("stats.minutesPerBug"), 15, 600),
    offerTerminalFix: config.get<boolean>("terminal.offerFix") !== false,
    restoreLastChat: config.get<boolean>("chat.restoreLastChat") !== false,
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
      instructions: text(config.get("commit.instructions")),
      model: text(config.get("commit.model")),
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
