import { accentPresets, defaultAppearance, readableAccent, textOnColor } from "../core/appearance";
import { type Attachment, isLongPaste, pastedLabel } from "../core/attachments";
import { chatGroup, chatGroupLabels, chatTime, highlightParts, matchesChat } from "../core/chatList";
import { type ChatStatus, type ChatStatusKind, chatStatus } from "../core/chatStatus";
import { lookOf, personaInfo } from "../core/persona";
import { summaryHeadline, summaryTotals } from "../core/summary";
import { icon } from "../shared/icons";
import type {
  HistoryItem,
  HostMessage,
  MentionItem,
  PlanView,
  QueuedView,
  SessionSummary,
  Suggestion,
  ViewState,
  WebviewMessage,
} from "../shared/protocol";
import { createApprovalsPanel } from "./approvalsPanel";
import { createAttachMenu } from "./attachMenu";
import { createChatFind } from "./chatFind";
import { copyWithFeedback, setCopyFallback } from "./copy";
import { renderMarkdown } from "./markdown";
import {
  actForTool,
  mascotSeesTyping,
  renderMascots,
  setMascotAct,
  setMascotMood,
  setMascotMotion,
  startMascotLife,
} from "./mascotLife";
import { createModelMenu, modelTitle, providerBadge } from "./modelMenu";
import { createModeMenu } from "./modeMenu";
import {
  avatar,
  type MascotState,
  mascot,
  playSound,
  setMascotState,
  showAchievementToast,
  showAssistantCard,
  showWrapped,
} from "./persona";
import { createSetupCard } from "./setupCard";
import { renderSubagent } from "./subagentCard";
import { appendCommandOutput, renderCommandTerminal, setCommandWhere, setTerminalLook } from "./terminalBlock";
import { createTerminalsPanel } from "./terminalsPanel";
import { groupSummary, toolLabel } from "./toolLabels";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const transcript = $<HTMLElement>("transcript");
const welcome = $<HTMLElement>("welcome");
const form = $<HTMLFormElement>("composer");
const prompt = $<HTMLTextAreaElement>("prompt");
const sendButton = $<HTMLButtonElement>("send");
const stopButton = $<HTMLButtonElement>("stop");
const modelButton = $<HTMLButtonElement>("model");
const chips = $<HTMLElement>("chips");
const mentionsBox = $<HTMLElement>("mentions");
const panel = $<HTMLElement>("panel");
const celebration = $<HTMLElement>("celebration");
const imageInput = $<HTMLInputElement>("imageInput");

let state: ViewState | undefined;
const assistants = new Map<string, { element: HTMLElement; body: HTMLElement; text: string }>();
const thoughts = new Map<string, { element: HTMLDetailsElement; body: HTMLElement; text: string; started: number }>();
const tools = new Map<string, HTMLDetailsElement>();
const approvals = new Map<string, HTMLElement>();
let attachments: { attachment: Attachment; label: string }[] = [];
type MenuItem = MentionItem | { readonly label: string; readonly detail: string; readonly command: string };
let mentionItems: MenuItem[] = [];
let mentionIndex = 0;
let mentionStart = -1;
let sessions: SessionSummary[] = [];
let history: HistoryItem[] = [];

interface Saved {
  promptHistory: string[];
  planOpen: boolean;
  /** How often the user opened a chat with the keyboard. The key hints hide once they are learned. */
  chatKeysUsed: number;
}
const saved: Saved = {
  promptHistory: [],
  planOpen: true,
  chatKeysUsed: 0,
  ...((vscode.getState() as Partial<Saved> | undefined) ?? {}),
};
let historyPosition = -1;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  if (title) node.title = title;
  node.addEventListener("click", onClick);
  return node;
}

/** Builds an icon from the static icon set. The SVG strings are constants, not user content. */
function iconNode(name: string): Element {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  return template.content.firstElementChild ?? document.createElement("span");
}

function iconButton(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = element("button", "action");
  node.type = "button";
  node.title = title;
  node.setAttribute("aria-label", title);
  node.append(iconNode(name));
  node.addEventListener("click", onClick);
  return node;
}

function copyIconButton(title: string, text: () => string, what: string): HTMLButtonElement {
  const node = iconButton("copy", title, () => void copyWithFeedback(node, text(), what));
  node.classList.add("copy-action");
  return node;
}

/** "13:47" or "01:47 PM", by the clock in Appearance. */
const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clockTime(date: Date): string {
  const clock = state?.appearance.clock ?? "auto";
  let format = clockFormats.get(clock);
  if (!format) {
    format = new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
      ...(clock === "auto" ? {} : { hour12: clock === "12h" }),
    });
    clockFormats.set(clock, format);
  }
  return format.format(date);
}

function time(at: number | undefined): HTMLElement {
  const node = element("time", "time");
  if (!at) return node;
  const date = new Date(at);
  node.textContent = clockTime(date);
  node.title = date.toLocaleString();
  node.dateTime = date.toISOString();
  return node;
}

function nearBottom(): boolean {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
}

const jump = $<HTMLButtonElement>("jump");

/** Follows new content only when the reader is already at the end, so text never jumps while you read. */
function follow(atBottom: boolean): void {
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  else jump.hidden = false;
}

let followFrame = 0;
let followAtBottom = true;

/**
 * Remembers whether the reader is at the end before the changes of this frame, and follows after them.
 * It measures once per frame, so a chat with hundreds of messages opens without a layout for each one.
 */
function keepFollowing(): void {
  if (followFrame) return;
  followAtBottom = nearBottom();
  followFrame = requestAnimationFrame(() => {
    followFrame = 0;
    follow(followAtBottom);
  });
}

function append(node: HTMLElement): void {
  welcome.hidden = true;
  keepFollowing();
  transcript.append(node);
}

// Clickable file references such as src/app.ts:42 or package.json.

const filePattern = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+))?(?::\d+)?(?![\w/-])/g;

