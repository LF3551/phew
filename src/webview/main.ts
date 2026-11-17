import { accentPresets } from "../core/appearance";
import type { Attachment } from "../core/attachments";
import { icon } from "../shared/icons";
import type {
  HistoryItem,
  HostMessage,
  MentionItem,
  PlanView,
  QueuedView,
  SessionSummary,
  ViewState,
  WebviewMessage,
} from "../shared/protocol";
import { renderMarkdown } from "./markdown";
import {
  avatar,
  type MascotState,
  playSound,
  setMascotState,
  showAchievementToast,
  showAssistantCard,
  showWrapped,
} from "./persona";

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
const modeSelect = $<HTMLSelectElement>("mode");
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
let mentionItems: MentionItem[] = [];
let mentionIndex = 0;
let mentionStart = -1;
let sessions: SessionSummary[] = [];
let history: HistoryItem[] = [];

interface Saved {
  promptHistory: string[];
  planOpen: boolean;
}
const saved: Saved = {
  promptHistory: [],
  planOpen: true,
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

function time(at: number | undefined): HTMLElement {
  const node = element("time", "time");
  if (!at) return node;
  const date = new Date(at);
  node.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  node.title = date.toLocaleString();
  node.dateTime = date.toISOString();
  return node;
}

function nearBottom(): boolean {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
}

function append(node: HTMLElement): void {
  welcome.hidden = true;
  const atBottom = nearBottom();
  transcript.append(node);
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
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

function copyButton(text: () => string, label = "Copy", className = "copy"): HTMLButtonElement {
  const copy = button(label, className, () => {
    void navigator.clipboard.writeText(text()).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = label;
      }, 1200);
    });
  });
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
  if (mascotTimer) clearTimeout(mascotTimer);
  mascotTimer = undefined;
  if (settleAfter)
    mascotTimer = setTimeout(() => {
      if (!state?.busy) moveMascot("idle");
    }, settleAfter);
}

/** Shows the name and the avatar of the assistant in the header and on the welcome screen. */
function applyAssistant(next: ViewState): void {
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
    $("welcomeName").textContent = next.assistant.name;
    $("welcomeTagline").textContent = next.assistant.userName
      ? `Hi, ${next.assistant.userName}! Bug fixed. Phew.`
      : "Bug fixed. Phew.";
    for (const node of document.querySelectorAll(".message.assistant > .message-header > .avatar"))
      node.replaceWith(avatar(next.assistant, "avatar"));
    for (const node of document.querySelectorAll(".message.assistant:not(.btw) > .message-header > .who"))
      node.textContent = next.assistant.name;
  }
  if (next.busy && mascotState !== "working") moveMascot("working");
  if (!next.busy && mascotState === "working") moveMascot("idle");
  if (next.onboarding && !introduced && next.configured) {
    introduced = true;
    showAssistantCard(next.assistant, true, (message) => vscode.postMessage(message));
  }
}

