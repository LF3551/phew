import { type SubagentMessage, stepLabel, subagentModel, subagentState } from "./subagentLabels";

/**
 * The card of a subagent in the chat: its title, model, and state in one line, and when you open it the task, the
 * steps, and the report. It changes in place while the subagent works.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Fills the card for the newest state. An open card stays open. */
export function renderSubagent(
  card: HTMLDetailsElement,
  message: SubagentMessage,
  markdown: (text: string) => DocumentFragment,
): void {
  // The state is an attribute, so it never meets the classes of other parts of the chat.
  card.className = "subagent";
  card.dataset.id = message.id;
  card.dataset.status = message.status;
  const summary = el("summary");
  const dot = el("span", "sub-dot");
  dot.setAttribute("aria-hidden", "true");
  const title = el("span", "sub-title", message.title);
  const state = el("span", "sub-state", subagentState(message));
  const meta = el("span", "sub-meta", `Subagent · ${subagentModel(message)}`);
  summary.append(dot, title, state, meta);
  summary.title = `${message.title}\n${subagentModel(message)} · ${subagentState(message)}`;

  const body = el("div", "sub-body");
  body.append(el("p", "sub-task", message.task));
  if (message.steps.length > 0) {
    const list = el("ol", "sub-steps");
    const earlier = message.stepCount - message.steps.length;
    if (earlier > 0) list.append(el("li", "sub-earlier", `${earlier} earlier step${earlier === 1 ? "" : "s"}`));
    message.steps.forEach((step, index) => {
      const running = message.status === "running" && index === message.steps.length - 1;
      list.append(el("li", step.name === "fallback" ? "sub-fallback" : undefined, stepLabel(step, running)));
    });
    body.append(list);
  }
  if (message.error) body.append(el("p", "sub-error", message.error));
  if (message.report) {
    const report = el("div", "sub-report");
    report.append(markdown(message.report));
    body.append(report);
  }
  card.replaceChildren(summary, body);
}
