import type { SetupOption } from "../core/setupOptions";
import { icon } from "../shared/icons";
import type { WebviewMessage } from "../shared/protocol";

/**
 * The first-run card of the chat, shown until a model is connected: what is ready on this computer,
 * what is free to start, and the private option. Each button opens the setup page with that provider
 * selected; nothing is downloaded or connected without the user.
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

function iconNode(name: string): Element {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  return template.content.firstElementChild as Element;
}

const sections: readonly { kind: SetupOption["kind"]; title: string; icon: string; action: string }[] = [
  { kind: "ready", title: "Ready on this computer", icon: "check", action: "Connect" },
  { kind: "free", title: "Free to start", icon: "sparkle", action: "Set up" },
  { kind: "private", title: "Private", icon: "lock", action: "Set up" },
];

/** How often the card asks again, so a provider that the user just started shows up. */
const refreshMs = 15_000;

export function createSetupCard(root: HTMLElement, post: (message: WebviewMessage) => void) {
  let requestedAt = 0;
  let configured = true;

  const render = (options: readonly SetupOption[]) => {
    root.replaceChildren();
    root.append(
      el("h2", "setup-title", "Connect a model"),
      el("p", "setup-lead", "Phew works with the model you choose. Pick one to set it up."),
    );
    for (const section of sections) {
      const items = options.filter((option) => option.kind === section.kind);
      if (items.length === 0) continue;
      const group = el("section", `setup-group ${section.kind}`);
      const heading = el("h3", "setup-group-title");
      heading.append(iconNode(section.icon), el("span", undefined, section.title));
      group.append(heading);
      for (const option of items) {
        const row = el("div", "setup-row");
        const text = el("div", "setup-text");
        text.append(el("strong", undefined, option.label), el("span", undefined, option.detail));
        const button = el("button", section.kind === "ready" ? "primary small" : "secondary small", section.action);
        button.type = "button";
        button.setAttribute("aria-label", `${section.action}: ${option.label}`);
        button.addEventListener("click", () => post({ type: "connectProvider", id: option.id }));
        row.append(text, button);
        group.append(row);
      }
      root.append(group);
    }
    const more = el("button", "link setup-more", "All providers and settings");
    more.type = "button";
    more.addEventListener("click", () => post({ type: "configureModel" }));
    root.append(more);
  };

  return {
    /** Shows the card while no model is connected, and asks the host for fresh options now and then. */
    update(isConfigured: boolean): void {
      configured = isConfigured;
      root.hidden = configured || root.childElementCount === 0;
      if (configured) return;
      if (Date.now() - requestedAt < refreshMs) return;
      requestedAt = Date.now();
      post({ type: "setupOptions" });
    },
    receive(options: readonly SetupOption[]): void {
      if (configured) return;
      render(options);
      root.hidden = false;
    },
  };
}