function applyState(next: ViewState): void {
  state = next;
  applyAssistant(next);
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

  if (
    modeSelect.options.length !== next.modes.length ||
    [...modeSelect.options].some((option, index) => option.value !== next.modes[index]?.id)
  ) {
    modeSelect.replaceChildren(
      ...next.modes.map((mode) => {
        const option = element("option", undefined, mode.name);
        option.value = mode.id;
        option.title = mode.description;
        return option;
      }),
    );
  }
  modeSelect.value = next.mode;
  modeSelect.title = next.modes.find((mode) => mode.id === next.mode)?.description ?? "Mode";
  modeSelect.disabled = next.busy;

  modelButton.textContent = next.configured ? next.model : "Connect a model";
  modelButton.title = next.configured ? `${next.model} (${next.provider}). Click to switch.` : "Add a model";
  $("setup").hidden = next.configured;
  sendButton.classList.toggle("queue", next.busy);
  sendButton.title = next.busy ? "Queue: the message reaches the agent at its next step" : "Send";
  stopButton.hidden = !next.busy;
  const send = next.sendWith === "ctrlEnter" ? "Ctrl+Enter" : "Enter";
  const modifier = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
  prompt.placeholder = next.busy
    ? `Enter to queue · ${modifier}+Enter to stop and send · Esc to stop`
    : `Ask ${next.assistant.name} or describe a change · @ to attach · ${send} to send`;
  $<HTMLSelectElement>("approvalReview").value = next.approvals.review;
  $<HTMLSelectElement>("approvalCommands").value = next.approvals.commands;
  $<HTMLSelectElement>("approvalMcp").value = String(next.approvals.mcp);
  $("saveApprovals").hidden = !next.approvals.custom;
  $("approvalDot").hidden = !next.approvals.custom;
  $("approvalsButton").hidden = !next.trusted;
  $("restricted").hidden = next.trusted;

  const context = $("context");
  const percent = Math.round(next.context * 100);
  context.hidden = percent <= 0;
  context.dataset.level = percent >= 85 ? "high" : percent >= 60 ? "medium" : "low";
  context.style.setProperty("--fill", `${percent * 3.6}deg`);
  $("contextLabel").textContent = `${percent}%`;
  context.title = `${next.contextLabel}${percent >= 50 && !next.busy ? ". Click to compact the chat." : ""}${next.tokens !== "0" ? `\nThis chat: ${next.tokens} tokens${next.cost ? `, ${next.cost}` : ""}` : ""}`;
  const banner = $("reviewBanner");
  banner.hidden = next.reviewFiles === 0;
  $("reviewText").textContent =
    `${next.reviewFiles} ${next.reviewFiles === 1 ? "file has" : "files have"} changes to keep or undo.`;
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
  const set = (name: string, value: string | undefined) =>
    value ? body.style.setProperty(name, value) : body.style.removeProperty(name);
  set("--phew-font-size", next.fontSize ? `${next.fontSize}px` : undefined);
  set("--phew-accent", look.accentColor || undefined);
  set("--phew-user-bg", look.userBubbleColor || undefined);
  set("--phew-font-family", look.fontFamily || undefined);
  set("--phew-line-height", look.lineHeight ? String(look.lineHeight) : undefined);
  set("--phew-code-size", look.codeFontSize ? `${look.codeFontSize}px` : undefined);
  for (const option of document.querySelectorAll<HTMLButtonElement>("#styleChoice button")) {
    option.classList.toggle("active", option.dataset.style === look.style);
  }
  for (const swatch of document.querySelectorAll<HTMLButtonElement>("#swatches button")) {
    swatch.classList.toggle("active", (swatch.dataset.color ?? "") === look.accentColor);
  }
  $("fontValue").textContent = next.fontSize ? `${next.fontSize}px` : "Default";
  $<HTMLSelectElement>("timestampChoice").value = look.timestamps;
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
      iconButton("edit", "Edit and send again", () => {
        prompt.value = message.text;
        prompt.focus();
      }),
    );
  }
  actions.append(
    iconButton("copy", "Copy", () => void navigator.clipboard.writeText(message.text)),
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
  const follow = nearBottom();
  if (done) {
    entry.element.classList.remove("streaming");
    if (text.trim() === "") {
      entry.element.remove();
      return;
    }
    entry.body.replaceChildren(markdown(text));
    const header = entry.element.querySelector(".message-header");
    const done = entry;
    header?.append(
      time(at),
      iconButton("copy", "Copy answer", () => void navigator.clipboard.writeText(done.text)),
    );
  } else entry.body.textContent = text;
  if (follow) transcript.scrollTop = transcript.scrollHeight;
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
  entry.text = full ?? entry.text + delta;
  entry.body.textContent = entry.text;
  if (done) {
    const seconds = Math.max(1, Math.round((Date.now() - entry.started) / 1000));
    const summary = entry.element.querySelector("summary");
    if (summary) summary.textContent = full !== undefined && !delta ? "Thought" : `Thought for ${seconds} s`;
    entry.element.open = false;
  }
  if (nearBottom()) transcript.scrollTop = transcript.scrollHeight;
}

function updateTool(message: Extract<HostMessage, { type: "tool" }>): void {
  let node = tools.get(message.id);
  if (!node) {
    node = element("details", "tool");
    tools.set(message.id, node);
    append(node);
  }
  node.dataset.status = message.status;
  const summary = element("summary");
  const icon = message.status === "running" ? "⋯" : message.status === "error" ? "✕" : "✓";
  summary.append(element("span", "icon", icon), element("span", "label", message.summary), time(message.at));
  node.replaceChildren(summary);
  if (message.detail) node.append(element("pre", "detail", message.detail));
}