function fileLink(path: string, line: string | undefined, label: string): HTMLAnchorElement {
  const link = element("a", "file-link", label);
  link.href = "#";
  link.title = `Open ${path}${line ? ` at line ${line}` : ""}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    vscode.postMessage({ type: "openFile", path, ...(line ? { line: Number(line) } : {}) });
  });
  return link;
}

function linkify(root: ParentNode): void {
  for (const code of root.querySelectorAll(":not(pre) > code")) {
    const text = code.textContent ?? "";
    const match = /^((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+))?(?::\d+)?$/.exec(text);
    if (match && !/^\d/.test(match[1])) {
      const link = fileLink(match[1], match[2], "");
      link.append(code.cloneNode(true));
      code.replaceWith(link);
    }
  }
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = (node as Text).parentElement;
    if (parent && !parent.closest("pre, code, a")) nodes.push(node as Text);
  }
  for (const node of nodes) {
    const text = node.textContent ?? "";
    filePattern.lastIndex = 0;
    if (!filePattern.test(text)) continue;
    filePattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(filePattern)) {
      const path = match[1];
      // Skip plain words with dots, such as "e.g" or version numbers.
      if (
        !path.includes("/") &&
        !match[2] &&
        !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|c|h|rb|php|swift|json|ya?ml|toml|md|css|scss|html|vue|svelte|sh|sql|tf)$/i.test(
          path,
        )
      )
        continue;
      const start = match.index ?? 0;
      fragment.append(text.slice(last, start), fileLink(path, match[2], match[0]));
      last = start + match[0].length;
    }
    if (last === 0) continue;
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}

/** Renders Markdown, adds Copy buttons to code blocks, and links file references. */
function markdown(text: string): DocumentFragment {
  const fragment = renderMarkdown(text);
  for (const pre of fragment.querySelectorAll("pre")) {
    const wrapper = element("div", "code");
    pre.replaceWith(wrapper);
    wrapper.append(
      copyButton(() => pre.textContent ?? ""),
      pre,
    );
  }
  linkify(fragment);
  return fragment;
}

/** The Copy button of a code block: an icon and a label, so the result is easy to see. */
function copyButton(text: () => string): HTMLButtonElement {
  const copy = element("button", "copy");
  copy.type = "button";
  copy.title = "Copy code";
  copy.setAttribute("aria-label", "Copy code");
  copy.append(iconNode("copy"), element("span", "copy-label", "Copy"));
  copy.addEventListener("click", () => void copyWithFeedback(copy, text(), "Code"));
  return copy;
}

// State

let mascotState: MascotState = "idle";
let mascotTimer: ReturnType<typeof setTimeout> | undefined;
let assistantKey = "";
let introduced = false;

function moveMascot(next: MascotState, settleAfter?: number): void {
  mascotState = next;
  setMascotState(next);
  setMascotMood(next);
  if (mascotTimer) clearTimeout(mascotTimer);
  mascotTimer = undefined;
  if (settleAfter)
    mascotTimer = setTimeout(() => {
      if (!state?.busy) moveMascot("idle");
    }, settleAfter);
}

/** Shows the name and the avatar of the assistant in the header and on the welcome screen. */
function applyAssistant(next: ViewState): void {
  setTerminalLook(next.assistant.avatar);
  const key = JSON.stringify(next.assistant);
  if (key !== assistantKey) {
    assistantKey = key;
    const live = (className: string) => {
      const node = avatar(next.assistant, className, mascotState);
      node.classList.add("live-mascot");
      return node;
    };
    $("headerAvatar").replaceChildren(live("header-mascot"));
    $("welcomeAvatar").replaceChildren(live("welcome-mascot"));
    $("statusMascot").replaceChildren(live("status-mascot-icon"));
    $("appearanceAvatar").replaceChildren(live("appearance-mascot"));
    $("assistantName").textContent = next.assistant.name;
    $("assistantPersona").textContent = personaInfo[next.assistant.persona]?.label ?? "";
    $("welcomeName").textContent = next.assistant.name;
    $("welcomeTagline").textContent = next.assistant.userName
      ? `Hi, ${next.assistant.userName}! Bug fixed. Phew.`
      : "Bug fixed. Phew.";
    for (const node of document.querySelectorAll(".message.assistant > .message-header > .avatar"))
      node.replaceWith(avatar(next.assistant, "avatar"));
    for (const node of document.querySelectorAll(".message.assistant:not(.btw) > .message-header > .who"))
      node.textContent = next.assistant.name;
  }
  renderMascots();
  if (next.busy && mascotState !== "working") moveMascot("working");
  if (!next.busy && mascotState === "working") moveMascot("idle");
  if (next.onboarding && !introduced && next.configured) {
    introduced = true;
    showAssistantCard(next.assistant, true, (message) => vscode.postMessage(message));
  }
}

let resumeKey = "";

/** "Continue where you left off" on the welcome screen, from the latest handoff note. */
let whatsNewKey = "";

/** "New in Phew 0.5" after an update: a few lines, the full changelog, and a close button. */
function renderWhatsNew(next: ViewState): void {
  const card = $("whatsNew");
  const key = next.whatsNew ? next.whatsNew.version : "";
  if (key === whatsNewKey) return;
  whatsNewKey = key;
  card.hidden = !next.whatsNew;
  if (!next.whatsNew) {
    card.replaceChildren();
    return;
  }
  const head = element("div", "whats-new-head");
  head.append(
    element("strong", undefined, `New in Phew ${next.whatsNew.version}`),
    iconButton("close", "Close", () => vscode.postMessage({ type: "dismissWhatsNew" })),
  );
  const list = element("ul");
  for (const item of next.whatsNew.items) list.append(element("li", undefined, item));
  const more = element("a", "link", "All changes");
  more.href = "https://github.com/LF3551/phew/blob/main/CHANGELOG.md";
  card.replaceChildren(head, list, more);
}

function renderResume(next: ViewState): void {
  const card = $("resumeCard");
  const key = next.handoff ? `${next.handoff.path}|${next.handoff.created}|${next.handoff.title}` : "";
  if (key === resumeKey) return;
  resumeKey = key;
  card.hidden = !next.handoff;
  if (!next.handoff) {
    card.replaceChildren();
    return;
  }
  const status =
    { "in-progress": "In progress", done: "Done", blocked: "Blocked" }[next.handoff.status] ?? next.handoff.status;
  const text = element("div", "resume-text");
  text.append(
    element("small", undefined, "Continue where you left off"),
    element("strong", undefined, next.handoff.title),
    element(
      "span",
      "resume-meta",
      `${status} · ${((when) => (when === "now" ? "just now" : `${when} ago`))(relativeTime(Date.parse(next.handoff.created)))}`,
    ),
  );
  const open = element("button", "link", "Read the note");
  open.type = "button";
  const path = next.handoff.path;
  open.addEventListener("click", () => vscode.postMessage({ type: "openFile", path }));
  const go = element("button", "primary", "Continue");
  go.type = "button";
  go.addEventListener("click", () => vscode.postMessage({ type: "continueHandoff" }));
  const actions = element("div", "resume-actions");
  actions.append(open, go);
  card.replaceChildren(text, actions);
}

function currentModeName(next: ViewState): string {
  return next.modes.find((mode) => mode.id === next.mode)?.name ?? "This";
}

function applyState(next: ViewState): void {
  state = next;
  if (latestCard) renderCardActions(latestCard);
  requestSuggestions();
  document.body.classList.toggle("in-sidebar", !next.pinned);
  renderStatus();
  applyAssistant(next);
  renderResume(next);
  renderWhatsNew(next);
  applyAppearance(next);
  $("titleText").textContent = next.title;
  const worktree = $("worktree");
  worktree.hidden = !next.worktree;
  worktree.textContent = next.worktree ? `⑂ ${next.worktree}` : "";
  const running = $("running");
  running.hidden = next.runningSessions === 0;
  running.textContent = next.runningSessions > 0 ? `● ${next.runningSessions}` : "";
  running.title = `${next.runningSessions} running`;
  // In the side bar, VS Code shows these buttons in the view title.
  $("popOut").hidden = true;
  $("historyButton").hidden = !next.pinned;
  $("newChat").hidden = !next.pinned;

  modeMenu.update(next.modes, next.mode, next.busy);

  const activeModel =
    next.models.find((model) => model.name === next.modeModel) ?? next.models.find((model) => model.active);
  if (activeModel) {
    const { title } = modelTitle(activeModel);
    const short =
      activeModel.provider === "vscode" && /^auto$/i.test(activeModel.model) ? "Auto" : next.modelId || title;
    modelButton.replaceChildren(providerBadge(activeModel), element("span", "model-label", short));
    modelButton.setAttribute("aria-label", `Model: ${short}`);
  } else {
    modelButton.textContent = next.configured ? next.modelId || next.model : "Connect a model";
    modelButton.removeAttribute("aria-label");
  }
  modelButton.classList.toggle("mode-locked", next.modeModel !== undefined);
  modelButton.title = next.configured
    ? `${next.model} (${next.provider})${next.modeModel ? ` · set by the ${currentModeName(next)} mode` : ""}. Click to switch.`
    : "Connect a model";
  modelMenu.update(next.models, next.busy, next.modeModel, currentModeName(next));
  terminalsPanel.update(next.terminals ?? []);
  setupCard.update(next.configured);
  // Without a model, the welcome makes room for the setup card; suggested tasks need a model.
  $("welcome").classList.toggle("needs-model", !next.configured);
  $("setup").hidden = next.configured || !$("setupCard").hidden;
  stopButton.hidden = !next.busy;
  const send = next.sendWith === "ctrlEnter" ? "Ctrl+Enter" : "Enter";
  updateSendButton();
  const modifier = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
  prompt.placeholder = next.busy ? "Add to the queue…" : `Ask ${next.assistant.name}…`;
  prompt.title = next.busy
    ? `Enter: add to the queue. ${modifier}+Enter: stop and send now. Esc: stop.`
    : `${send}: send. @: attach files, problems, Git changes, or the terminal. /: commands.`;
  const currentMode = next.modes.find((mode) => mode.id === next.mode);
  approvalsPanel.update(next.approvals, currentMode && !currentMode.changes ? currentMode.name : undefined);
  $("approvalsButton").hidden = !next.trusted;
  $("restricted").hidden = next.trusted;

  const context = $("context");
  const percent = Math.round(next.context * 100);
  // The context meter appears only when it starts to matter.
  context.hidden = percent < 50;
  context.dataset.level = percent >= 85 ? "high" : percent >= 60 ? "medium" : "low";
  context.style.setProperty("--fill", `${percent * 3.6}deg`);
  $("contextLabel").textContent = `${percent}%`;
  context.title = `${next.contextLabel}${percent >= 50 && !next.busy ? ". Click to compact the chat." : ""}${next.tokens !== "0" ? `\nThis chat: ${next.tokens} tokens${next.cost ? `, ${next.cost}` : ""}` : ""}`;
  updateReviewBanner();
  renderReviewList(next);
}

/** Your accent as a readable text color on every background of the chat: the panel, the input, and code. */
function accentText(accent: string): string {
  const style = getComputedStyle(document.body);
  const names = [
    "--vscode-sideBar-background",
    "--vscode-editor-background",
    "--vscode-input-background",
    "--vscode-textCodeBlock-background",
    "--vscode-editorWidget-background",
  ];
  const backgrounds = [style.backgroundColor, ...names.map((name) => style.getPropertyValue(name))]
    .map((value) => value.trim())
    .filter((value) => value && value !== "transparent" && value !== "rgba(0, 0, 0, 0)");
  return readableAccent(accent, backgrounds.length > 0 ? backgrounds : ["#1e1e1e"], style.color);
}

function applyAppearance(next: ViewState): void {
  const look = next.appearance;
  const body = document.body;
  body.classList.remove(
    "style-bubbles",
    "style-classic",
    "style-compact",
    "times-hover",
    "times-always",
    "times-never",
    "actions-hover",
    "actions-always",
  );
  body.classList.add(`style-${look.style}`, `times-${look.timestamps}`, `actions-${look.messageActions}`);
  body.classList.toggle("no-avatars", !look.avatars);
  setMascotMotion(look.mascot);
  const set = (name: string, value: string | undefined) =>
    value ? body.style.setProperty(name, value) : body.style.removeProperty(name);
  set("--phew-font-size", next.fontSize ? `${next.fontSize}px` : undefined);
  set("--phew-accent", look.accentColor || undefined);
  set("--phew-on-accent", look.accentColor ? textOnColor(look.accentColor) : undefined);
  // Text in your accent stays readable on this theme: the accent mixes with the text color only as far as needed.
  set("--phew-accent-text", look.accentColor ? accentText(look.accentColor) : undefined);
  set("--phew-user-bg", look.userBubbleColor || undefined);
  set("--phew-font-family", look.fontFamily || undefined);
  set("--phew-line-height", look.lineHeight ? String(look.lineHeight) : undefined);
  set("--phew-code-size", look.codeFontSize ? `${look.codeFontSize}px` : undefined);
  const choose = (selector: string, active: (button: HTMLButtonElement) => boolean) => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(selector)) {
      const on = active(button);
      button.classList.toggle("active", on);
      button.setAttribute("aria-checked", String(on));
    }
  };
  choose("#styleChoice button", (button) => button.dataset.style === look.style);
  choose("#timestampChoice button", (button) => button.dataset.value === look.timestamps);
  choose("#clockChoice button", (button) => button.dataset.value === look.clock);
  for (const node of document.querySelectorAll<HTMLTimeElement>("time.time[datetime]"))
    node.textContent = clockTime(new Date(node.dateTime));
  choose("#mascotChoice button", (button) => button.dataset.value === look.mascot);
  const accent = look.accentColor.toLowerCase();
  const preset = accentPresets.find((item) => item.color.toLowerCase() === accent);
  const custom = accent !== "" && !preset;
  choose("#swatches .swatch", (button) =>
    button.classList.contains("custom") ? custom : (button.dataset.color ?? "") === accent && !custom,
  );
  const customSwatch = $("customSwatch");
  customSwatch.style.background = custom ? look.accentColor : "";
  customSwatch.classList.toggle("filled", custom);
  $("accentName").textContent = custom ? look.accentColor : (preset?.name ?? "Theme");
  $("fontValue").textContent = String(Math.round(currentFontSize()));
  $("fontReset").hidden = !next.fontSize;
  $("resetAppearance").hidden =
    look.style === defaultAppearance.style &&
    !look.accentColor &&
    !next.fontSize &&
    look.timestamps === defaultAppearance.timestamps &&
    look.clock === defaultAppearance.clock &&
    look.mascot === defaultAppearance.mascot;
}

function currentFontSize(): number {
  return state?.fontSize ?? (Number.parseFloat(getComputedStyle(document.body).fontSize) || 13);
}

// Messages

function addUser(message: Extract<HostMessage, { type: "user" }>): void {
  const btw = message.text.startsWith("/btw ");
  const node = element("article", `message user${btw ? " btw" : ""}`);
  const header = element("div", "message-header");
  header.append(element("span", "who", "You"), time(message.at));
  const bubble = element("div", "bubble");
  bubble.append(element("div", "text", message.text));
  if (message.attachments && message.attachments.length > 0) {
    const list = element("div", "chips static");
    for (const label of message.attachments) list.append(element("span", "chip", label));
    bubble.append(list);
  }
  node.append(header, bubble);
  const actions = element("div", "message-actions");
  if (!btw) {
    actions.append(
      iconButton("restore", "Restore checkpoint: undo the file changes made since this message", () =>
        vscode.postMessage({ type: "restoreCheckpoint", checkpointId: message.checkpointId }),
      ),
      iconButton("edit", "Edit and resend: later messages go away, and changed files go back", () =>
        vscode.postMessage({ type: "editMessage", checkpointId: message.checkpointId }),
      ),
      iconButton("split", "Fork from here: a new chat up to this message; this chat stays", () =>
        vscode.postMessage({ type: "forkChat", checkpointId: message.checkpointId }),
      ),
    );
  }
  actions.append(
    copyIconButton("Copy message", () => message.text, "Message"),
    time(message.at),
  );
  node.append(actions);
  append(node);
}

function assistantEntry(id: string, variant?: "btw") {
  let entry = assistants.get(id);
  if (!entry) {
    const node = element("article", `message assistant streaming${variant ? ` ${variant}` : ""}`);
    const header = element("div", "message-header");
    const name = state?.assistant.name ?? "Phew";
    header.append(
      avatar(state?.assistant, "avatar"),
      element("span", "who", variant === "btw" ? `${name} · btw` : name),
    );
    const body = element("div", "body");
    node.append(header, body);
    entry = { element: node, body, text: "" };
    assistants.set(id, entry);
    append(node);
  }
  return entry;
}

function renderAssistant(id: string, text: string, done: boolean, at?: number, variant?: "btw"): void {
  const entry = assistantEntry(id, variant);
  entry.text = text;
  keepFollowing();
  if (done) {
    entry.element.classList.remove("streaming");
    if (text.trim() === "") {
      entry.element.remove();
      return;
    }
    entry.body.replaceChildren(markdown(text));
    setActivity(undefined);
    const header = entry.element.querySelector(".message-header");
    const done = entry;
    header?.append(
      time(at),
      copyIconButton("Copy answer", () => done.text, "Answer"),
    );
  } else {
    entry.body.textContent = text;
    setActivity("Writing…");
    setMascotAct("write");
  }
}

function renderThought(id: string, delta: string, done: boolean, full?: string): void {
  let entry = thoughts.get(id);
  if (!entry) {
    const node = element("details", "thinking");
    node.open = true;
    const summary = element("summary", "thinking-summary", "Thinking…");
    const body = element("div", "thinking-body");
    node.append(summary, body);
    entry = { element: node, body, text: "", started: Date.now() };
    thoughts.set(id, entry);
    append(node);
  }
  keepFollowing();
  entry.text = full ?? entry.text + delta;
  entry.body.textContent = entry.text;
  if (!done) {
    setActivity("Thinking…");
    setMascotAct("think");
  }
  if (done) {
    const seconds = Math.max(1, Math.round((Date.now() - entry.started) / 1000));
    const summary = entry.element.querySelector("summary");
    if (summary) summary.textContent = full !== undefined && !delta ? "Thought" : `Thought for ${seconds} s`;
    entry.element.open = false;
  }
}

/** Consecutive tool calls share one quiet line: "Read 3 files and edited 1 file". The details open on click. */
function toolGroup(): HTMLElement {
  const last = transcript.lastElementChild;
  if (last instanceof HTMLDetailsElement && last.classList.contains("tool-group")) return last;
  const group = element("details", "tool-group");
  group.append(element("summary", "group-summary"), element("div", "group-body"));
  append(group);
  return group;
}

function refreshGroup(group: Element): void {
  const items = [...group.querySelectorAll<HTMLElement>(".group-body > .tool")];
  const status = items.some((item) => item.dataset.status === "running")
    ? "running"
    : items.some((item) => item.dataset.status === "error")
      ? "error"
      : "done";
  (group as HTMLElement).dataset.status = status;
  const summary = group.querySelector(".group-summary");
  if (!summary) return;
  const icon = status === "running" ? "⋯" : status === "error" ? "✕" : "✓";
  const failed = items.filter((item) => item.dataset.status === "error").length;
  summary.replaceChildren(
    element("span", "icon", icon),
    element(
      "span",
      "label",
      `${groupSummary(items.map((item) => item.dataset.name ?? ""))}${failed ? ` · ${failed} failed` : ""}`,
    ),
  );
}

function updateTool(message: Extract<HostMessage, { type: "tool" }>): void {
  let node = tools.get(message.id);
  if (!node) {
    node = element("details", "tool");
    tools.set(message.id, node);
    keepFollowing();
    // A command stands on its own in the chat; other tools share a quiet group line.
    if (message.name === "run_command") append(node);
    else toolGroup().querySelector(".group-body")?.append(node);
  }
  node.dataset.status = message.status;
  node.dataset.name = message.name;
  const running = message.status === "running";
  const label = toolLabel(message.name, message.summary, running);
  const summary = element("summary");
  const icon = running ? "⋯" : message.status === "error" ? "✕" : "✓";
  summary.append(element("span", "icon", icon), element("span", "label", label), time(message.at));
  summary.title = message.summary;
  if (message.name === "run_command") {
    // A command shows what it does, the command, and its output, live while it runs.
    node.classList.add("command-tool");
    const view = renderCommandTerminal(
      message.id,
      {
        command: message.command ?? message.summary.replace(/^run_command\s*/, ""),
        description: message.description,
        where: message.where,
        approval: message.approval,
        terminal: message.terminal,
        status: message.status,
        detail: message.detail,
        at: message.at,
      },
      (payload) => vscode.postMessage(payload),
    );
    node.replaceChildren(summary, view);
    node.open = true;
  } else {
    node.replaceChildren(summary);
    if (message.detail) node.append(element("pre", "detail", message.detail));
  }
  const group = node.closest(".tool-group");
  if (group) refreshGroup(group);
  setActivity(running ? `${message.description ?? label}…` : "Thinking…");
  setMascotAct(running ? actForTool(message.name) : "think");
}

// The summary card: what changed, whether the check passes, and Keep or Undo in one place.

let latestCard: HTMLElement | undefined;
let cardVisible = false;

// The review banner repeats the card, so it shows only while the card with the actions is out of view.
const cardObserver = new IntersectionObserver((entries) => {
  cardVisible = entries.some((entry) => entry.isIntersecting);
  updateReviewBanner();
});

/**
 * The changes to review, above the input: how many files, the lines added and removed, Keep all and Undo all,
 * and a list with Keep and Undo for each file. A click on a name opens the file.
 */
function renderReviewList(next: ViewState): void {
  const files = next.reviewList ?? [];
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  $("reviewText").textContent = `${next.reviewFiles} ${next.reviewFiles === 1 ? "file" : "files"} to review`;
  const stats = $("reviewStats");
  stats.replaceChildren();
  if (added) stats.append(element("ins", undefined, `+${added}`));
  if (removed) stats.append(element("del", undefined, `−${removed}`));
  const list = $("reviewList");
  list.replaceChildren(
    ...files.map((file) => {
      const row = element("li", "review-file");
      const name = element("button", "review-name");
      name.type = "button";
      const slash = file.path.lastIndexOf("/");
      name.append(
        element("span", "review-base", file.path.slice(slash + 1)),
        element("span", "review-dir", slash > 0 ? file.path.slice(0, slash) : ""),
      );
      name.title = `Open ${file.path}`;
      name.addEventListener("click", () => vscode.postMessage({ type: "reviewFile", uri: file.uri, action: "open" }));
      const counts = element("span", "review-stats");
      if (file.added) counts.append(element("ins", undefined, `+${file.added}`));
      if (file.removed) counts.append(element("del", undefined, `−${file.removed}`));
      row.append(
        name,
        counts,
        iconButton("close", `Undo the changes in ${file.path}`, () =>
          vscode.postMessage({ type: "reviewFile", uri: file.uri, action: "undo" }),
        ),
        iconButton("check", `Keep the changes in ${file.path}`, () =>
          vscode.postMessage({ type: "reviewFile", uri: file.uri, action: "keep" }),
        ),
      );
      return row;
    }),
  );
}

/**
 * A quiet card under a task that went well: rate Phew or send feedback, side by side. Any answer closes it;
 * Rate and Send feedback say thank you first.
 */
function addRatingCard(store: string): void {
  const card = element("section", "rating-card");
  card.setAttribute("aria-label", "Rate Phew");
  const text = element("div", "rating-text");
  text.append(
    element("strong", undefined, "Does Phew help you?"),
    element(
      "span",
      undefined,
      `A rating on ${store} helps other developers find it. Ideas and problems are welcome too.`,
    ),
  );
  const answer = (value: "rate" | "feedback" | "later" | "never") => {
    vscode.postMessage({ type: "ratingAnswer", answer: value });
    if (value === "rate" || value === "feedback") {
      card.replaceChildren(
        element(
          "span",
          "rating-thanks",
          value === "rate" ? "Thank you! ♥" : "Thank you for helping to make Phew better.",
        ),
      );
      setTimeout(() => card.remove(), 4000);
    } else card.remove();
  };
  const actions = element("div", "rating-actions");
  actions.append(
    button("Rate Phew", "primary", () => answer("rate"), `Opens ${store} in your browser`),
    button("Send feedback", "secondary", () => answer("feedback"), "Opens a new issue on GitHub"),
    button("Not now", "link", () => answer("later")),
    button("Don't ask again", "link", () => answer("never")),
  );
  card.append(text, actions);
  append(card);
}

function updateReviewBanner(): void {
  const pending = state?.reviewFiles ?? 0;
  $("reviewBanner").hidden = pending === 0 || (cardVisible && latestCard?.isConnected === true);
}
let cardThisTask = false;

function renderCardActions(card: HTMLElement): void {
  const actions = card.querySelector<HTMLElement>(".task-actions");
  if (!actions) return;
  const checkpointId = card.dataset.checkpoint ?? "";
  const pending = (state?.reviewFiles ?? 0) > 0;
  const act = (action: "keep" | "undo" | "review") => vscode.postMessage({ type: "taskAction", action, checkpointId });
  const buttons: HTMLButtonElement[] = [];
  if (pending) {
    buttons.push(button("Review", "secondary", () => act("review"), "Go to the next change in the editor"));
    buttons.push(button("Undo all", "secondary", () => act("undo"), "Undo all changes of this task"));
    buttons.push(button("Keep all", "primary", () => act("keep"), "Keep all changes of this task"));
  } else {
    buttons.push(button("Undo", "secondary", () => act("undo"), "Restore the files to their state before this task"));
  }
  actions.replaceChildren(...buttons);
}

function addSummary(message: Extract<HostMessage, { type: "summary" }>): void {
  // Only the newest card has actions, so an old card cannot undo newer work by surprise.
  latestCard?.querySelector(".task-actions")?.replaceChildren();
  const card = element("section", "task-card");
  card.dataset.status = message.status;
  card.dataset.checkpoint = message.checkpointId;
  const success = message.status === "done" && message.check?.passed !== false;
  const icon = mascot(success ? "done" : message.status === "aborted" ? "idle" : "failed");
  icon.classList.add("task-mascot", "again");
  const header = element("header", "task-head");
  header.append(icon, element("strong", undefined, summaryHeadline(message)));
  card.append(header);
  if (message.check) {
    const check = element(
      "p",
      `task-check ${message.check.passed ? "passed" : "failed"}`,
      message.check.passed
        ? `✓ ${message.check.command} passes${message.check.attempts > 1 ? ` after ${message.check.attempts} attempts` : ""}`
        : `✕ ${message.check.command} still fails after ${message.check.attempts} ${message.check.attempts === 1 ? "attempt" : "attempts"}`,
    );
    card.append(check);
  }
  const list = element("ul", "task-files");
  for (const file of message.files.slice(0, 8)) {
    const row = element("li");
    const name = element("button", "task-file", file.path);
    name.type = "button";
    name.title = `Open ${file.path}`;
    const filePath = file.path;
    if (file.kind !== "deleted")
      name.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: filePath }));
    else name.disabled = true;
    row.append(name);
    if (file.kind !== "modified") row.append(element("span", "task-kind", file.kind === "added" ? "new" : "deleted"));
    const counts = element("span", "task-counts");
    if (file.added) counts.append(element("span", "plus", `+${file.added}`));
    if (file.removed) counts.append(element("span", "minus", `−${file.removed}`));
    row.append(counts);
    list.append(row);
  }
  if (message.files.length > 8) list.append(element("li", "task-more", `and ${message.files.length - 8} more`));
  card.append(list);
  const footer = element("footer", "task-foot");
  footer.append(element("span", "task-totals", summaryTotals(message.files)), element("div", "task-actions"));
  card.append(footer);
  latestCard = card;
  cardThisTask = true;
  cardObserver.disconnect();
  cardObserver.observe(card);
  renderCardActions(card);
  append(card);
}

// The welcome screen offers real tasks from the project.

let suggestedAt = 0;

function requestSuggestions(): void {
  if (welcome.hidden || Date.now() - suggestedAt < 4000) return;
  suggestedAt = Date.now();
  vscode.postMessage({ type: "suggest" });
}

function renderSuggestions(items: readonly Suggestion[]): void {
  const box = $("suggestions");
  box.replaceChildren(
    ...items.map((item) => {
      const row = element("button", "suggestion");
      row.type = "button";
      const text = element("span", "suggestion-text");
      text.append(element("strong", undefined, item.title), element("span", undefined, item.detail));
      row.append(iconNode(item.icon), text);
      row.addEventListener("click", () => vscode.postMessage({ type: "runSuggestion", id: item.id }));
      return row;
    }),
  );
}

// The live status line: one calm sentence about what the agent does now.

let activity: string | undefined;
let busySince = 0;
/** When the last sign of life came from the model: text, thinking, a tool call, or output. */
let lastSignAt = 0;
/** After this long without a sign while nothing else runs, the chat offers Retry and Switch model. */
const quietModelMs = 30_000;
let activityTimer: ReturnType<typeof setInterval> | undefined;

function setActivity(text: string | undefined): void {
  activity = text;
  renderStatus();
}

function renderStatus(): void {
  const line = $("statusLine");
  const busy = state?.busy === true;
  line.hidden = !busy;
  if (!busy) {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = undefined;
    busySince = 0;
    activity = undefined;
    return;
  }
  if (!busySince) busySince = Date.now();
  if (!lastSignAt || lastSignAt < busySince) lastSignAt = busySince;
  if (!activityTimer) activityTimer = setInterval(renderStatus, 1000);
  // Silence is normal while a command runs or a question waits for you; otherwise the model is slow or stuck.
  const quiet = Date.now() - lastSignAt;
  const othersRun =
    document.querySelector('.tool[data-status="running"]') !== null ||
    document.querySelector(".approval:not(.resolved)") !== null;
  const stalled = !othersRun && quiet >= quietModelMs;
  $("statusStall").hidden = !stalled;
  line.classList.toggle("stalled", stalled);
  $("statusText").textContent = stalled
    ? `No answer from the model for ${Math.floor(quiet / 1000)} s`
    : (activity ?? "Working…");
  const seconds = Math.floor((Date.now() - busySince) / 1000);
  $("statusTime").hidden = stalled;
  $("statusTime").textContent =
    seconds >= 3 ? (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`) : "";
}

