import type { Achievement, Wrapped } from "../core/achievements";
import type { Appearance } from "../core/appearance";
import { type ApprovalLevel, approvalLevels } from "../core/approvals";
import { type Attachment, attachmentLabel, maximumAttachments, parseAttachment } from "../core/attachments";
import { isModeId, type Mode } from "../core/modes";
import { type Persona, personas } from "../core/persona";
import type { FileChange } from "../core/summary";

export interface ModeView {
  readonly id: Mode;
  readonly name: string;
  readonly description: string;
  /** True when the mode may change files or run commands. */
  readonly changes: boolean;
  readonly builtIn: boolean;
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
    /** The defaults for new chats, from the settings. */
    readonly defaults: { readonly review: ReviewSetting; readonly commands: CommandSetting; readonly mcp: boolean };
    /** Command prefixes that run without asking in the Allowlist mode. */
    readonly allowlist: readonly string[];
  };
  readonly reviewFiles: number;
  readonly runningSessions: number;
  /** Share of the context window that the last request used, from 0 to 1. */
  readonly context: number;
  readonly contextLabel: string;
  readonly fontSize: number | null;
  readonly sendWith: "enter" | "ctrlEnter";
  readonly appearance: Appearance;
  readonly assistant: {
    readonly name: string;
    readonly avatar: string;
    readonly persona: Persona;
    /** The description of the Custom character. */
    readonly customPersona: string;
    readonly userName: string;
    readonly language: string;
  };
  /** True until the user names the assistant or skips the introduction. */
  readonly onboarding: boolean;
  /** The model id of the active profile, for example gpt-5.1. */
  readonly modelId: string;
  /** The terminals of the chat, for the list in the chat. */
  readonly terminals: readonly {
    readonly id: string;
    readonly name: string;
    readonly pid?: number;
    readonly shell: string;
    readonly cwd?: string;
    readonly state: "idle" | "running" | "waiting" | "stopped";
    readonly command?: string;
  }[];
  /** All model profiles, for the menu under the input. */
  readonly models: readonly ModelOption[];
  /** The name of the model that the current mode always uses, when the mode sets one. */
  readonly modeModel?: string;
  /** The latest handoff note of the workspace, for "Continue where you left off". */
  readonly handoff?: {
    readonly path: string;
    readonly title: string;
    readonly status: string;
    readonly created: string;
  };
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
  readonly updatedAt: number;
  /** A short line from the conversation that tells chats apart. */
  readonly preview?: string;
  readonly pinned?: boolean;
}

export interface HistoryItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messages: number;
  readonly worktree?: string;
  /** A short line from the conversation that tells chats apart. */
  readonly preview?: string;
  readonly pinned?: boolean;
}

export interface MentionItem {
  readonly label: string;
  readonly detail?: string;
  readonly attachment: Attachment;
}

/** A model profile for the model menu under the input. */
export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly provider: "openai" | "anthropic" | "gemini" | "vscode";
  /** The model name of the provider, for example claude-sonnet-4.5. */
  readonly model: string;
  readonly contextWindow?: number;
  readonly active: boolean;
}

/** Context that the attach menu offers in one click, from the state of the editor. */
export interface ContextOption {
  readonly id: "file" | "selection" | "fileProblems" | "problems" | "git" | "terminal";
  readonly label: string;
  /** What exactly is added, for example the file name or "3 errors". */
  readonly detail: string;
  readonly attachment: Attachment;
  /** The label of the chip. */
  readonly chip: string;
  /** For a warning tone, for example errors or a failed command. */
  readonly tone?: "error" | "warning" | "ok";
}

