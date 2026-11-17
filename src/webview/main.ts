import type { Attachment } from "../core/attachments";
import type {
  HistoryItem,
  HostMessage,
  MentionItem,
  SessionSummary,
  ViewState,
  WebviewMessage,
} from "../shared/protocol";
import { renderMarkdown } from "./markdown";

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
const meter = $<HTMLElement>("meter");
const chips = $<HTMLElement>("chips");
const mentionsBox = $<HTMLElement>("mentions");
const panel = $<HTMLElement>("panel");
const celebration = $<HTMLElement>("celebration");
const imageInput = $<HTMLInputElement>("imageInput");

let state: ViewState | undefined;
const assistants = new Map<string, { element: HTMLElement; text: string }>();
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
}
const saved: Saved = { promptHistory: [], ...((vscode.getState() as Partial<Saved> | undefined) ?? {}) };
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

function append(node: HTMLElement): void {
  welcome.hidden = true;
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  transcript.append(node);
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

/** Renders Markdown and adds a Copy button to each code block. */
function markdown(text: string): DocumentFragment {
  const fragment = renderMarkdown(text);
  for (const pre of fragment.querySelectorAll("pre")) {
    const wrapper = element("div", "code");
    pre.replaceWith(wrapper);
    const copy = button("Copy", "copy", () => {
      void navigator.clipboard.writeText(pre.textContent ?? "").then(() => {
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1200);
      });
    });
    wrapper.append(copy, pre);
  }
  return fragment;
}

function applyState(next: ViewState): void {
  state = next;
  $("titleText").textContent = next.title;
  const worktree = $("worktree");
  worktree.hidden = !next.worktree;
  worktree.textContent = next.worktree ? `⑂ ${next.worktree}` : "";
  const running = $("running");
  running.hidden = next.runningSessions === 0;
  running.textContent = next.runningSessions > 0 ? `● ${next.runningSessions}` : "";
  running.title = `${next.runningSessions} running`;

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

  modelButton.textContent = next.configured ? `${next.model} ▾` : "Choose a model ▾";
  modelButton.title = next.configured ? `${next.model} (${next.provider}). Click to switch.` : "Add a model";
  $("setup").hidden = next.configured;
  sendButton.hidden = next.busy;
  stopButton.hidden = !next.busy;
  $<HTMLSelectElement>("approvalReview").value = next.approvals.review;
  $<HTMLSelectElement>("approvalCommands").value = next.approvals.commands;
  $<HTMLSelectElement>("approvalMcp").value = String(next.approvals.mcp);
  $("approvals").hidden = !next.trusted;

  const usage = [next.tokens !== "0" ? `${next.tokens} tokens` : "", next.cost].filter(Boolean).join(" · ");
  meter.textContent = [next.trusted ? "" : "Restricted mode: Phew changes nothing.", usage, next.stats]
    .filter(Boolean)
    .join("  ·  ");
  const banner = $("reviewBanner");
  banner.hidden = next.reviewFiles === 0;
  $("reviewText").textContent =
    `${next.reviewFiles} ${next.reviewFiles === 1 ? "file has" : "files have"} changes to keep or undo.`;
}

function addUser(message: Extract<HostMessage, { type: "user" }>): void {
  const node = element("article", "message user");
  node.append(element("div", "text", message.text));
  if (message.attachments && message.attachments.length > 0) {
    const list = element("div", "chips static");
    for (const label of message.attachments) list.append(element("span", "chip", label));
    node.append(list);
  }
  const actions = element("div", "message-actions");
  actions.append(
    button(
      "Restore checkpoint",
      "link",
      () => vscode.postMessage({ type: "restoreCheckpoint", checkpointId: message.checkpointId }),
      "Undo all file changes made since this request",
    ),
    button(
      "Edit",
      "link",
      () => {
        prompt.value = message.text;
        prompt.focus();
      },
      "Copy this request to the input",
    ),
  );
  node.append(actions);
  append(node);
}

function renderAssistant(id: string, text: string, done: boolean): void {
  let entry = assistants.get(id);
  if (!entry) {
    const node = element("article", "message assistant streaming");
    entry = { element: node, text: "" };
    assistants.set(id, entry);
    append(node);
  }
  entry.text = text;
  if (done) {
    entry.element.classList.remove("streaming");
    entry.element.replaceChildren(markdown(text));
    if (text.trim() === "") entry.element.remove();
  } else entry.element.textContent = text;
  if (transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 160)
    transcript.scrollTop = transcript.scrollHeight;
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
  summary.append(element("span", "icon", icon), element("span", "label", message.summary));
  node.replaceChildren(summary);
  if (message.detail) node.append(element("pre", "detail", message.detail));
}

function addApproval(message: Extract<HostMessage, { type: "approval" }>): void {
  const card = element("section", `approval ${message.kind}`);
  card.append(element("h3", undefined, message.title));
  if (message.reason) card.append(element("p", "reason", message.reason));
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

  const actions = element("div", "actions");
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
  for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input"))
    control.disabled = true;
  card.querySelector(".actions")?.replaceChildren(element("span", `decision ${decision}`, decision));
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
  tools.clear();
  approvals.clear();
  welcome.hidden = false;
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
      if (session.needsApproval) row.append(element("span", "badge warn", "needs approval"));
      else if (session.running) row.append(element("span", "badge", "running"));
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

function relativeTime(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
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
      renderAssistant(message.id, "", false);
      break;
    case "assistantDelta":
      renderAssistant(message.id, (assistants.get(message.id)?.text ?? "") + message.text, false);
      break;
    case "assistantEnd":
      renderAssistant(message.id, message.text, true);
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
      node.append(
        element(
          "summary",
          undefined,
          message.passed ? "✓ Checks pass" : `✕ Checks fail (attempt ${message.attempt}). Phew keeps fixing…`,
        ),
        element("pre", "detail", message.output),
      );
      append(node);
      break;
    }
    case "taskEnd":
      if (message.status !== "done" && message.message) append(element("p", "notice warning", message.message));
      if (message.verified) append(element("p", "notice success", "Phew! All checks pass."));
      if (message.celebrate && state?.celebrate !== false) celebrate();
      break;
    case "notice":
      append(element("p", `notice ${message.level}`, message.text));
      break;
    case "checkpointRestored":
      append(element("p", "notice info", `Restored ${message.files.length} files: ${message.files.join(", ")}`));
      break;
    case "cleared":
      clearTranscript();
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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if ((!text && attachments.length === 0) || state?.busy) return;
  vscode.postMessage({ type: "send", text, attachments: attachments.map((item) => item.attachment) });
  if (text) {
    saved.promptHistory = [...saved.promptHistory.filter((item) => item !== text), text].slice(-100);
    vscode.setState(saved);
  }
  historyPosition = -1;
  prompt.value = "";
  attachments = [];
  renderChips();
  showMentions([]);
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
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
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

$("mentionButton").addEventListener("click", () => {
  const position = prompt.selectionStart;
  const before = prompt.value.slice(0, position);
  const insert = before === "" || /\s$/.test(before) ? "@" : " @";
  prompt.value = `${before}${insert}${prompt.value.slice(position)}`;
  prompt.selectionStart = prompt.selectionEnd = position + insert.length;
  prompt.focus();
  prompt.dispatchEvent(new Event("input"));
});
$("imageButton").addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => {
  for (const file of imageInput.files ?? []) readImage(file);
  imageInput.value = "";
});

stopButton.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
$("newChat").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
$("panelNew").addEventListener("click", () => {
  vscode.postMessage({ type: "newChat" });
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
meter.addEventListener("click", () => vscode.postMessage({ type: "showStats" }));
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