function addApproval(message: Extract<HostMessage, { type: "approval" }>): void {
  setMascotAct("wait");
  const card = element("section", `approval ${message.kind}`);
  card.append(element("h3", undefined, message.kind === "question" ? `❓ ${message.title}` : message.title));
  if (message.reason) card.append(element("p", "reason", message.reason));
  const actions = element("div", "actions");

  if (message.kind === "question") {
    const options = element("div", "options");
    for (const option of message.options ?? []) {
      options.append(
        button(option, "secondary option", () =>
          vscode.postMessage({ type: "approve", id: message.id, decision: "allow", text: option }),
        ),
      );
    }
    card.append(options);
    if (message.allowText !== false) {
      const answer = element("textarea", "answer");
      answer.rows = 2;
      answer.placeholder = "Type an answer";
      answer.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && answer.value.trim()) {
          event.preventDefault();
          vscode.postMessage({ type: "approve", id: message.id, decision: "allow", text: answer.value.trim() });
        }
      });
      card.append(answer);
      actions.append(
        button("Skip", "secondary", () =>
          vscode.postMessage({ type: "approve", id: message.id, decision: "deny", text: "" }),
        ),
        button("Answer", "primary", () => {
          if (answer.value.trim())
            vscode.postMessage({ type: "approve", id: message.id, decision: "allow", text: answer.value.trim() });
        }),
      );
    } else
      actions.append(
        button("Skip", "secondary", () =>
          vscode.postMessage({ type: "approve", id: message.id, decision: "deny", text: "" }),
        ),
      );
    card.append(actions);
    approvals.set(message.id, card);
    append(card);
    card.scrollIntoView({ block: "nearest" });
    return;
  }

  const selected = new Set((message.hunks ?? []).map((hunk) => hunk.index));
  if (message.kind === "edit") {
    card.append(element("p", "detail", message.detail));
    const list = element("div", "hunks");
    for (const hunk of message.hunks ?? []) {
      const row = element("label", "hunk");
      const box = element("input");
      box.type = "checkbox";
      box.checked = true;
      box.addEventListener("change", () => {
        if (box.checked) selected.add(hunk.index);
        else selected.delete(hunk.index);
      });
      const pre = element("pre");
      for (const line of hunk.preview.split("\n")) {
        const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "meta";
        pre.append(element("span", kind, `${line}\n`));
      }
      row.append(box, pre);
      list.append(row);
    }
    card.append(list);
  } else {
    const command = element("pre", "command");
    command.append(element("span", "command-prompt", "$ "), message.detail);
    card.append(command);
  }

  if (message.kind === "edit")
    actions.append(button("Open diff", "secondary", () => vscode.postMessage({ type: "openDiff", id: message.id })));
  // "Always allow npm test": the command runs now, and such commands stop asking.
  if (message.kind === "command" && message.alwaysAllow) {
    const always = element("button", "secondary always-allow");
    always.type = "button";
    always.title = `Run it, and add "${message.alwaysAllow}" to your allowlist`;
    always.append("Always allow ", element("code", undefined, message.alwaysAllow));
    always.addEventListener("click", () =>
      vscode.postMessage({ type: "approve", id: message.id, decision: "allow", text: "always" }),
    );
    actions.append(always);
  }
  actions.append(
    button(message.kind === "edit" ? "Reject" : "Deny", "secondary", () =>
      vscode.postMessage({ type: "approve", id: message.id, decision: "deny" }),
    ),
    button(message.kind === "edit" ? "Apply selected" : message.kind === "command" ? "Run" : "Allow", "primary", () =>
      vscode.postMessage({
        type: "approve",
        id: message.id,
        decision: "allow",
        ...(message.kind === "edit" ? { hunks: [...selected] } : {}),
      }),
    ),
  );
  card.append(actions);
  approvals.set(message.id, card);
  append(card);
  card.scrollIntoView({ block: "nearest" });
}