/** A task that the welcome screen offers, from the state of the project. */
export interface Suggestion {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly icon: "bug" | "terminal" | "git" | "file" | "book";
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
  | { readonly type: "sound"; readonly style: "phew" | "chime"; readonly event: "done" | "failed" | "input" }
  | { readonly type: "achievement"; readonly achievement: Achievement }
  | {
      readonly type: "wrapped";
      readonly wrapped: Wrapped;
      readonly achievements: readonly (Achievement & { readonly earned: boolean })[];
      readonly name: string;
    }
  | { readonly type: "showOnboarding" }
  | { readonly type: "showAppearance" }
  | {
      readonly type: "summary";
      readonly checkpointId: string;
      readonly status: string;
      readonly seconds: number;
      readonly files: readonly FileChange[];
      readonly check?: { readonly command: string; readonly passed: boolean; readonly attempts: number };
      /** Files with changes that still wait for Keep or Undo in the editor. */
      readonly pending: number;
    }
  | { readonly type: "suggestions"; readonly items: readonly Suggestion[] }
  | { readonly type: "handoff"; readonly path: string; readonly manual: boolean }
  | {
      readonly type: "toolOutput";
      readonly id: string;
      readonly text: string;
      /** Where the command runs, sent once when it starts. */
      readonly where?: "terminal" | "background";
      /** Why it runs: the rule that allowed it, or the decision of the user. */
      readonly approval?: string;
      /** The terminal of the chat that runs it, for example "2". */
      readonly terminal?: string;
    }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly summary: string;
      readonly status: "running" | "done" | "error";
      readonly detail?: string;
      /** The full command of run_command. */
      readonly command?: string;
      /** What the command does, in plain words. */
      readonly description?: string;
      /** Where the command ran: the real terminal of the chat or the background. */
      readonly where?: "terminal" | "background";
      /** Why it ran: the rule that allowed it, or the decision of the user. */
      readonly approval?: string;
      /** The terminal of the chat that ran it, for example "2". */
      readonly terminal?: string;
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
      /** For commands: the prefix that "Always allow" adds to the allowlist. */
      readonly alwaysAllow?: string;
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
  | { readonly type: "contextOptions"; readonly options: readonly ContextOption[] }
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
  | { readonly type: "editModes" }
  | { readonly type: "showStats" }
  | { readonly type: "mentionQuery"; readonly query: string }
  | { readonly type: "contextQuery" }
  | { readonly type: "setApprovalLevel"; readonly level: ApprovalLevel }
  | { readonly type: "editAllowlist" }
  | { readonly type: "useModel"; readonly id: string }
  | { readonly type: "manageModels" }
  | { readonly type: "stopCommand"; readonly id: string }
  | { readonly type: "showTerminal" }
  | { readonly type: "fixCommand"; readonly id: string }
  | { readonly type: "terminalAction"; readonly id: string; readonly action: "show" | "interrupt" | "kill" }
  | { readonly type: "commandInput"; readonly id: string; readonly data: string }
  | { readonly type: "copyText"; readonly text: string }
  | { readonly type: "setApproval"; readonly key: "review"; readonly value: ReviewSetting }
  | { readonly type: "setApproval"; readonly key: "commands"; readonly value: CommandSetting }
  | { readonly type: "setApproval"; readonly key: "mcp"; readonly value: boolean }
  | { readonly type: "listSessions" }
  | { readonly type: "switchSession"; readonly id: string }
  | { readonly type: "openConversation"; readonly id: string }
  | { readonly type: "deleteConversation"; readonly id: string }
  | { readonly type: "pinChat"; readonly id: string; readonly pinned: boolean }
  | { readonly type: "exportChat"; readonly id?: string }
  | { readonly type: "reviewNext" }
  | { readonly type: "newWorktreeAgent" }
  | { readonly type: "openWalkthrough" }
  | { readonly type: "removeQueued"; readonly id: string }
  | { readonly type: "openFile"; readonly path: string; readonly line?: number }
  | { readonly type: "renameChat"; readonly id?: string }
  | { readonly type: "openInEditor"; readonly id?: string }
  | { readonly type: "resetApprovals" }
  | { readonly type: "compact" }
  | {
      readonly type: "saveAssistant";
      readonly name: string;
      readonly avatar: string;
      readonly persona: Persona;
      readonly customPersona: string;
      readonly userName: string;
      readonly language: string;
    }
  | { readonly type: "skipOnboarding" }
  | { readonly type: "continueHandoff"; readonly path?: string }
  | { readonly type: "taskAction"; readonly action: "keep" | "undo" | "review"; readonly checkpointId: string }
  | { readonly type: "suggest" }
  | { readonly type: "runSuggestion"; readonly id: string }
  | { readonly type: "showWrapped"; readonly period: "week" | "month" }
  | { readonly type: "resetAppearance" }
  | { readonly type: "saveImage"; readonly dataUrl: string; readonly fileName: string };

export type AppearanceKey = "style" | "accentColor" | "fontSize" | "timestamps" | "mascot";

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
    case "editModes":
    case "editAllowlist":
    case "showTerminal":
    case "manageModels":
    case "contextQuery":
    case "showStats":
    case "listSessions":
    case "reviewNext":
    case "newWorktreeAgent":
    case "openWalkthrough":
    case "resetApprovals":
    case "compact":
    case "skipOnboarding":
    case "resetAppearance":
      return { type: message.type };
    case "saveAssistant": {
      const text = (key: string, max: number) =>
        typeof message[key] === "string" ? (message[key] as string).slice(0, max) : "";
      if (!personas.includes(message.persona as Persona)) return undefined;
      return {
        type: "saveAssistant",
        name: text("name", 32),
        avatar: text("avatar", 16),
        persona: message.persona as Persona,
        customPersona: text("customPersona", 1000),
        userName: text("userName", 40),
        language: text("language", 40),
      };
    }
    case "taskAction":
      return (message.action === "keep" || message.action === "undo" || message.action === "review") &&
        typeof message.checkpointId === "string" &&
        /^[\w-]{1,80}$/.test(message.checkpointId)
        ? { type: "taskAction", action: message.action, checkpointId: message.checkpointId }
        : undefined;
    case "suggest":
      return { type: "suggest" };
    case "runSuggestion":
      return typeof message.id === "string" && /^[\w:-]{1,40}$/.test(message.id)
        ? { type: "runSuggestion", id: message.id }
        : undefined;
    case "continueHandoff":
      if (message.path === undefined) return { type: "continueHandoff" };
      return typeof message.path === "string" && /^\.phew\/handoff\/[\w.-]{1,120}\.md$/.test(message.path)
        ? { type: "continueHandoff", path: message.path }
        : undefined;
    case "showWrapped":
      return message.period === "week" || message.period === "month"
        ? { type: "showWrapped", period: message.period }
        : undefined;
    case "copyText":
      return typeof message.text === "string" && message.text.length > 0 && message.text.length <= 2_000_000
        ? { type: "copyText", text: message.text }
        : undefined;
    case "saveImage": {
      const dataUrl = typeof message.dataUrl === "string" ? message.dataUrl : "";
      const fileName = typeof message.fileName === "string" ? message.fileName : "";
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 15_000_000) return undefined;
      if (!/^[\w.-]{1,80}\.png$/.test(fileName)) return undefined;
      return { type: "saveImage", dataUrl, fileName };
    }
    case "removeQueued": {
      const value = id("id");
      return value ? { type: "removeQueued", id: value } : undefined;
    }
    case "exportChat":
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
    case "pinChat": {
      const value = id("id");
      return value && typeof message.pinned === "boolean"
        ? { type: "pinChat", id: value, pinned: message.pinned }
        : undefined;
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
      if (key === "mascot" && ["lively", "calm", "still"].includes(String(value)))
        return { type: "setAppearance", key, value: value as string };
      if (key === "accentColor" && (value === "" || (typeof value === "string" && value.length <= 40)))
        return { type: "setAppearance", key, value: value as string };
      if (key === "fontSize" && (value === null || (typeof value === "number" && value >= 8 && value <= 32)))
        return { type: "setAppearance", key, value };
      return undefined;
    }
    case "useModel":
      return typeof message.id === "string" && message.id.length > 0 && message.id.length <= 200
        ? { type: "useModel", id: message.id }
        : undefined;
    case "terminalAction": {
      const terminal = typeof message.id === "string" && /^\d{1,4}$/.test(message.id) ? message.id : undefined;
      const action = message.action;
      return terminal && (action === "show" || action === "interrupt" || action === "kill")
        ? { type: "terminalAction", id: terminal, action }
        : undefined;
    }
    case "commandInput": {
      const value = id("id");
      return value && typeof message.data === "string" && message.data.length > 0 && message.data.length <= 10_000
        ? { type: "commandInput", id: value, data: message.data }
        : undefined;
    }
    case "fixCommand": {
      const value = id("id");
      return value ? { type: "fixCommand", id: value } : undefined;
    }
    case "stopCommand": {
      const value = id("id");
      return value ? { type: "stopCommand", id: value } : undefined;
    }
    case "setApprovalLevel":
      return approvalLevels.includes(message.level as ApprovalLevel)
        ? { type: "setApprovalLevel", level: message.level as ApprovalLevel }
        : undefined;
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