function addApproval(message: Extract<HostMessage, { type: "approval" }>): void {
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
  } else card.append(element("pre", "command", message.detail));

  if (message.kind === "edit")
    actions.append(button("Open diff", "secondary", () => vscode.postMessage({ type: "openDiff", id: message.id })));
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
  const card = approvals.get(id);
  if (!card) return;
  approvals.delete(id);
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
  $("planTitle").textContent = plan.goal ? `🎯 ${plan.goal}` : "Plan";
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
      chip.append(element("span", "chip-label", item.label));
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
}

function addAttachment(attachment: Attachment, label: string): void {
  if (attachments.length >= 20) return;
  const key = JSON.stringify(attachment);
  if (attachments.some((item) => JSON.stringify(item.attachment) === key)) return;
  attachments.push({ attachment, label });
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

function showMentions(items: MentionItem[]): void {
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
  const end = prompt.selectionStart;
  prompt.value = `${prompt.value.slice(0, mentionStart)}${prompt.value.slice(end)}`;
  prompt.selectionStart = prompt.selectionEnd = mentionStart;
  addAttachment(item.attachment, item.detail && item.attachment.kind === "file" ? item.detail : item.label);
  showMentions([]);
  prompt.focus();
}

// Sessions panel

function renderPanel(): void {
  const query = $<HTMLInputElement>("historySearch").value.toLowerCase();
  $("openList").replaceChildren(
    ...sessions.map((session) => {
      const row = element("li", `item${session.active ? " active" : ""}`);
      const label = element("button", "item-title", session.title);
      label.type = "button";
      label.addEventListener("click", () => {
        vscode.postMessage({ type: "switchSession", id: session.id });
        panel.hidden = true;
      });
      row.append(label);
      if (session.worktree) row.append(element("span", "badge", `⑂ ${session.worktree}`));
      if (session.needsApproval) row.append(element("span", "badge warn", "needs input"));
      else if (session.running) row.append(element("span", "badge", "running"));
      row.append(
        button("✎", "remove", () => vscode.postMessage({ type: "renameChat", id: session.id }), "Rename"),
        button(
          "⧉",
          "remove",
          () => vscode.postMessage({ type: "openInEditor", id: session.id }),
          "Open in an editor tab",
        ),
      );
      return row;
    }),
  );
  const items = history.filter((item) => item.title.toLowerCase().includes(query));
  $("historyList").replaceChildren(
    ...(items.length === 0
      ? [element("li", "empty", query ? "No chats match." : "No saved chats yet.")]
      : items.map((item) => {
          const row = element("li", "item");
          const label = element("button", "item-title", item.title);
          label.type = "button";
          label.title = new Date(item.updatedAt).toLocaleString();
          label.addEventListener("click", () => {
            vscode.postMessage({ type: "openConversation", id: item.id });
            panel.hidden = true;
          });
          row.append(label, element("span", "when", relativeTime(item.updatedAt)));
          if (item.worktree) row.append(element("span", "badge", `⑂ ${item.worktree}`));
          row.append(
            button("×", "remove", () => vscode.postMessage({ type: "deleteConversation", id: item.id }), "Delete"),
          );
          return row;
        })),
  );
}

function relativeTime(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function togglePanel(show = panel.hidden): void {
  panel.hidden = !show;
  if (show) {
    vscode.postMessage({ type: "listSessions" });
    $<HTMLInputElement>("historySearch").focus();
  }
}

// Messages from the extension

function handle(message: HostMessage): void {
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
    case "reasoningDelta":
      if (state?.showThinking !== false) renderThought(message.id, message.text, false);
      break;
    case "reasoningEnd":
      if (state?.showThinking !== false && message.text) renderThought(message.id, "", true, message.text);
      break;
    case "tool":
      updateTool(message);
      break;
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
      if (message.status !== "done" && message.message) append(element("p", "notice warning", message.message));
      if (message.verified) append(element("p", "notice success", "Phew! All checks pass."));
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
    case "showOnboarding":
      showAssistantCard(state?.assistant, false, (next) => vscode.postMessage(next));
      break;
    case "sessions":
      sessions = [...message.sessions];
      history = [...message.history];
      renderPanel();
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
      if (message.text && !prompt.value) prompt.value = message.text;
      prompt.focus();
      break;
  }
}

// Input

function sendNow(interrupt: boolean): void {
  const text = prompt.value.trim();
  if (!text && attachments.length === 0) return;
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
prompt.addEventListener("input", () => {
  historyPosition = -1;
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

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
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
}

function togglePopover(id: string): void {
  const popover = $(id);
  closePopovers(popover);
  popover.hidden = !popover.hidden;
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest(".popover, #attachButton, #approvalsButton, #appearanceButton")) closePopovers();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopovers();
});
$("attachButton").addEventListener("click", () => togglePopover("attachMenu"));
$("appearanceButton").addEventListener("click", () => togglePopover("appearance"));
const swatches = $("swatches");
for (const preset of [{ name: "Theme", color: "" }, ...accentPresets]) {
  const swatch = element("button", "swatch");
  swatch.type = "button";
  swatch.title = preset.name;
  swatch.dataset.color = preset.color;
  if (preset.color) swatch.style.background = preset.color;
  else swatch.classList.add("theme");
  swatch.addEventListener("click", () =>
    vscode.postMessage({ type: "setAppearance", key: "accentColor", value: preset.color }),
  );
  swatches.append(swatch);
}
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
$<HTMLSelectElement>("timestampChoice").addEventListener("change", (event) =>
  vscode.postMessage({ type: "setAppearance", key: "timestamps", value: (event.target as HTMLSelectElement).value }),
);
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
$("approvalsButton").addEventListener("click", () => togglePopover("approvals"));
$("attachContext").addEventListener("click", () => {
  closePopovers();
  const position = prompt.selectionStart;
  const before = prompt.value.slice(0, position);
  const insert = before === "" || /\s$/.test(before) ? "@" : " @";
  prompt.value = `${before}${insert}${prompt.value.slice(position)}`;
  prompt.selectionStart = prompt.selectionEnd = position + insert.length;
  prompt.focus();
  prompt.dispatchEvent(new Event("input"));
});
$("imageButton").addEventListener("click", () => {
  closePopovers();
  imageInput.click();
});
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
  panel.hidden = true;
});
$("panelParallel").addEventListener("click", () => {
  vscode.postMessage({ type: "openInEditor" });
  panel.hidden = true;
});
$("panelWorktree").addEventListener("click", () => {
  vscode.postMessage({ type: "newWorktreeAgent" });
  panel.hidden = true;
});
$("panelExport").addEventListener("click", () => vscode.postMessage({ type: "exportChat" }));
$("historyButton").addEventListener("click", () => togglePanel());
$("title").addEventListener("click", () => togglePanel());
$("closePanel").addEventListener("click", () => togglePanel(false));
$("historySearch").addEventListener("input", renderPanel);
modelButton.addEventListener("click", () => vscode.postMessage({ type: "configureModel" }));
$("setup").addEventListener("click", () => vscode.postMessage({ type: "configureModel" }));
$("guide").addEventListener("click", () => vscode.postMessage({ type: "openWalkthrough" }));
$("reviewNext").addEventListener("click", () => vscode.postMessage({ type: "reviewNext" }));
$("context").addEventListener("click", () => {
  if (Number.parseInt($("contextLabel").textContent ?? "0", 10) >= 50 && !state?.busy)
    vscode.postMessage({ type: "compact" });
});
$("saveApprovals").addEventListener("click", () => vscode.postMessage({ type: "resetApprovals" }));
$("planToggle").addEventListener("click", () => {
  saved.planOpen = !saved.planOpen;
  vscode.setState(saved);
  $("planItems").hidden = !saved.planOpen;
  $("planToggle").setAttribute("aria-expanded", String(saved.planOpen));
});
modeSelect.addEventListener("change", () => vscode.postMessage({ type: "setMode", mode: modeSelect.value }));
$<HTMLSelectElement>("approvalReview").addEventListener("change", (event) =>
  vscode.postMessage({
    type: "setApproval",
    key: "review",
    value: (event.target as HTMLSelectElement).value as "chat" | "editor" | "none",
  }),
);
$<HTMLSelectElement>("approvalCommands").addEventListener("change", (event) =>
  vscode.postMessage({
    type: "setApproval",
    key: "commands",
    value: (event.target as HTMLSelectElement).value as "ask" | "allowlist" | "safe",
  }),
);
$<HTMLSelectElement>("approvalMcp").addEventListener("change", (event) =>
  vscode.postMessage({ type: "setApproval", key: "mcp", value: (event.target as HTMLSelectElement).value === "true" }),
);
window.addEventListener("message", (event: MessageEvent<HostMessage>) => handle(event.data));
vscode.postMessage({ type: "ready" });