function resolveApproval(id: string, decision: string): void {
  setMascotAct("think");
  const card = approvals.get(id);
  if (!card) return;
  approvals.delete(id);
  // A command shows its decision in the terminal below, so its card goes away instead of folding.
  if (card.classList.contains("command") && !card.classList.contains("question")) {
    card.classList.add("leaving");
    setTimeout(() => card.remove(), 220);
    return;
  }
  card.classList.add("resolved");
  for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(
    "button, input, textarea",
  )) {
    control.disabled = true;
  }
  card.querySelector(".options")?.remove();
  card.querySelector(".answer")?.remove();
  card.querySelector(".actions")?.replaceChildren(element("span", `decision ${decision.split(":")[0]}`, decision));
}

function renderPlan(plan: PlanView): void {
  const section = $("plan");
  section.hidden = !plan.goal && plan.items.length === 0;
  const done = plan.items.filter((item) => item.status === "done").length;
  $("planTitle").textContent = plan.goal ? plan.goal : "Plan";
  $("planProgress").textContent = plan.items.length > 0 ? `${done}/${plan.items.length}` : "";
  const list = $("planItems");
  list.hidden = !saved.planOpen;
  $("planToggle").setAttribute("aria-expanded", String(saved.planOpen));
  list.replaceChildren(
    ...plan.items.map((item) => {
      const row = element("li", `plan-item ${item.status}`);
      row.append(
        element("span", "mark", item.status === "done" ? "✓" : item.status === "in_progress" ? "●" : "○"),
        element("span", undefined, item.text),
      );
      return row;
    }),
  );
}

function renderQueue(items: readonly QueuedView[]): void {
  const list = $("queue");
  list.hidden = items.length === 0;
  list.replaceChildren(
    ...items.map((item) => {
      const row = element("li", "queued");
      row.append(element("span", "queued-label", "Queued"), element("span", "queued-text", item.text));
      row.append(button("×", "remove", () => vscode.postMessage({ type: "removeQueued", id: item.id }), "Remove"));
      return row;
    }),
  );
}

