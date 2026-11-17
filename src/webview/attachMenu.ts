import type { Attachment } from "../core/attachments";
import { icon } from "../shared/icons";
import type { ContextOption, WebviewMessage } from "../shared/protocol";

/**
 * The attach menu: one click adds what is open, selected, broken, or changed right now.
 * The host sends the options when the menu opens. A second click removes the context again.
 */

const optionIcons: Readonly<Record<ContextOption["id"], string>> = {
  file: "file",
  selection: "type",
  fileProblems: "warning",
  problems: "warning",
  git: "git",
  terminal: "terminal",
};

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

export interface AttachMenu {
  open(): void;
  close(focusButton?: boolean): void;
  toggle(): void;
  /** The host answered with the options for the current editor. */
  setOptions(options: readonly ContextOption[]): void;
  /** The attachments changed, so the check marks change too. */
  refresh(): void;
}

export function createAttachMenu(options: {
  readonly button: HTMLButtonElement;
  readonly menu: HTMLElement;
  readonly post: (message: WebviewMessage) => void;
  readonly closeOthers: (except: HTMLElement) => void;
  readonly has: (attachment: Attachment) => boolean;
  readonly add: (attachment: Attachment, label: string) => void;
  readonly remove: (attachment: Attachment) => void;
  readonly mention: () => void;
  readonly pickImage: () => void;
}): AttachMenu {
  const { button, menu } = options;
  const paste = navigator.platform.toLowerCase().includes("mac") ? "⌘V" : "Ctrl+V";
  let context: readonly ContextOption[] | undefined;

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>(".attach-item")];

  const item = (
    glyph: string,
    label: string,
    detail: string | undefined,
    end: Node | undefined,
    onClick: () => void,
    extra?: { checked?: boolean; tone?: string },
  ) => {
    const node = el("button", "attach-item");
    node.type = "button";
    node.tabIndex = -1;
    node.setAttribute("role", extra?.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (extra?.checked !== undefined) node.setAttribute("aria-checked", String(extra.checked));
    if (extra?.tone) node.dataset.tone = extra.tone;
    const glyphNode = el("span", "attach-glyph");
    glyphNode.append(iconNode(glyph));
    const text = el("span", "attach-text");
    text.append(el("span", "attach-label", label));
    if (detail) text.append(el("span", "attach-detail", detail));
    const endNode = el("span", "attach-end");
    if (end) endNode.append(end);
    node.append(glyphNode, text, endNode);
    node.addEventListener("click", onClick);
    return node;
  };

  const kbd = (text: string) => el("kbd", undefined, text);

  const render = () => {
    const focusedIndex = items().indexOf(document.activeElement as HTMLButtonElement);
    const children: Node[] = [el("div", "popover-title", "Add context")];
    if (context === undefined) {
      const loading = el("div", "attach-loading");
      loading.append(el("span"), el("span"), el("span"));
      children.push(loading);
    } else if (context.length === 0) {
      children.push(el("p", "popover-note attach-empty", "Open a file to add it in one click."));
    } else {
      context.forEach((option, index) => {
        const checked = options.has(option.attachment);
        const end = checked ? iconNode("check") : index < 9 ? kbd(String(index + 1)) : undefined;
        children.push(
          item(
            optionIcons[option.id],
            option.label,
            option.detail,
            end,
            () => {
              if (options.has(option.attachment)) options.remove(option.attachment);
              else options.add(option.attachment, option.chip);
              render();
            },
            { checked, tone: option.tone },
          ),
        );
      });
    }
    children.push(el("div", "attach-separator"));
    children.push(
      item("at", "Search files…", "Any file, @problems, @git, @terminal", kbd("@"), () => {
        close(false);
        options.mention();
      }),
      item("image", "Image or screenshot", "PNG, JPEG, GIF, or WebP", kbd(paste), () => {
        close(false);
        options.pickImage();
      }),
    );
    children.push(el("p", "attach-tip", "Tip: drop files or images onto the chat."));
    menu.replaceChildren(...children);
    const list = items();
    if (focusedIndex >= 0) list[Math.min(focusedIndex, list.length - 1)]?.focus();
  };

  const open = () => {
    options.closeOthers(menu);
    context = undefined;
    options.post({ type: "contextQuery" });
    render();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    items()[0]?.focus();
  };

  const close = (focusButton = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };

  menu.addEventListener("keydown", (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list[list.length - 1])?.focus();
    } else if (/^[1-9]$/.test(event.key) && context?.[Number(event.key) - 1]) {
      event.preventDefault();
      list[Number(event.key) - 1]?.click();
    } else if (event.key === "@") {
      event.preventDefault();
      close(false);
      options.mention();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      open();
    }
  });

  return {
    open,
    close,
    toggle: () => (menu.hidden ? open() : close()),
    setOptions(next) {
      context = next;
      if (!menu.hidden) {
        const wasLoading = items().length <= 2;
        render();
        if (wasLoading && menu.contains(document.activeElement)) items()[0]?.focus();
      }
    },
    refresh() {
      if (!menu.hidden && context !== undefined) render();
    },
  };
}
