import { icon } from "../shared/icons";
import type { ViewState, WebviewMessage } from "../shared/protocol";

/**
 * The terminals of the agents. "This chat" lists the terminals of the chat: what each one is for, what runs in it,
 * its ports, its shell, process id, and folder, with Show, Ctrl+C, and Close. When other chats have terminals too,
 * "All agents" shows all of them, grouped by chat, so a person sees at a glance what every agent runs. The button
 * under the input shows the count and turns active while a command runs.
 */

type Terminal = ViewState["terminals"][number];
type OtherChats = ViewState["otherTerminals"];

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

const stateLabels: Readonly<Record<Terminal["state"], string>> = {
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

const busy = (terminal: Terminal) => terminal.state === "running" || terminal.state === "waiting";

export interface TerminalsPanel {
  update(terminals: readonly Terminal[], others?: OtherChats): void;
}

export function createTerminalsPanel(options: {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  readonly post: (message: WebviewMessage) => void;
  readonly closeOthers: (except: HTMLElement) => void;
}): TerminalsPanel {
  const { button, panel, post } = options;
  let terminals: readonly Terminal[] = [];
  let others: OtherChats = [];
  let tab: "chat" | "all" = "chat";
  let key = "";

  const row = (terminal: Terminal, chatId?: string): HTMLElement => {
    const node = el("div", "terminal-row");
    node.dataset.state = terminal.state;
    const name = terminal.label ?? terminal.name;
    const main = el("button", "terminal-main");
    main.type = "button";
    main.title = "Show this terminal";
    main.addEventListener("click", () =>
      post({ type: "terminalAction", id: terminal.id, action: "show", ...(chatId ? { chatId } : {}) }),
    );
    const title = el("span", "terminal-title");
    title.append(el("span", "terminal-dot"), el("strong", "terminal-name", name));
    // A named terminal keeps its number small, for "terminal 2" in the chat.
    if (terminal.label) title.append(el("span", "terminal-id", `#${terminal.id}`));
    title.append(el("span", "terminal-state", stateLabels[terminal.state]));
    const details = [terminal.shell, terminal.pid ? `pid ${terminal.pid}` : "", shortFolder(terminal.cwd)]
      .filter(Boolean)
      .join(" · ");
    main.append(title, el("span", "terminal-details", details));
    if (terminal.command)
      main.append(el("code", "terminal-command", terminal.command.split("\n")[0]?.slice(0, 80) ?? ""));
    const body = el("div", "terminal-body");
    body.append(main);
    // A port opens the server in the browser.
    if (terminal.ports && terminal.ports.length > 0) {
      const ports = el("div", "terminal-ports");
      for (const port of terminal.ports) {
        const link = el("button", "terminal-port", `localhost:${port}`);
        link.type = "button";
        link.title = `Open http://localhost:${port} in the browser`;
        link.append(iconNode("export"));
        link.addEventListener("click", () => post({ type: "openPort", port }));
        ports.append(link);
      }
      body.append(ports);
    }
    const actions = el("span", "terminal-actions");
    const action = (glyph: string, label: string, kind: "interrupt" | "kill", enabled = true) => {
      const control = el("button", "term-action");
      control.type = "button";
      control.title = label;
      control.setAttribute("aria-label", `${label}: ${name}`);
      control.disabled = !enabled;
      control.append(iconNode(glyph));
      control.addEventListener("click", () =>
        post({ type: "terminalAction", id: terminal.id, action: kind, ...(chatId ? { chatId } : {}) }),
      );
      actions.append(control);
    };
    action("stop", "Stop the running command (Ctrl+C)", "interrupt", busy(terminal));
    action("trash", "Close the terminal and end its processes", "kill");
    node.append(body, actions);
    return node;
  };

  const render = () => {
    const children: Node[] = [];
    const head = el("div", "terminals-head");
    const total = terminals.length + others.reduce((sum, chat) => sum + chat.terminals.length, 0);
    if (others.length > 0) {
      // Two views when other chats have terminals too.
      const tabs = el("div", "terminals-tabs");
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "Terminals");
      for (const [value, label, count] of [
        ["chat", "This chat", terminals.length],
        ["all", "All agents", total],
      ] as const) {
        const control = el("button", "terminals-tab");
        control.type = "button";
        control.setAttribute("role", "tab");
        control.setAttribute("aria-selected", String(tab === value));
        control.append(el("span", undefined, label), el("span", "terminals-count", String(count)));
        control.addEventListener("click", () => {
          tab = value;
          render();
          panel.querySelector<HTMLElement>('.terminals-tab[aria-selected="true"]')?.focus();
        });
        tabs.append(control);
      }
      head.append(tabs);
    } else
      head.append(el("span", "popover-title", "Terminals"), el("span", "terminals-count", String(terminals.length)));
    children.push(head);

    const list = el("div", "terminals-list");
    if (tab === "chat" || others.length === 0) {
      if (terminals.length === 0) list.append(el("p", "popover-note", "The agent has no terminal in this chat yet."));
      for (const terminal of terminals) list.append(row(terminal));
    } else {
      const groups = [{ chatId: "", title: "This chat", terminals }, ...others].filter(
        (group) => group.terminals.length > 0,
      );
      for (const group of groups) {
        const header = el("div", "terminal-group");
        const running = group.terminals.filter(busy).length;
        header.append(
          el("span", "terminal-group-title", group.title),
          el("span", "terminal-group-count", `${group.terminals.length}${running ? ` · ${running} busy` : ""}`),
        );
        if (group.chatId) {
          const open = el("button", "terminal-group-open", "Open chat");
          open.type = "button";
          open.setAttribute("aria-label", `Open the chat ${group.title}`);
          open.addEventListener("click", () => post({ type: "switchSession", id: group.chatId }));
          header.append(open);
        }
        list.append(header);
        for (const terminal of group.terminals) list.append(row(terminal, group.chatId || undefined));
      }
    }
    children.push(list);
    children.push(
      el(
        "p",
        "popover-note terminals-note",
        "Agents name their terminals and close the ones they no longer need. Close ends every process in the terminal.",
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
    update(next, nextOthers = []) {
      const nextKey = JSON.stringify([next, nextOthers]);
      if (nextKey === key) return;
      key = nextKey;
      terminals = next;
      others = nextOthers;
      if (others.length === 0) tab = "chat";
      const busyHere = next.filter(busy).length;
      const elsewhere = nextOthers.reduce((sum, chat) => sum + chat.terminals.length, 0);
      // The button shows the terminals of this chat; it also shows when only other agents have terminals.
      button.hidden = next.length === 0 && elsewhere === 0;
      button.classList.toggle("busy", busyHere > 0);
      button.title = `Terminals of this chat: ${next.length}${busyHere ? `, ${busyHere} busy` : ""}${
        elsewhere ? `. Other agents: ${elsewhere}` : ""
      }`;
      button.setAttribute("aria-label", button.title);
      button.replaceChildren(iconNode("terminal"), el("span", "terminals-badge", String(next.length)));
      if (!panel.hidden) render();
    },
  };
}