function celebrate(): void {
  celebration.hidden = false;
  celebration.classList.remove("play");
  void celebration.offsetWidth;
  celebration.classList.add("play");
  setTimeout(() => {
    celebration.hidden = true;
  }, 1800);
}

function clearTranscript(): void {
  latestCard = undefined;
  cardVisible = false;
  cardObserver.disconnect();
  for (const node of [...transcript.children]) if (node !== welcome) node.remove();
  assistants.clear();
  thoughts.clear();
  tools.clear();
  approvals.clear();
  welcome.hidden = false;
  renderPlan({ items: [] });
  renderQueue([]);
}

// Attachments

function renderChips(): void {
  chips.replaceChildren(
    ...attachments.map((item, index) => {
      const chip = element("span", `chip ${item.attachment.kind}`);
      if (item.attachment.kind === "image") {
        const image = element("img");
        image.src = `data:${item.attachment.mimeType};base64,${item.attachment.data}`;
        image.alt = item.label;
        chip.append(image);
      }
      if (item.attachment.kind === "text") {
        // The label opens the pasted text to read or change it.
        const open = element("button", "chip-label chip-open", item.label);
        open.type = "button";
        open.title = "Show and edit the pasted text";
        open.addEventListener("click", () => openPaste(index));
        chip.append(open);
      } else chip.append(element("span", "chip-label", item.label));
      chip.append(
        button(
          "×",
          "remove",
          () => {
            attachments.splice(index, 1);
            renderChips();
          },
          "Remove",
        ),
      );
      return chip;
    }),
  );
  attachMenu.refresh();
  updateSendButton();
}

let pasteIndex = -1;

/** Shows a pasted text in a small editor above the input. */
function openPaste(index: number): void {
  const item = attachments[index];
  if (item?.attachment.kind !== "text") return;
  pasteIndex = index;
  const editor = $("pasteEditor");
  closePopovers(editor);
  $("pasteTitle").textContent = item.label;
  $<HTMLTextAreaElement>("pasteText").value = item.attachment.text;
  editor.hidden = false;
  const area = $<HTMLTextAreaElement>("pasteText");
  area.focus();
  area.setSelectionRange(0, 0);
  area.scrollTop = 0;
}

function closePaste(): void {
  $("pasteEditor").hidden = true;
  pasteIndex = -1;
  prompt.focus();
}

function addAttachment(attachment: Attachment, label: string): void {
  if (attachments.length >= 20) return;
  const key = JSON.stringify(attachment);
  if (attachments.some((item) => JSON.stringify(item.attachment) === key)) return;
  attachments.push({ attachment, label });
  renderChips();
}

function removeAttachment(attachment: Attachment): void {
  const key = JSON.stringify(attachment);
  attachments = attachments.filter((item) => JSON.stringify(item.attachment) !== key);
  renderChips();
}

function readImage(file: File): void {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 5_000_000) return;
  const reader = new FileReader();
  reader.onload = () => {
    const data = String(reader.result).split(",")[1] ?? "";
    addAttachment(
      { kind: "image", name: file.name || "pasted image", mimeType: file.type, data },
      file.name || "Pasted image",
    );
  };
  reader.readAsDataURL(file);
}

// @ mentions

function currentMention(): string | undefined {
  const before = prompt.value.slice(0, prompt.selectionStart);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  mentionStart = before.length - match[2].length - 1;
  return match[2];
}

const slashCommands = [
  { command: "/init", detail: "Write AGENTS.md so any agent understands this project" },
  { command: "/learn", detail: "Save what this chat taught, after you choose" },
  { command: "/continue", detail: "Continue from the latest handoff note" },
  { command: "/handoff", detail: "Write a handoff note so any agent can continue" },
  { command: "/btw", detail: "Ask a side question while the agent works" },
  { command: "/goal", detail: "Set the goal of this chat" },
  { command: "/compact", detail: "Summarize the chat to free context" },
];

/** Shows the slash commands while the input starts with "/" and has no space yet. */
function slashMenu(): boolean {
  const match = /^\/(\w*)$/.exec(prompt.value.slice(0, prompt.selectionStart));
  if (!match || prompt.value.includes(" ")) return false;
  const items = slashCommands
    .filter((item) => item.command.slice(1).startsWith(match[1].toLowerCase()))
    .map((item) => ({ label: item.command, detail: item.detail, command: item.command }));
  showMentions(items);
  return items.length > 0;
}

function showMentions(items: MenuItem[]): void {
  mentionItems = items;
  mentionIndex = 0;
  mentionsBox.hidden = items.length === 0;
  renderMentions();
}

function renderMentions(): void {
  mentionsBox.replaceChildren(
    ...mentionItems.map((item, index) => {
      const row = element("div", `mention${index === mentionIndex ? " selected" : ""}`);
      row.setAttribute("role", "option");
      row.append(element("span", "label", item.label));
      if (item.detail) row.append(element("span", "detail", item.detail));
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        chooseMention(index);
      });
      return row;
    }),
  );
  mentionsBox.children[mentionIndex]?.scrollIntoView({ block: "nearest" });
}

function chooseMention(index: number): void {
  const item = mentionItems[index];
  if (!item) return;
  if ("command" in item) {
    prompt.value = `${item.command} `;
    prompt.selectionStart = prompt.selectionEnd = prompt.value.length;
    showMentions([]);
    prompt.focus();
    return;
  }
  const end = prompt.selectionStart;
  prompt.value = `${prompt.value.slice(0, mentionStart)}${prompt.value.slice(end)}`;
  prompt.selectionStart = prompt.selectionEnd = mentionStart;
  addAttachment(item.attachment, item.detail && item.attachment.kind === "file" ? item.detail : item.label);
  showMentions([]);
  prompt.focus();
}

/** The color of the label of each state in the list of chats. */
const statusTone: Record<ChatStatusKind, string> = {
  waiting: "warn",
  stalled: "warn",
  fallback: "live",
  running: "live",
  failed: "bad",
  done: "good",
  idle: "",
};

// Sessions panel

interface ChatRow {
  readonly id: string;
  readonly title: string;
  readonly preview?: string;
  readonly updatedAt: number;
  readonly open: boolean;
  readonly active: boolean;
  readonly running: boolean;
  readonly needsApproval: boolean;
  readonly worktree?: string;
  readonly pinned: boolean;
  readonly status: ChatStatus;
}

const chatList = $("chatList");
const rowMenu = $("rowMenu");
const startMenu = $("startMenu");
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
let visibleRows: ChatRow[] = [];
let selectedRow = 0;
let undoTimer: ReturnType<typeof setTimeout> | undefined;

function chatRows(): ChatRow[] {
  const open: ChatRow[] = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    open: true,
    active: session.active,
    running: session.running,
    needsApproval: session.needsApproval,
    worktree: session.worktree,
    pinned: session.pinned === true,
    status: chatStatus({
      busy: session.running,
      needsApproval: session.needsApproval,
      stalled: session.stalled === true,
      fallback: session.fallback,
      outcome: session.outcome,
    }),
  }));
  open.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
  const saved: ChatRow[] = history.map((item) => ({
    id: item.id,
    title: item.title,
    preview: item.preview,
    updatedAt: item.updatedAt,
    open: false,
    active: false,
    running: false,
    needsApproval: false,
    worktree: item.worktree,
    pinned: item.pinned === true,
    status: chatStatus({ busy: false, needsApproval: false, stalled: false }),
  }));
  const rows = [...open, ...saved].filter((row) => !pendingDeletes.has(row.id));
  return [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)];
}

function highlighted(className: string, text: string, query: string): HTMLElement {
  const node = element("span", className);
  for (const part of highlightParts(text, query))
    node.append(part.match ? element("mark", undefined, part.text) : part.text);
  return node;
}

/** Full-text matches from the host for the current search: chat id → a piece of the text. */
let contentMatches = { query: "", snippets: new Map<string, string>() };
let historySearchTimer: ReturnType<typeof setTimeout> | undefined;

/** Asks the host to search the messages of all chats, a moment after the typing stops. */
function searchHistoryContent(query: string): void {
  clearTimeout(historySearchTimer);
  if (query.length < 2) {
    contentMatches = { query, snippets: new Map() };
    return;
  }
  historySearchTimer = setTimeout(() => vscode.postMessage({ type: "searchHistory", query }), 200);
}

function renderPanel(): void {
  const query = $<HTMLInputElement>("historySearch").value.trim();
  const snippets = contentMatches.query === query ? contentMatches.snippets : new Map<string, string>();
  const rows = chatRows().filter((row) => matchesChat(query, row.title, row.preview) || snippets.has(row.id));
  const now = Date.now();
  visibleRows = [];
  const children: HTMLElement[] = [];
  let group = "";
  for (const row of rows) {
    const label = row.pinned ? "Pinned" : row.open ? "Open" : chatGroupLabels[chatGroup(row.updatedAt, now)];
    if (label !== group) {
      group = label;
      children.push(element("div", "chat-group", label));
    }
    // A chat found by its messages shows the matching words instead of its first line.
    const snippet = matchesChat(query, row.title, row.preview) ? undefined : snippets.get(row.id);
    children.push(chatRowNode(snippet ? { ...row, preview: snippet } : row, visibleRows.length, query, now));
    visibleRows.push(row);
  }
  if (rows.length === 0) {
    const empty = element("div", "chat-empty");
    if (query) {
      empty.append(element("p", undefined, `No chats match “${query}”.`));
      empty.append(
        button("Start a new chat with this", "link", () => {
          vscode.postMessage({ type: "newChat" });
          togglePanel(false);
          prompt.value = query;
          prompt.focus();
        }),
      );
    } else {
      empty.append(element("p", undefined, "Your chats will appear here."));
    }
    children.push(empty);
  }
  chatList.replaceChildren(...children);
  $("panelKeys").hidden = saved.chatKeysUsed >= 3;
  selectRow(Math.min(selectedRow, Math.max(0, visibleRows.length - 1)), false);
}

