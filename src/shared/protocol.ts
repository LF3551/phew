import type { Appearance } from "../core/appearance";
import { type Attachment, attachmentLabel, maximumAttachments, parseAttachment } from "../core/attachments";
import { isModeId, type Mode } from "../core/modes";

export interface ModeView {
  readonly id: Mode;
  readonly name: string;
  readonly description: string;
}

export type ReviewSetting = "chat" | "editor" | "none";
export type CommandSetting = "ask" | "allowlist" | "safe";

export interface ViewState {
  readonly sessionId: string;
  readonly title: string;
  readonly worktree?: string;
  readonly mode: Mode;
  readonly modes: readonly ModeView[];
  readonly model: string;
  readonly provider: string;
  readonly configured: boolean;
  readonly busy: boolean;
  readonly trusted: boolean;
  readonly tokens: string;
  readonly cost: string;
  readonly celebrate: boolean;
  readonly stats: string;
  readonly approvals: {
    readonly review: ReviewSetting;
    readonly commands: CommandSetting;
    readonly mcp: boolean;
    /** True when this chat uses its own approval settings. */
    readonly custom: boolean;
  };
  readonly reviewFiles: number;
  readonly runningSessions: number;
  /** Share of the context window that the last request used, from 0 to 1. */
  readonly context: number;
  readonly contextLabel: string;
  readonly fontSize: number | null;
  readonly sendWith: "enter" | "ctrlEnter";
  readonly appearance: Appearance;
  readonly showThinking: boolean;
  /** True when this view shows one fixed chat, for example in an editor tab. */
  readonly pinned: boolean;
}

export interface PlanView {
  readonly goal?: string;
  readonly items: readonly { readonly text: string; readonly status: "pending" | "in_progress" | "done" }[];
}

export interface QueuedView {
  readonly id: string;
  readonly text: string;
}

export interface HunkView {
  readonly index: number;
  readonly preview: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly running: boolean;
  readonly active: boolean;
  readonly worktree?: string;
  readonly needsApproval: boolean;
}

export interface HistoryItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messages: number;
  readonly worktree?: string;
}

export interface MentionItem {
  readonly label: string;
  readonly detail?: string;
  readonly attachment: Attachment;
}

export type ApprovalKind = "command" | "edit" | "mcp" | "question";

export type HostMessage = (
  | { readonly type: "state"; readonly state: ViewState }
  | {
      readonly type: "user";
      readonly id: string;
      readonly text: string;
      readonly checkpointId: string;
      readonly attachments?: readonly string[];
    }
  | { readonly type: "assistantStart"; readonly id: string; readonly variant?: "btw" }
  | { readonly type: "assistantDelta"; readonly id: string; readonly text: string }
  | { readonly type: "assistantEnd"; readonly id: string; readonly text: string; readonly variant?: "btw" }
  | { readonly type: "reasoningDelta"; readonly id: string; readonly text: string }
  | { readonly type: "reasoningEnd"; readonly id: string; readonly text: string }
  | { readonly type: "plan"; readonly plan: PlanView }
  | { readonly type: "queue"; readonly items: readonly QueuedView[] }
  | { readonly type: "sound" }
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
      readonly options?: readonly string[];
      readonly allowText?: boolean;
    }
  | { readonly type: "approvalResolved"; readonly id: string; readonly decision: string }
  | { readonly type: "verify"; readonly attempt: number; readonly passed: boolean; readonly output: string }
  | {
      readonly type: "taskEnd";
      readonly status: string;
      readonly message?: string;
      readonly verified: boolean;
      readonly celebrate: boolean;
      readonly reviewFiles?: number;
    }
  | { readonly type: "notice"; readonly level: "info" | "warning" | "error"; readonly text: string }
  | { readonly type: "checkpointRestored"; readonly checkpointId: string; readonly files: readonly string[] }
  | { readonly type: "cleared" }
  | {
      readonly type: "sessions";
      readonly sessions: readonly SessionSummary[];
      readonly history: readonly HistoryItem[];
    }
  | { readonly type: "addAttachment"; readonly attachment: Attachment; readonly label: string }
  | { readonly type: "mentions"; readonly query: string; readonly items: readonly MentionItem[] }
  | { readonly type: "focusInput"; readonly text?: string }
  | { readonly type: "openPanel" }
) & {
  /** Time of the event in milliseconds since 1970. */
  readonly at?: number;
};

