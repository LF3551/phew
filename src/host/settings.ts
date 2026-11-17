import * as vscode from "vscode";
import type { CommandPolicySettings } from "../core/commandPolicy";
import type { BudgetLimits } from "../core/cost";
import { isMode, type Mode } from "../core/modes";

export const section = "phew";

export interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface Settings {
  readonly defaultMode: Mode;
  readonly maxSteps: number;
  readonly requireEditApproval: boolean;
  readonly commands: CommandPolicySettings;
  readonly commandTimeoutSeconds: number;
  readonly verifyCommand: string;
  readonly verifyMaxAttempts: number;
  readonly budget: BudgetLimits;
  readonly sensitiveNames: readonly string[];
  readonly redactSecrets: boolean;
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly mcpRequireApproval: boolean;
  readonly celebrate: boolean;
  readonly minutesPerBug: number;
  readonly offerTerminalFix: boolean;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

const positive = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;

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

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(section);
  const mode = config.get<unknown>("agent.defaultMode");
  return {
    defaultMode: isMode(mode) ? mode : "code",
    maxSteps: Math.max(1, Math.round(positive(config.get("agent.maxSteps"), 40, 200))),
    requireEditApproval: config.get<boolean>("edits.requireApproval") !== false,
    commands: {
      autoApprove: strings(config.get("commands.autoApprove")),
      deny: strings(config.get("commands.deny")),
    },
    commandTimeoutSeconds: Math.max(5, positive(config.get("commands.timeoutSeconds"), 120, 3600)),
    verifyCommand: (config.get<string>("verify.command") ?? "").trim(),
    verifyMaxAttempts: Math.max(1, Math.round(positive(config.get("verify.maxAttempts"), 3, 10))),
    budget: {
      maxCostPerTask: positive(config.get("budget.maxCostPerTask"), 0),
      maxTokensPerTask: Math.round(positive(config.get("budget.maxTokensPerTask"), 0)),
    },
    sensitiveNames: strings(config.get("privacy.sensitiveNames")),
    redactSecrets: config.get<boolean>("privacy.redactSecrets") !== false,
    mcpServers: mcpServers(config.get("mcp.servers")),
    mcpRequireApproval: config.get<boolean>("mcp.requireApproval") !== false,
    celebrate: config.get<boolean>("ui.celebrate") !== false,
    minutesPerBug: positive(config.get("stats.minutesPerBug"), 15, 600),
    offerTerminalFix: config.get<boolean>("terminal.offerFix") !== false,
  };
}