function chatRowNode(row: ChatRow, index: number, query: string, now: number): HTMLElement {
  const node = element("div", `chat-row${row.active ? " current" : ""}${row.open ? " open" : ""}`);
  node.id = `chat-${index}`;
  node.setAttribute("role", "option");
  node.dataset.index = String(index);
  const main = element("button", "chat-open");
  main.type = "button";
  main.tabIndex = -1;
  main.title = `${row.title}\n${new Date(row.updatedAt).toLocaleString()}`;
  const line = element("span", "chat-line");
  const status = element("span", "chat-status");
  if (row.pinned) {
    status.classList.add("pinned");
    status.append(iconNode("pin"));
  }
  // The state of the chat: who needs you, which has a problem, which works, and which is done.
  const kind = row.status.kind;
  if (kind !== "idle") status.classList.add(kind);
  else if (row.active) status.classList.add("current");
  else if (row.open) status.classList.add("open");
  status.setAttribute(
    "aria-label",
    kind !== "idle" ? row.status.description : row.active ? "Current chat" : row.open ? "Open" : "",
  );
  line.append(status, highlighted("chat-title", row.title, query));
  if (kind === "idle") line.append(element("span", "chat-time", chatTime(row.updatedAt, now)));
  else {
    const label = element("span", `chat-time ${statusTone[kind]}`, row.status.label);
    label.title = row.status.description;
    line.append(label);
  }
  main.append(line);
  if (row.preview || row.worktree) {
    const detail = element("span", "chat-detail");
    if (row.worktree) {
      const tag = element("span", "chat-tag", `⑂ ${row.worktree}`);
      tag.title = `Branch ${row.worktree}`;
      detail.append(tag);
    }
    if (row.preview) detail.append(highlighted("chat-preview", row.preview, query));
    main.append(detail);
  }
  main.addEventListener("click", (event) => openRow(row, event.metaKey || event.ctrlKey));
  // A middle click opens the chat in a new tab, like a link in a browser.
  main.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    openRow(row, true);
  });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    selectRow(index, false);
    showRowMenu(row, more, { x: event.clientX, y: event.clientY });
  });
  const more = element("button", "chat-more");
  more.type = "button";
  more.tabIndex = -1;
  more.title = "Chat actions";
  more.setAttribute("aria-label", `Actions for ${row.title}`);
  more.setAttribute("aria-haspopup", "menu");
  more.append(iconNode("more"));
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    selectRow(index, false);
    showRowMenu(row, more);
  });
  node.addEventListener("mousemove", () => {
    if (selectedRow !== index) selectRow(index, false);
  });
  node.append(main, more);
  return node;
}

function selectRow(index: number, scroll = true): void {
  selectedRow = index;
  const input = $<HTMLInputElement>("historySearch");
  for (const node of chatList.querySelectorAll<HTMLElement>(".chat-row")) {
    const selected = node.dataset.index === String(index);
    node.classList.toggle("selected", selected);
    node.setAttribute("aria-selected", String(selected));
    if (selected) {
      input.setAttribute("aria-activedescendant", node.id);
      if (scroll) node.scrollIntoView({ block: "nearest" });
    }
  }
  if (visibleRows.length === 0) input.removeAttribute("aria-activedescendant");
}

function openRow(row: ChatRow, inTab = false): void {
  if (inTab) vscode.postMessage({ type: "openInEditor", id: row.id });
  else if (row.open) vscode.postMessage({ type: "switchSession", id: row.id });
  else vscode.postMessage({ type: "openConversation", id: row.id });
  togglePanel(false);
}

function closeRowMenu(): void {
  rowMenu.hidden = true;
  for (const node of chatList.querySelectorAll(".chat-more[aria-expanded]")) node.removeAttribute("aria-expanded");
  startMenu.hidden = true;
  $("panelMore").setAttribute("aria-expanded", "false");
}

function menuItem(name: string, label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = element("button", `menu-item${className ? ` ${className}` : ""}`);
  node.type = "button";
  node.setAttribute("role", "menuitem");
  node.append(iconNode(name), element("span", "menu-label", label));
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    closeRowMenu();
    onClick();
  });
  return node;
}

function showRowMenu(row: ChatRow, anchor: HTMLElement, at?: { x: number; y: number }): void {
  const wasOpen = !rowMenu.hidden && rowMenu.dataset.id === row.id;
  closeRowMenu();
  if (wasOpen) return;
  const items: HTMLButtonElement[] = [];
  items.push(
    menuItem("pin", row.pinned ? "Unpin" : "Pin to top", () =>
      vscode.postMessage({ type: "pinChat", id: row.id, pinned: !row.pinned }),
    ),
  );
  if (row.open) items.push(menuItem("edit", "Rename", () => vscode.postMessage({ type: "renameChat", id: row.id })));
  items.push(
    menuItem("split", "Open in a new tab", () => {
      vscode.postMessage({ type: "openInEditor", id: row.id });
      togglePanel(false);
    }),
  );
  items.push(menuItem("export", "Export as Markdown", () => vscode.postMessage({ type: "exportChat", id: row.id })));
  const remove = menuItem("trash", "Delete", () => deleteChat(row), "danger");
  if (row.running) {
    remove.disabled = true;
    remove.title = "Stop this chat before you delete it.";
  }
  items.push(remove);
  rowMenu.replaceChildren(...items);
  rowMenu.dataset.id = row.id;
  rowMenu.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  const height = rowMenu.offsetHeight;
  const width = rowMenu.offsetWidth;
  if (at) {
    rowMenu.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - height - 4))}px`;
    rowMenu.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - width - 4))}px`;
  } else {
    const box = anchor.getBoundingClientRect();
    const below = box.bottom + 4 + height <= window.innerHeight;
    rowMenu.style.top = `${below ? box.bottom + 4 : Math.max(4, box.top - height - 4)}px`;
    rowMenu.style.left = `${Math.max(4, box.right - width)}px`;
  }
  items[0]?.focus();
}

function finishDelete(id: string): void {
  const timer = pendingDeletes.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingDeletes.delete(id);
  vscode.postMessage({ type: "deleteConversation", id });
}

function deleteChat(row: ChatRow): void {
  for (const id of [...pendingDeletes.keys()]) finishDelete(id);
  pendingDeletes.set(
    row.id,
    setTimeout(() => finishDelete(row.id), 6000),
  );
  $("undoText").textContent = `Deleted “${row.title}”`;
  $("undoButton").onclick = () => {
    const timer = pendingDeletes.get(row.id);
    if (timer !== undefined) clearTimeout(timer);
    pendingDeletes.delete(row.id);
    hideUndo();
    renderPanel();
  };
  const toast = $("undoToast");
  toast.hidden = false;
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 6000);
  renderPanel();
  if (!panel.hidden) $<HTMLInputElement>("historySearch").focus();
}

function hideUndo(): void {
  $("undoToast").hidden = true;
}

function relativeTime(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function togglePanel(show: boolean = panel.hidden !== false): void {
  panel.hidden = !show;
  closeRowMenu();
  $("historyButton").classList.toggle("pressed", show);
  if (show) {
    const search = $<HTMLInputElement>("historySearch");
    search.value = "";
    selectedRow = 0;
    renderPanel();
    vscode.postMessage({ type: "listSessions" });
    search.focus();
  } else if (document.activeElement && panel.contains(document.activeElement)) {
    prompt.focus();
  }
}

// Messages from the extension

const signsOfLife = new Set<HostMessage["type"]>([
  "assistantStart",
  "assistantDelta",
  "assistantEnd",
  "reasoningDelta",
  "reasoningEnd",
  "tool",
  "toolOutput",
  "subagent",
  "approval",
  "approvalResolved",
  "notice",
]);

function handle(message: HostMessage): void {
  if (signsOfLife.has(message.type)) lastSignAt = Date.now();
  switch (message.type) {
    case "state":
      applyState(message.state);
      break;
    case "user":
      addUser(message);
      break;
    case "assistantStart":
      assistantEntry(message.id, message.variant);
      break;
    case "assistantDelta":
      renderAssistant(message.id, (assistants.get(message.id)?.text ?? "") + message.text, false);
      break;
    case "assistantEnd":
      renderAssistant(message.id, message.text, true, message.at, message.variant);
      break;
    case "assistantDiscard": {
      // Retry: the unfinished answer or thinking of the stopped request goes away.
      assistants.get(message.id)?.element.remove();
      assistants.delete(message.id);
      thoughts.get(message.id)?.element.remove();
      thoughts.delete(message.id);
      lastSignAt = Date.now();
      break;
    }
    case "reasoningDelta":
      if (state?.showThinking !== false) renderThought(message.id, message.text, false);
      break;
    case "reasoningEnd":
      if (state?.showThinking !== false && message.text) renderThought(message.id, "", true, message.text);
      break;
    case "tool":
      updateTool(message);
      break;
    case "subagent": {
      let card = transcript.querySelector<HTMLDetailsElement>(`details.subagent[data-id="${CSS.escape(message.id)}"]`);
      if (!card) {
        card = element("details", "subagent");
        append(card);
      } else keepFollowing();
      renderSubagent(card, message, markdown);
      break;
    }
    case "toolOutput": {
      if (message.where)
        setCommandWhere(message.id, message.where, { approval: message.approval, terminal: message.terminal });
      keepFollowing();
      appendCommandOutput(message.id, message.text);
      break;
    }
    case "approval":
      addApproval(message);
      break;
    case "approvalResolved":
      resolveApproval(message.id, message.decision);
      break;
    case "verify": {
      const node = element("details", `verify ${message.passed ? "passed" : "failed"}`);
      const summary = element(
        "summary",
        undefined,
        message.passed
          ? "✓ Checks pass"
          : `✕ Checks fail (attempt ${message.attempt}). ${state?.assistant.name ?? "Phew"} keeps fixing…`,
      );
      summary.append(time(message.at));
      node.append(summary, element("pre", "detail", message.output));
      append(node);
      break;
    }
    case "taskEnd":
      moveMascot(message.status === "done" ? "done" : message.status === "aborted" ? "idle" : "failed", 2600);
      if (message.status !== "done" && message.message && !cardThisTask)
        append(element("p", "notice warning", message.message));
      if (message.verified && !cardThisTask) append(element("p", "notice success", "Phew! All checks pass."));
      cardThisTask = false;
      if (message.celebrate && state?.celebrate !== false) celebrate();
      break;
    case "notice": {
      const node = element("p", `notice ${message.level}`, message.text);
      linkify(node);
      append(node);
      break;
    }
    case "checkpointRestored":
      append(element("p", "notice info", `Restored ${message.files.length} files: ${message.files.join(", ")}`));
      break;
    case "cleared":
      clearTranscript();
      break;
    case "plan":
      renderPlan(message.plan);
      break;
    case "queue":
      renderQueue(message.items);
      break;
    case "sound":
      playSound(message.style, message.event);
      break;
    case "achievement":
      showAchievementToast(message.achievement, () => vscode.postMessage({ type: "showWrapped", period: "week" }));
      break;
    case "wrapped":
      showWrapped(
        message.wrapped,
        message.achievements,
        message.name,
        state?.appearance.accentColor || "#22b8cf",
        (next) => vscode.postMessage(next),
      );
      break;
    case "handoff": {
      const node = element("p", "notice handoff-note");
      node.append(element("span", undefined, message.manual ? "Handoff note saved: " : "Handoff note updated: "));
      const link = element("button", "link", message.path);
      link.type = "button";
      link.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: message.path }));
      node.append(link);
      append(node);
      break;
    }
    case "summary":
      addSummary(message);
      break;
    case "suggestions":
      renderSuggestions(message.items);
      break;
    case "showAppearance":
      togglePopover("appearance");
      break;
    case "showOnboarding":
      showAssistantCard(state?.assistant, false, (next) => vscode.postMessage(next));
      break;
    case "sessions":
      sessions = [...message.sessions];
      history = [...message.history];
      if (!panel.hidden) renderPanel();
      break;
    case "ratingAsk":
      addRatingCard(message.store);
      break;
    case "historyMatches":
      contentMatches = {
        query: message.query,
        snippets: new Map(message.matches.map((match) => [match.id, match.snippet])),
      };
      if (!panel.hidden && $<HTMLInputElement>("historySearch").value.trim() === message.query) renderPanel();
      break;
    case "setupOptions":
      setupCard.receive(message.options);
      $("setup").hidden = true;
      break;
    case "contextOptions":
      attachMenu.setOptions(message.options);
      break;
    case "addAttachment":
      addAttachment(message.attachment, message.label);
      prompt.focus();
      break;
    case "mentions":
      if (currentMention() === message.query) showMentions([...message.items]);
      break;
    case "openPanel":
      togglePanel(true);
      break;
    case "focusInput":
      if (message.text && (message.replace || !prompt.value)) prompt.value = message.text;
      prompt.focus();
      break;
  }
}

