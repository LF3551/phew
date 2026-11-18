import type { AutoApproveMode } from "./commandPolicy";

/** How much the agent may do without asking, as one choice instead of three. */

export type ReviewMode = "chat" | "editor" | "none";
export type ApprovalLevel = "careful" | "balanced" | "autopilot";

export interface ApprovalValues {
  readonly review: ReviewMode;
  readonly commands: AutoApproveMode;
  readonly mcp: boolean;
}

export const approvalLevels: readonly ApprovalLevel[] = ["careful", "balanced", "autopilot"];

export const approvalPresets: Readonly<Record<ApprovalLevel, ApprovalValues>> = {
  careful: { review: "chat", commands: "ask", mcp: false },
  balanced: { review: "editor", commands: "allowlist", mcp: false },
  autopilot: { review: "none", commands: "safe", mcp: true },
};

export const approvalLevelInfo: Readonly<Record<ApprovalLevel, { label: string; hint: string }>> = {
  careful: { label: "Careful", hint: "Asks before every edit and command" },
  balanced: { label: "Balanced", hint: "Edits now, you Keep or Undo" },
  autopilot: { label: "Autopilot", hint: "Fewer stops, checkpoints to undo" },
};

/** The level that matches the values, or "custom" for another mix. */
export function approvalLevel(values: ApprovalValues): ApprovalLevel | "custom" {
  return (
    approvalLevels.find((level) => {
      const preset = approvalPresets[level];
      return preset.review === values.review && preset.commands === values.commands && preset.mcp === values.mcp;
    }) ?? "custom"
  );
}

/** What each choice does, in one sentence. */
export const reviewInfo: Readonly<Record<ReviewMode, { label: string; detail: string }>> = {
  chat: { label: "Ask", detail: "Shows each change in the chat. Only the parts you approve are applied." },
  editor: { label: "Review", detail: "Applies changes at once. You Keep or Undo them in the editor." },
  none: { label: "Auto", detail: "Applies changes without a review. Checkpoints let you undo them." },
};

export const commandInfo: Readonly<Record<AutoApproveMode, { label: string; detail: string }>> = {
  ask: { label: "Ask", detail: "Asks before every command." },
  allowlist: {
    label: "Smart",
    detail: "Runs commands that only read (ls, cat, grep, git status…) and your allowlist. Asks for the rest.",
  },
  safe: { label: "All", detail: "Runs every command except dangerous ones." },
};

export const mcpInfo: Readonly<Record<"ask" | "auto", { label: string; detail: string }>> = {
  ask: { label: "Ask", detail: "Asks before each MCP tool call." },
  auto: { label: "Auto", detail: "Runs MCP tools without asking." },
};

/** The settings of this chat that differ from the defaults, for example "Commands: Safe (default: Allowlist)". */
export function approvalDifferences(values: ApprovalValues, defaults: ApprovalValues): string[] {
  const differences: string[] = [];
  if (values.review !== defaults.review)
    differences.push(`Edits: ${reviewInfo[values.review].label} (default: ${reviewInfo[defaults.review].label})`);
  if (values.commands !== defaults.commands)
    differences.push(
      `Commands: ${commandInfo[values.commands].label} (default: ${commandInfo[defaults.commands].label})`,
    );
  if (values.mcp !== defaults.mcp)
    differences.push(
      `MCP: ${mcpInfo[values.mcp ? "auto" : "ask"].label} (default: ${mcpInfo[defaults.mcp ? "auto" : "ask"].label})`,
    );
  return differences;
}