export type WebviewMessage =
  | { readonly type: "ready" }
  | {
      readonly type: "send";
      readonly text: string;
      readonly attachments: readonly Attachment[];
      readonly interrupt?: boolean;
    }
  | { readonly type: "setAppearance"; readonly key: AppearanceKey; readonly value: string | number | boolean | null }
  | { readonly type: "stop" }
  | { readonly type: "setMode"; readonly mode: Mode }
  | { readonly type: "newChat" }
  | {
      readonly type: "approve";
      readonly id: string;
      readonly decision: "allow" | "deny";
      readonly hunks?: readonly number[];
      readonly text?: string;
    }
  | { readonly type: "openDiff"; readonly id: string }
  | { readonly type: "restoreCheckpoint"; readonly checkpointId: string }
  | { readonly type: "configureModel" }
  | { readonly type: "openSettings" }
  | { readonly type: "showStats" }
  | { readonly type: "mentionQuery"; readonly query: string }
  | { readonly type: "setApproval"; readonly key: "review"; readonly value: ReviewSetting }
  | { readonly type: "setApproval"; readonly key: "commands"; readonly value: CommandSetting }
  | { readonly type: "setApproval"; readonly key: "mcp"; readonly value: boolean }
  | { readonly type: "listSessions" }
  | { readonly type: "switchSession"; readonly id: string }
  | { readonly type: "openConversation"; readonly id: string }
  | { readonly type: "deleteConversation"; readonly id: string }
  | { readonly type: "exportChat" }
  | { readonly type: "reviewNext" }
  | { readonly type: "newWorktreeAgent" }
  | { readonly type: "openWalkthrough" }
  | { readonly type: "removeQueued"; readonly id: string }
  | { readonly type: "openFile"; readonly path: string; readonly line?: number }
  | { readonly type: "renameChat"; readonly id?: string }
  | { readonly type: "openInEditor"; readonly id?: string }
  | { readonly type: "resetApprovals" }
  | { readonly type: "compact" };

export type AppearanceKey = "style" | "accentColor" | "fontSize" | "timestamps";

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
    case "listSessions":
    case "exportChat":
    case "reviewNext":
    case "newWorktreeAgent":
    case "openWalkthrough":
    case "resetApprovals":
    case "compact":
      return { type: message.type };
    case "removeQueued": {
      const value = id("id");
      return value ? { type: "removeQueued", id: value } : undefined;
    }
    case "renameChat":
    case "openInEditor": {
      if (message.id === undefined) return { type: message.type };
      const value = id("id");
      return value ? { type: message.type, id: value } : undefined;
    }
    case "openFile": {
      if (
        typeof message.path !== "string" ||
        message.path.length === 0 ||
        message.path.length > 1000 ||
        message.path.includes("\0")
      ) {
        return undefined;
      }
      const line = Number(message.line);
      return {
        type: "openFile",
        path: message.path,
        ...(Number.isInteger(line) && line > 0 && line < 10_000_000 ? { line } : {}),
      };
    }
    case "send": {
      if (typeof message.text !== "string") return undefined;
      const text = message.text.trim();
      const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
      if (rawAttachments.length > maximumAttachments) return undefined;
      const attachments: Attachment[] = [];
      for (const item of rawAttachments) {
        const attachment = parseAttachment(item);
        if (!attachment) return undefined;
        attachments.push(attachment);
      }
      if ((text.length === 0 && attachments.length === 0) || text.length > maximumPromptLength) return undefined;
      return { type: "send", text, attachments, ...(message.interrupt === true ? { interrupt: true } : {}) };
    }
    case "setMode":
      return isModeId(message.mode) ? { type: "setMode", mode: message.mode } : undefined;
    case "approve": {
      const approvalId = id("id");
      if (!approvalId || (message.decision !== "allow" && message.decision !== "deny")) return undefined;
      let hunks: number[] | undefined;
      if (message.hunks !== undefined) {
        if (!Array.isArray(message.hunks) || message.hunks.length > 10_000) return undefined;
        if (!message.hunks.every((item) => Number.isInteger(item) && item >= 0)) return undefined;
        hunks = message.hunks as number[];
      }
      if (message.text !== undefined && (typeof message.text !== "string" || message.text.length > 5000))
        return undefined;
      return {
        type: "approve",
        id: approvalId,
        decision: message.decision,
        ...(hunks ? { hunks } : {}),
        ...(typeof message.text === "string" ? { text: message.text } : {}),
      };
    }
    case "openDiff":
    case "switchSession":
    case "openConversation":
    case "deleteConversation": {
      const value = id("id");
      return value ? ({ type: message.type, id: value } as WebviewMessage) : undefined;
    }
    case "restoreCheckpoint": {
      const checkpointId = id("checkpointId");
      return checkpointId ? { type: "restoreCheckpoint", checkpointId } : undefined;
    }
    case "mentionQuery":
      return typeof message.query === "string" && message.query.length <= 200
        ? { type: "mentionQuery", query: message.query }
        : undefined;
    case "setAppearance": {
      const { key, value } = message;
      if (key === "style" && ["bubbles", "classic", "compact"].includes(String(value)))
        return { type: "setAppearance", key, value: value as string };
      if (key === "timestamps" && ["hover", "always", "never"].includes(String(value)))
        return { type: "setAppearance", key, value: value as string };
      if (key === "accentColor" && (value === "" || (typeof value === "string" && value.length <= 40)))
        return { type: "setAppearance", key, value: value as string };
      if (key === "fontSize" && (value === null || (typeof value === "number" && value >= 8 && value <= 32)))
        return { type: "setAppearance", key, value };
      return undefined;
    }
    case "setApproval": {
      if (message.key === "review" && ["chat", "editor", "none"].includes(String(message.value))) {
        return { type: "setApproval", key: "review", value: message.value as ReviewSetting };
      }
      if (message.key === "commands" && ["ask", "allowlist", "safe"].includes(String(message.value))) {
        return { type: "setApproval", key: "commands", value: message.value as CommandSetting };
      }
      if (message.key === "mcp" && typeof message.value === "boolean")
        return { type: "setApproval", key: "mcp", value: message.value };
      return undefined;
    }
    default:
      return undefined;
  }
}

export { attachmentLabel };