// Input

/** The send button shows what Enter will do: nothing yet, send, or add to the queue. */
function updateSendButton(): void {
  const empty = !prompt.value.trim() && attachments.length === 0;
  const busy = state?.busy ?? false;
  const key =
    state?.sendWith === "ctrlEnter" ? (navigator.platform.toLowerCase().includes("mac") ? "⌘↩" : "Ctrl+↩") : "↩";
  const queue = busy && !empty;
  // While the agent works and nothing is typed, only Stop shows.
  sendButton.hidden = busy && empty;
  sendButton.classList.toggle("empty", empty);
  sendButton.classList.toggle("queue", queue);
  sendButton.setAttribute("aria-disabled", String(empty));
  const label = empty ? "Type a message to send" : queue ? `Add to the queue (${key})` : `Send (${key})`;
  sendButton.title = label;
  sendButton.setAttribute("aria-label", label);
  // Ready to send: the symbol of the assistant's look; on hover it turns into the arrow, so the meaning stays clear.
  const look = lookOf(state?.assistant.avatar ?? "") ?? (state?.assistant.avatar ? undefined : "drop");
  const wanted = queue ? "queue" : empty || !look ? "send" : `send-${look}`;
  sendButton.dataset.look = !queue && !empty && look ? look : "";
  if (sendButton.dataset.icon !== wanted) {
    sendButton.dataset.icon = wanted;
    if (wanted.startsWith("send-")) {
      const glyph = element("span", "send-glyph");
      glyph.append(iconNode(wanted));
      const arrow = element("span", "send-arrow");
      arrow.append(iconNode("send"));
      sendButton.replaceChildren(glyph, arrow);
    } else sendButton.replaceChildren(iconNode(wanted));
  }
}

function sendNow(interrupt: boolean): void {
  const text = prompt.value.trim();
  if (!text && attachments.length === 0) return;
  sendButton.classList.remove("launch");
  void sendButton.getBoundingClientRect();
  sendButton.classList.add("launch");
  vscode.postMessage({
    type: "send",
    text,
    attachments: attachments.map((item) => item.attachment),
    ...(interrupt ? { interrupt: true } : {}),
  });
  if (text) {
    saved.promptHistory = [...saved.promptHistory.filter((item) => item !== text), text].slice(-100);
    vscode.setState(saved);
  }
  historyPosition = -1;
  prompt.value = "";
  attachments = [];
  renderChips();
  showMentions([]);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendNow(false);
});

prompt.addEventListener("keydown", (event) => {
  if (!mentionsBox.hidden && mentionItems.length > 0) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      mentionIndex = (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + mentionItems.length) % mentionItems.length;
      renderMentions();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      chooseMention(mentionIndex);
      return;
    }
    if (event.key === "Escape") {
      showMentions([]);
      return;
    }
  }
  // Shift+Tab switches the mode, like in terminal agents.
  if (event.key === "Tab" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    if (modeMenu.cycle(1)) event.preventDefault();
    return;
  }
  const atStart = prompt.selectionStart === 0 && prompt.selectionEnd === 0;
  const atEnd = prompt.selectionStart === prompt.value.length;
  if (
    event.key === "ArrowUp" &&
    (prompt.value === "" || (atStart && historyPosition >= 0)) &&
    saved.promptHistory.length > 0
  ) {
    event.preventDefault();
    historyPosition = historyPosition < 0 ? saved.promptHistory.length - 1 : Math.max(0, historyPosition - 1);
    prompt.value = saved.promptHistory[historyPosition];
    return;
  }
  if (event.key === "ArrowDown" && historyPosition >= 0 && atEnd) {
    event.preventDefault();
    historyPosition++;
    if (historyPosition >= saved.promptHistory.length) {
      historyPosition = -1;
      prompt.value = "";
    } else prompt.value = saved.promptHistory[historyPosition];
    return;
  }
  if (event.key === "Escape" && state?.busy && prompt.value === "") {
    event.preventDefault();
    vscode.postMessage({ type: "stop" });
    return;
  }
  if (event.key !== "Enter" || event.isComposing) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (state?.busy && modifier) {
    // Stop the current step and send this message at once.
    event.preventDefault();
    sendNow(true);
    return;
  }
  const sendOnEnter = state?.sendWith !== "ctrlEnter";
  if ((sendOnEnter && !event.shiftKey && !modifier) || (!sendOnEnter && modifier)) {
    event.preventDefault();
    form.requestSubmit();
  }
});

let mentionTimer: ReturnType<typeof setTimeout> | undefined;
// The value also changes from code (history, Edit and send again), so these events refresh the button too.
prompt.addEventListener("keyup", updateSendButton);
prompt.addEventListener("focus", updateSendButton);
prompt.addEventListener("input", () => {
  updateSendButton();
  mascotSeesTyping();
  historyPosition = -1;
  if (slashMenu()) return;
  const query = currentMention();
  if (query === undefined) {
    showMentions([]);
    return;
  }
  if (mentionTimer) clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => vscode.postMessage({ type: "mentionQuery", query }), 80);
});
prompt.addEventListener("blur", () => setTimeout(() => showMentions([]), 150));

prompt.addEventListener("paste", (event) => {
  // A long text becomes a chip, so the input stays readable; a click on the chip shows and edits it.
  const pasted = event.clipboardData?.getData("text/plain") ?? "";
  if (pasted && isLongPaste(pasted) && !(event.clipboardData?.types ?? []).includes("Files")) {
    event.preventDefault();
    addAttachment({ kind: "text", name: "Pasted text", text: pasted }, pastedLabel(pasted));
    return;
  }
  for (const item of event.clipboardData?.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        readImage(file);
      }
    }
  }
});

// While files are dragged over the chat, the whole view shows where they go.
let dragDepth = 0;
const carriesFiles = (event: DragEvent) =>
  [...(event.dataTransfer?.types ?? [])].some((type) => type === "Files" || type === "text/uri-list");
document.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  dragDepth++;
  document.body.classList.add("dragging-files");
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("dragging-files");
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging-files");
  const data = event.dataTransfer;
  if (!data) return;
  for (const file of data.files) readImage(file);
  const uris = data.getData("text/uri-list") || data.getData("text/plain");
  for (const line of uris.split(/\r?\n/)) {
    const match = /^file:\/\/(.+)$/.exec(line.trim());
    if (match)
      addAttachment(
        { kind: "file", path: decodeURIComponent(match[1]) },
        decodeURIComponent(match[1]).split("/").pop() ?? "file",
      );
  }
});

function closePopovers(except?: HTMLElement): void {
  for (const popover of document.querySelectorAll<HTMLElement>(".popover"))
    if (popover !== except) popover.hidden = true;
  if (except?.id !== "modeMenu") $("mode").setAttribute("aria-expanded", "false");
  if (except?.id !== "attachMenu") $("attachButton").setAttribute("aria-expanded", "false");
  if (except?.id !== "modelMenu") modelButton.setAttribute("aria-expanded", "false");
  if (except?.id !== "approvals") $("approvalsButton").setAttribute("aria-expanded", "false");
}

const attachMenu = createAttachMenu({
  button: $<HTMLButtonElement>("attachButton"),
  menu: $("attachMenu"),
  post: (message) => vscode.postMessage(message),
  closeOthers: closePopovers,
  has: (attachment) => attachments.some((item) => JSON.stringify(item.attachment) === JSON.stringify(attachment)),
  add: (attachment, label) => addAttachment(attachment, label),
  remove: (attachment) => removeAttachment(attachment),
  mention: startMention,
  pickImage: () => imageInput.click(),
});

setCopyFallback((message) => vscode.postMessage(message));

const approvalsPanel = createApprovalsPanel({
  button: $<HTMLButtonElement>("approvalsButton"),
  panel: $("approvals"),
  dot: $("approvalDot"),
  post: (message) => vscode.postMessage(message),
});

createChatFind(transcript, $("findBar"));
const setupCard = createSetupCard($("setupCard"), (message) => vscode.postMessage(message));
const terminalsPanel = createTerminalsPanel({
  button: $<HTMLButtonElement>("terminalsButton"),
  panel: $("terminalsPanel"),
  post: (message) => vscode.postMessage(message),
  closeOthers: closePopovers,
});

const modelMenu = createModelMenu({
  button: modelButton,
  menu: $("modelMenu"),
  post: (message) => vscode.postMessage(message),
  closeOthers: closePopovers,
});

const modeMenu = createModeMenu({
  button: $<HTMLButtonElement>("mode"),
  menu: $("modeMenu"),
  composer: form,
  post: (message) => vscode.postMessage(message),
  closeOthers: closePopovers,
});

