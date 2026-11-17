import { isMode, type Mode } from "../core/modes";

export interface ViewState {
  readonly mode: Mode;
  readonly model: string;
  readonly provider: string;
  readonly configured: boolean;
  readonly busy: boolean;
  readonly trusted: boolean;
  readonly tokens: string;
  readonly cost: string;
  readonly celebrate: boolean;
  readonly stats: string;
}

export interface HunkView {
  readonly index: number;
  readonly preview: string;
}

export type ApprovalKind = "command" | "edit" | "mcp";

export type HostMessage =
  | { readonly type: "state"; readonly state: ViewState }
  | { readonly type: "user"; readonly id: string; readonly text: string; readonly checkpointId: string }
  | { readonly type: "assistantStart"; readonly id: string }
  | { readonly type: "assistantDelta"; readonly id: string; readonly text: string }
  | { readonly type: "assistantEnd"; readonly id: string; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly summary: string;
      readonly status: "running" | "done" | "error";
      readonly detail?: string;
    }
  | {
      readonly type: "approval";
      readonly id: string;
      readonly kind: ApprovalKind;
      readonly title: string;
      readonly detail: string;
      readonly reason?: string;
      readonly hunks?: readonly HunkView[];
    }
  | { readonly type: "approvalResolved"; readonly id: string; readonly decision: string }
  | { readonly type: "verify"; readonly attempt: number; readonly passed: boolean; readonly output: string }
  | {
      readonly type: "taskEnd";
      readonly status: string;
      readonly message?: string;
      readonly verified: boolean;
      readonly celebrate: boolean;
    }
  | { readonly type: "notice"; readonly level: "info" | "warning" | "error"; readonly text: string }
  | { readonly type: "checkpointRestored"; readonly checkpointId: string; readonly files: readonly string[] }
  | { readonly type: "cleared" };

export type WebviewMessage =
  | { readonly type: "ready" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "stop" }
  | { readonly type: "setMode"; readonly mode: Mode }
  | { readonly type: "newChat" }
  | {
      readonly type: "approve";
      readonly id: string;
      readonly decision: "allow" | "deny";
      readonly hunks?: readonly number[];
    }
  | { readonly type: "openDiff"; readonly id: string }
  | { readonly type: "restoreCheckpoint"; readonly checkpointId: string }
  | { readonly type: "configureModel" }
  | { readonly type: "openSettings" }
  | { readonly type: "showStats" };

export const maximumPromptLength = 100_000;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates an untrusted message from the webview. Returns undefined for invalid input. */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  const id = (key: string) =>
    typeof message[key] === "string" && idPattern.test(message[key] as string) ? (message[key] as string) : undefined;
  switch (message.type) {
    case "ready":
    case "stop":
    case "newChat":
    case "configureModel":
    case "openSettings":
    case "showStats":
      return { type: message.type };
    case "send": {
      if (typeof message.text !== "string") return undefined;
      const text = message.text.trim();
      return text.length > 0 && text.length <= maximumPromptLength ? { type: "send", text } : undefined;
    }
    case "setMode":
      return isMode(message.mode) ? { type: "setMode", mode: message.mode } : undefined;
    case "approve": {
      const approvalId = id("id");
      if (!approvalId || (message.decision !== "allow" && message.decision !== "deny")) return undefined;
      let hunks: number[] | undefined;
      if (message.hunks !== undefined) {
        if (!Array.isArray(message.hunks) || message.hunks.length > 10_000) return undefined;
        if (!message.hunks.every((item) => Number.isInteger(item) && item >= 0)) return undefined;
        hunks = message.hunks as number[];
      }
      return { type: "approve", id: approvalId, decision: message.decision, ...(hunks ? { hunks } : {}) };
    }
    case "openDiff": {
      const approvalId = id("id");
      return approvalId ? { type: "openDiff", id: approvalId } : undefined;
    }
    case "restoreCheckpoint": {
      const checkpointId = id("checkpointId");
      return checkpointId ? { type: "restoreCheckpoint", checkpointId } : undefined;
    }
    default:
      return undefined;
  }
}
