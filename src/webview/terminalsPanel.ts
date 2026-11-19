import { icon } from "../shared/icons";
import type { ViewState, WebviewMessage } from "../shared/protocol";

/**
 * The terminals of the chat: how many the agent has, what each one does, its shell, process id, and folder,
 * and Show, Ctrl+C, and Close for each. The button under the input shows the count and turns active while
 * a command runs.
 */

type Terminals = ViewState["terminals"];

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

function iconNode(name: string): Element {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  return template.content.firstElementChild as Element;
}

const stateLabels: Readonly<Record<Terminals[number]["state"], string>> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting for input",
  stopped: "Closed",
};

/** A folder with ~ for the home folder, shortened from the left. */
function shortFolder(folder: string | undefined): string {
  if (!folder) return "";
  const home = folder.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/)?.[0];
  const short = home ? `~${folder.slice(home.length)}` : folder;
  return short.length > 36 ? `…${short.slice(-35)}` : short;
}

export interface TerminalsPanel {
  update(terminals: Terminals): void;
}

export function createTerminalsPanel(options: {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  readonly post: (message: WebviewMessage) => void;
  readonly closeOthers: (except: HTMLElement) => void;
}): TerminalsPanel {
  const { button, panel, post } = options;
  let terminals: Terminals = [];
  let key = "";

  const render = () => {
    const children: Node[] = [];
    const head = el("div", "terminals-head");
    head.append(el("span", "popover-title", "Terminals"), el("span", "terminals-count", String(terminals.length)));
    children.push(head);
    if (terminals.length === 0) children.push(el("p", "popover-note", "The agent has no terminal in this chat yet."));
    for (const terminal of terminals) {
      const row = el("div", "terminal-row");
      row.dataset.state = terminal.state;
      const main = el("button", "terminal-main");
      main.type = "button";
      main.title = "Show this terminal";
      main.addEventListener("click", () => post({ type: "terminalAction", id: terminal.id, action: "show" }));
      const title = el("span", "terminal-title");
      title.append(
        el("span", "terminal-dot"),
        el("strong", undefined, terminal.name),
        el("span", "terminal-state", stateLabels[terminal.state]),
      );
      const details = [terminal.shell, terminal.pid ? `pid ${terminal.pid}` : "", shortFolder(terminal.cwd)]
        .filter(Boolean)
        .join(" · ");
      main.append(title, el("span", "terminal-details", details));
      if (terminal.command)
        main.append(el("code", "terminal-command", terminal.command.split("\n")[0]?.slice(0, 80) ?? ""));
      const actions = el("span", "terminal-actions");
      const action = (name: string, label: string, kind: "interrupt" | "kill", enabled = true) => {
        const node = el("button", "term-action");
        node.type = "button";
        node.title = label;
        node.setAttribute("aria-label", `${label}: ${terminal.name}`);
        node.disabled = !enabled;
        node.append(iconNode(name));
        node.addEventListener("click", () => post({ type: "terminalAction", id: terminal.id, action: kind }));
        actions.append(node);
      };
      action(
        "stop",
        "Stop the running command (Ctrl+C)",
        "interrupt",
        terminal.state === "running" || terminal.state === "waiting",
      );
      action("trash", "Close the terminal and end its processes", "kill");
      row.append(main, actions);
      children.push(row);
    }
    children.push(
      el(
        "p",
        "popover-note terminals-note",
        "The agent opens another terminal when it needs one, for example for a server. Close ends the shell and every process in it.",
      ),
    );
    panel.replaceChildren(...children);
  };

  button.addEventListener("click", () => {
    const open = panel.hidden;
    options.closeOthers(panel);
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      // The list is a dialog: focus moves into it, and Escape brings it back to the button.
      panel.querySelector<HTMLElement>("button")?.focus();
    }
  });

  return {
    update(next) {
      const nextKey = JSON.stringify(next);
      if (nextKey === key) return;
      key = nextKey;
      terminals = next;
      const busy = next.filter((terminal) => terminal.state === "running" || terminal.state === "waiting").length;
      button.hidden = next.length === 0;
      button.classList.toggle("busy", busy > 0);
      button.title = `Terminals of this chat: ${next.length}${busy ? `, ${busy} busy` : ""}`;
      button.setAttribute("aria-label", button.title);
      button.replaceChildren(iconNode("terminal"), el("span", "terminals-badge", String(next.length)));
      if (!panel.hidden) render();
    },
  };
}
