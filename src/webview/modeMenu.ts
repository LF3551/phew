import { icon } from "../shared/icons";
import type { ModeView, WebviewMessage } from "../shared/protocol";

/**
 * The mode switch under the input: a pill with the icon and color of the mode, and a menu that explains
 * each mode and shows which ones never change files. Shift+Tab in the input cycles the modes.
 */

interface ModeStyle {
  readonly icon: string;
  readonly color: string;
}

const builtInStyles: Readonly<Record<string, ModeStyle>> = {
  ask: { icon: "ask", color: "#4c9aff" },
  plan: { icon: "plan", color: "#a87ffb" },
  code: { icon: "code", color: "var(--phew-accent)" },
  debug: { icon: "bug", color: "#f0883e" },
  review: { icon: "review", color: "#3fb950" },
};

/** Colors for custom modes. The id picks one, so a mode keeps its color. */
const customColors = ["#f778ba", "#39c5cf", "#d4a72c", "#ff7b72", "#7ee787"];

export function modeStyle(mode: Pick<ModeView, "id" | "builtIn">): ModeStyle {
  const style = mode.builtIn ? builtInStyles[mode.id] : undefined;
  if (style) return style;
  let hash = 0;
  for (const character of mode.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { icon: "sparkle", color: customColors[hash % customColors.length] ?? customColors[0] };
}

function iconNode(name: string): Element {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  return template.content.firstElementChild as Element;
}

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

export interface ModeMenu {
  update(modes: readonly ModeView[], current: string, busy: boolean): void;
  /** Moves to the next or the previous mode. Returns false when the mode cannot change now. */
  cycle(direction: 1 | -1): boolean;
  isOpen(): boolean;
  close(focusButton?: boolean): void;
}

export function createModeMenu(options: {
  readonly button: HTMLButtonElement;
  readonly menu: HTMLElement;
  readonly composer: HTMLElement;
  readonly post: (message: WebviewMessage) => void;
  /** Closes the other popovers before the menu opens. */
  readonly closeOthers: (except: HTMLElement) => void;
}): ModeMenu {
  const { button, menu, composer, post } = options;
  let modes: readonly ModeView[] = [];
  let current = "";
  let busy = false;
  let key = "";

  const choose = (id: string) => {
    if (busy || id === current) return;
    current = id;
    post({ type: "setMode", mode: id });
    renderButton(true);
    renderMenu();
  };

  const renderButton = (changed = false) => {
    const mode = modes.find((item) => item.id === current) ?? modes[0];
    if (!mode) return;
    const style = modeStyle(mode);
    const label = el("span", "mode-name", mode.name);
    const parts: Node[] = [iconNode(style.icon), label];
    if (!mode.changes) {
      const lock = iconNode("lock");
      lock.classList.add("mode-lock");
      parts.push(lock);
    }
    button.replaceChildren(...parts);
    // The name hides on a narrow side bar; the button keeps it for screen readers and the tooltip.
    button.setAttribute("aria-label", `Mode: ${mode.name}${mode.changes ? "" : ", read only"}`);
    button.title = `Mode: ${mode.name}. Shift+Tab switches the mode.`;
    button.style.setProperty("--mode-color", style.color);
    composer.style.setProperty("--mode-color", style.color);
    composer.dataset.mode = mode.id;
    composer.classList.toggle("read-only-mode", !mode.changes);
    const hint = mode.changes ? "" : " Read-only: changes nothing.";
    button.title = `${mode.name}: ${mode.description}${hint} (Shift+Tab to switch)`;
    button.setAttribute("aria-label", `Mode: ${mode.name}${mode.changes ? "" : ", read-only"}`);
    if (changed) {
      button.classList.remove("switched");
      void button.getBoundingClientRect();
      button.classList.add("switched");
    }
  };

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>(".mode-item")];

  const renderMenu = () => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.mode : undefined;
    const children: Node[] = [];
    children.push(el("div", "popover-title", "Mode"));
    if (busy)
      children.push(
        el("p", "popover-note mode-busy", "Phew is working. Stop the task or wait for it to finish to switch modes."),
      );
    modes.forEach((mode, index) => {
      const style = modeStyle(mode);
      const item = el("button", "mode-item");
      item.type = "button";
      item.dataset.mode = mode.id;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(mode.id === current));
      item.disabled = busy;
      item.tabIndex = -1;
      item.style.setProperty("--mode-color", style.color);
      const glyph = el("span", "mode-glyph");
      glyph.append(iconNode(style.icon));
      const text = el("span", "mode-text");
      const title = el("span", "mode-title", mode.name);
      if (!mode.changes) title.append(el("span", "mode-tag", "read-only"));
      text.append(title);
      if (mode.description) text.append(el("span", "mode-description", mode.description));
      const end = el("span", "mode-end");
      if (mode.id === current) end.append(iconNode("check"));
      else if (index < 9) end.append(el("kbd", undefined, String(index + 1)));
      item.append(glyph, text, end);
      item.addEventListener("click", () => {
        choose(mode.id);
        close(true);
      });
      children.push(item);
    });
    const footer = el("div", "mode-footer");
    const custom = el("button", "link", "Custom modes…");
    custom.type = "button";
    custom.addEventListener("click", () => {
      close(false);
      post({ type: "editModes" });
    });
    footer.append(el("span", undefined, "⇧Tab switches"), custom);
    children.push(footer);
    menu.replaceChildren(...children);
    if (focused)
      items()
        .find((item) => item.dataset.mode === focused)
        ?.focus();
  };

  const open = () => {
    options.closeOthers(menu);
    renderMenu();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const list = items();
    (
      list.find((item) => item.dataset.mode === current && !item.disabled) ?? list.find((item) => !item.disabled)
    )?.focus();
    if (busy) menu.querySelector<HTMLButtonElement>(".mode-footer .link")?.focus();
  };

  const close = (focusButton = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };

  button.addEventListener("click", () => (menu.hidden ? open() : close()));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const list = items().filter((item) => !item.disabled);
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.length === 0) return;
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list[list.length - 1])?.focus();
    } else if (/^[1-9]$/.test(event.key)) {
      const mode = modes[Number(event.key) - 1];
      if (!mode || busy) return;
      event.preventDefault();
      choose(mode.id);
      close(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  });

  return {
    update(nextModes, nextCurrent, nextBusy) {
      const nextKey = JSON.stringify([nextModes, nextCurrent, nextBusy]);
      if (nextKey === key) return;
      key = nextKey;
      modes = nextModes;
      current = nextCurrent;
      busy = nextBusy;
      button.classList.toggle("busy", busy);
      renderButton();
      if (!menu.hidden) renderMenu();
    },
    cycle(direction) {
      if (busy || modes.length < 2) return false;
      const index = modes.findIndex((mode) => mode.id === current);
      const next = modes[(index + direction + modes.length) % modes.length];
      if (next) choose(next.id);
      return true;
    },
    isOpen: () => !menu.hidden,
    close,
  };
}
