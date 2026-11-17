import type { Mode } from "../core/modes";
import type { HostMessage, ViewState, WebviewMessage } from "../shared/protocol";
import { renderMarkdown } from "./markdown";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
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
const newChatButton = $<HTMLButtonElement>("newChat");
const modelButton = $<HTMLButtonElement>("model");
const setupButton = $<HTMLButtonElement>("setup");
const meter = $<HTMLElement>("meter");
const celebration = $<HTMLElement>("celebration");
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];

let state: ViewState | undefined;
const assistants = new Map<string, { element: HTMLElement; text: string }>();
const tools = new Map<string, HTMLDetailsElement>();
const approvals = new Map<string, HTMLElement>();

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

function append(node: HTMLElement): void {
  welcome.hidden = true;
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  transcript.append(node);
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function applyState(next: ViewState): void {
  state = next;
  for (const item of modeButtons) {
    const active = item.dataset.mode === next.mode;
    item.classList.toggle("active", active);
    item.setAttribute("aria-checked", String(active));
    item.disabled = next.busy;
  }
  modelButton.textContent = next.configured ? `${next.model} · ${next.provider}` : "Choose a model";
  setupButton.hidden = next.configured;
  sendButton.hidden = next.busy;
  stopButton.hidden = !next.busy;
  prompt.disabled = next.busy;
  const usage = [next.tokens !== "0" ? `${next.tokens} tokens` : "", next.cost].filter(Boolean).join(" · ");
  meter.textContent = [usage, next.stats].filter(Boolean).join("  ·  ");
  if (!next.trusted) meter.textContent = `Restricted mode: Phew changes nothing.  ${meter.textContent}`;
}

function addUser(message: Extract<HostMessage, { type: "user" }>): void {
  const node = element("article", "message user");
  node.append(element("div", "text", message.text));
  const restore = button("Restore checkpoint", "link", () =>
    vscode.postMessage({ type: "restoreCheckpoint", checkpointId: message.checkpointId }),
  );
  restore.title = "Undo all file changes made since this request";
  node.append(restore);
  append(node);
}

function startAssistant(id: string): void {
  const node = element("article", "message assistant streaming");
  assistants.set(id, { element: node, text: "" });
  append(node);
}

function renderAssistant(id: string, text: string, done: boolean): void {
  let entry = assistants.get(id);
  if (!entry) {
    startAssistant(id);
    entry = assistants.get(id);
  }
  if (!entry) return;
  entry.text = text;
  if (done) {
    entry.element.classList.remove("streaming");
    entry.element.replaceChildren(renderMarkdown(text));
    if (text.trim() === "") entry.element.remove();
  } else entry.element.textContent = text;
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
  if (message.kind === "edit") {
    actions.append(button("Open diff", "secondary", () => vscode.postMessage({ type: "openDiff", id: message.id })));
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

function handle(message: HostMessage): void {
  switch (message.type) {
    case "state":
      applyState(message.state);
      break;
    case "user":
      addUser(message);
      break;
    case "assistantStart":
      startAssistant(message.id);
      break;
    case "assistantDelta": {
      const entry = assistants.get(message.id);
      renderAssistant(message.id, (entry?.text ?? "") + message.text, false);
      break;
    }
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
    case "taskEnd": {
      if (message.status !== "done" && message.message) append(element("p", "notice warning", message.message));
      if (message.verified) append(element("p", "notice success", "Phew! All checks pass."));
      if (message.celebrate && state?.celebrate !== false) celebrate();
      break;
    }
    case "notice":
      append(element("p", `notice ${message.level}`, message.text));
      break;
    case "checkpointRestored":
      append(element("p", "notice info", `Restored ${message.files.length} files: ${message.files.join(", ")}`));
      break;
    case "cleared":
      for (const node of [...transcript.children]) if (node !== welcome) node.remove();
      assistants.clear();
      tools.clear();
      approvals.clear();
      welcome.hidden = false;
      break;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || state?.busy) return;
  vscode.postMessage({ type: "send", text });
  prompt.value = "";
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
stopButton.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
newChatButton.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
modelButton.addEventListener("click", () => vscode.postMessage({ type: "configureModel" }));
setupButton.addEventListener("click", () => vscode.postMessage({ type: "configureModel" }));
meter.addEventListener("click", () => vscode.postMessage({ type: "showStats" }));
for (const item of modeButtons) {
  item.addEventListener("click", () => vscode.postMessage({ type: "setMode", mode: item.dataset.mode as Mode }));
}
window.addEventListener("message", (event: MessageEvent<HostMessage>) => handle(event.data));
vscode.postMessage({ type: "ready" });