function togglePopover(id: string): void {
  const popover = $(id);
  closePopovers(popover);
  popover.hidden = !popover.hidden;
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  // The path still holds nodes that a re-render removed during the click.
  const inside = event
    .composedPath()
    .some(
      (node) =>
        node instanceof Element &&
        node.matches(
          ".popover, .chip-open, #attachButton, #approvalsButton, #appearanceButton, #mode, #model, #terminalsButton",
        ),
    );
  if (!inside && !target.closest(".popover")) closePopovers();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // Focus goes back to the button that opened the menu, so keyboard users keep their place.
  const open = [...document.querySelectorAll<HTMLElement>(".popover")].find(
    (popover) => !popover.hidden && popover.contains(document.activeElement),
  );
  closePopovers();
  if (open) document.querySelector<HTMLElement>(`[aria-controls="${open.id}"]`)?.focus();
});
$("attachButton").addEventListener("click", () => attachMenu.toggle());
$("appearanceButton").addEventListener("click", () => togglePopover("appearance"));
const swatches = $("swatches");
for (const preset of [{ name: "Theme", color: "" }, ...accentPresets]) {
  const swatch = element("button", "swatch");
  swatch.type = "button";
  swatch.setAttribute("role", "radio");
  swatch.title = preset.color ? preset.name : "The accent color of your theme";
  swatch.setAttribute("aria-label", preset.color ? preset.name : "Theme color");
  swatch.dataset.color = preset.color.toLowerCase();
  if (preset.color) swatch.style.setProperty("--swatch", preset.color);
  else swatch.classList.add("theme");
  swatch.addEventListener("click", () =>
    vscode.postMessage({ type: "setAppearance", key: "accentColor", value: preset.color }),
  );
  swatches.append(swatch);
}
{
  // Your own color: the system color picker behind a "+" swatch.
  const custom = element("label", "swatch custom");
  custom.id = "customSwatch";
  custom.title = "Your own color";
  custom.setAttribute("role", "radio");
  custom.setAttribute("aria-label", "Your own color");
  const picker = element("input");
  picker.type = "color";
  picker.tabIndex = 0;
  picker.addEventListener("change", () =>
    vscode.postMessage({ type: "setAppearance", key: "accentColor", value: picker.value }),
  );
  custom.addEventListener("click", () => {
    const value = state?.appearance.accentColor ?? "";
    if (/^#[0-9a-f]{6}$/i.test(value)) picker.value = value;
  });
  custom.append(picker);
  swatches.append(custom);
}
for (const [id, key] of [
  ["timestampChoice", "timestamps"],
  ["clockChoice", "clock"],
  ["mascotChoice", "mascot"],
] as const) {
  for (const option of document.querySelectorAll<HTMLButtonElement>(`#${id} button`)) {
    option.addEventListener("click", () =>
      vscode.postMessage({ type: "setAppearance", key, value: option.dataset.value ?? "" }),
    );
  }
}
$("fontReset").addEventListener("click", () =>
  vscode.postMessage({ type: "setAppearance", key: "fontSize", value: null }),
);
$("resetAppearance").addEventListener("click", () => vscode.postMessage({ type: "resetAppearance" }));
for (const option of document.querySelectorAll<HTMLButtonElement>("#styleChoice button")) {
  option.addEventListener("click", () =>
    vscode.postMessage({ type: "setAppearance", key: "style", value: option.dataset.style ?? "bubbles" }),
  );
}
const changeFont = (delta: number) => {
  const next = Math.min(24, Math.max(10, Math.round(currentFontSize()) + delta));
  vscode.postMessage({ type: "setAppearance", key: "fontSize", value: next });
};
$("fontDown").addEventListener("click", () => changeFont(-1));
$("fontUp").addEventListener("click", () => changeFont(1));
$("editAssistant").addEventListener("click", () => {
  closePopovers();
  showAssistantCard(state?.assistant, false, (message) => vscode.postMessage(message));
});
$("openWrapped").addEventListener("click", () => {
  closePopovers();
  vscode.postMessage({ type: "showWrapped", period: "week" });
});
$("headerAvatar").addEventListener("click", () =>
  showAssistantCard(state?.assistant, false, (message) => vscode.postMessage(message)),
);
$("moreAppearance").addEventListener("click", () => {
  closePopovers();
  vscode.postMessage({ type: "openSettings" });
});
$("approvalsButton").addEventListener("click", () => {
  togglePopover("approvals");
  const open = !$("approvals").hidden;
  $("approvalsButton").setAttribute("aria-expanded", String(open));
  if (open) $("approvals").querySelector<HTMLElement>(".approval-level.active, .approval-level[tabindex='0']")?.focus();
});
function startMention(): void {
  const position = prompt.selectionStart;
  const before = prompt.value.slice(0, position);
  const insert = before === "" || /\s$/.test(before) ? "@" : " @";
  prompt.value = `${before}${insert}${prompt.value.slice(position)}`;
  prompt.selectionStart = prompt.selectionEnd = position + insert.length;
  prompt.focus();
  prompt.dispatchEvent(new Event("input"));
}
imageInput.addEventListener("change", () => {
  for (const file of imageInput.files ?? []) readImage(file);
  imageInput.value = "";
});

stopButton.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
$("newChat").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
$("renameButton").addEventListener("click", () => vscode.postMessage({ type: "renameChat" }));
$("titleText").addEventListener("dblclick", (event) => {
  event.stopPropagation();
  vscode.postMessage({ type: "renameChat" });
});
$("popOut").addEventListener("click", () => vscode.postMessage({ type: "openInEditor" }));
$("panelNew").addEventListener("click", () => {
  vscode.postMessage({ type: "newChat" });
  togglePanel(false);
});
$("panelMore").addEventListener("click", (event) => {
  event.stopPropagation();
  const show = startMenu.hidden;
  closeRowMenu();
  startMenu.hidden = !show;
  $("panelMore").setAttribute("aria-expanded", String(show));
  if (show) $("panelParallel").focus();
});
$("panelParallel").addEventListener("click", () => {
  vscode.postMessage({ type: "openInEditor" });
  togglePanel(false);
});
$("panelWorktree").addEventListener("click", () => {
  vscode.postMessage({ type: "newWorktreeAgent" });
  togglePanel(false);
});
$("historyButton").addEventListener("click", (event) => {
  event.stopPropagation();
  togglePanel();
});
$("title").addEventListener("click", (event) => {
  event.stopPropagation();
  togglePanel();
});
$("historySearch").addEventListener("input", () => {
  selectedRow = 0;
  closeRowMenu();
  renderPanel();
  searchHistoryContent($<HTMLInputElement>("historySearch").value.trim());
});
$("historySearch").addEventListener("keydown", (event) => {
  const row = visibleRows[selectedRow];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (visibleRows.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    selectRow((selectedRow + step + visibleRows.length) % visibleRows.length);
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (row) {
      if (selectedRow > 0 || $<HTMLInputElement>("historySearch").value) {
        saved.chatKeysUsed++;
        vscode.setState(saved);
      }
      openRow(row, event.metaKey || event.ctrlKey);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!rowMenu.hidden || !startMenu.hidden) closeRowMenu();
    else if ($<HTMLInputElement>("historySearch").value) {
      $<HTMLInputElement>("historySearch").value = "";
      renderPanel();
    } else togglePanel(false);
  } else if (event.key === "Delete" && event.shiftKey && row && !row.running) {
    event.preventDefault();
    deleteChat(row);
  }
});
panel.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  if (!startMenu.hidden) {
    closeRowMenu();
    $("panelMore").focus();
  } else togglePanel(false);
});
rowMenu.addEventListener("keydown", (event) => {
  const items = [...rowMenu.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    closeRowMenu();
    $<HTMLInputElement>("historySearch").focus();
  }
});
document.addEventListener("mousedown", (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest("#rowMenu, .chat-more, #startMenu, #panelMore")) closeRowMenu();
  if (!panel.hidden && !target.closest("#panel, #rowMenu, #undoToast, #historyButton, #title")) togglePanel(false);
});
$("setup").addEventListener("click", () => vscode.postMessage({ type: "configureModel" }));
$("pasteCancel").addEventListener("click", closePaste);
$("pasteSave").addEventListener("click", () => {
  const item = attachments[pasteIndex];
  const text = $<HTMLTextAreaElement>("pasteText").value;
  if (item?.attachment.kind === "text") {
    if (text.trim()) attachments[pasteIndex] = { attachment: { ...item.attachment, text }, label: pastedLabel(text) };
    else attachments.splice(pasteIndex, 1);
    renderChips();
  }
  closePaste();
});
$("pasteInline").addEventListener("click", () => {
  const item = attachments[pasteIndex];
  if (item?.attachment.kind === "text") {
    const text = $<HTMLTextAreaElement>("pasteText").value;
    attachments.splice(pasteIndex, 1);
    renderChips();
    prompt.value = prompt.value ? `${prompt.value}\n${text}` : text;
    prompt.dispatchEvent(new Event("input"));
  }
  closePaste();
});
$("pasteText").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePaste();
  }
});
$("stallRetry").addEventListener("click", () => {
  lastSignAt = Date.now();
  renderStatus();
  vscode.postMessage({ type: "retryRequest" });
});
$("guide").addEventListener("click", () => vscode.postMessage({ type: "openWalkthrough" }));
$("reviewNext").addEventListener("click", () => vscode.postMessage({ type: "reviewNext" }));
$("reviewKeepAll").addEventListener("click", () => vscode.postMessage({ type: "reviewAll", action: "keep" }));
$("reviewUndoAll").addEventListener("click", () => vscode.postMessage({ type: "reviewAll", action: "undo" }));
$("reviewToggle").addEventListener("click", () => {
  const list = $("reviewList");
  list.hidden = !list.hidden;
  $("reviewToggle").setAttribute("aria-expanded", String(!list.hidden));
  $("reviewBanner").classList.toggle("open", !list.hidden);
});
$("context").addEventListener("click", () => {
  if (Number.parseInt($("contextLabel").textContent ?? "0", 10) >= 50 && !state?.busy)
    vscode.postMessage({ type: "compact" });
});
$("planToggle").addEventListener("click", () => {
  saved.planOpen = !saved.planOpen;
  vscode.setState(saved);
  $("planItems").hidden = !saved.planOpen;
  $("planToggle").setAttribute("aria-expanded", String(saved.planOpen));
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => handle(event.data));
startMascotLife();
vscode.postMessage({ type: "ready" });

transcript.addEventListener("scroll", () => {
  if (nearBottom()) jump.hidden = true;
});
jump.addEventListener("click", () => {
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  jump.hidden = true;
});

window.addEventListener("focus", requestSuggestions);
