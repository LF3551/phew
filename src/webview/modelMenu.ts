import { modelMaker, modelTitle, providerLabels } from "../core/modelLabels";
import { icon } from "../shared/icons";
import type { ModelOption, WebviewMessage } from "../shared/protocol";

/**
 * The model menu opens right above the model button, not at the top of the window.
 * Each row says what the model is: the name, the provider, and the context size, without repeats.
 */

const providerStyle: Readonly<Record<ModelOption["provider"], { badge: string; color: string; label: string }>> = {
  anthropic: { badge: "A", color: "#d97757", label: providerLabels.anthropic },
  openai: { badge: "O", color: "#10a37f", label: providerLabels.openai },
  gemini: { badge: "G", color: "#4285f4", label: providerLabels.gemini },
  vscode: { badge: "VS", color: "#3794ff", label: providerLabels.vscode },
};

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

/** The badge of the maker of the model: Claude through Copilot shows the Anthropic badge, with the way in the title. */
export function providerBadge(model: Pick<ModelOption, "provider" | "model" | "name">): HTMLElement {
  const maker = modelMaker(model);
  const badge = el("span", "provider-badge", maker.badge);
  badge.style.setProperty("--provider-color", maker.color);
  const via = /copilot/i.test(model.name) ? "GitHub Copilot" : providerStyle[model.provider].label;
  badge.title = maker.label === via ? maker.label : `${maker.label}, via ${via}`;
  return badge;
}

export interface ModelMenu {
  update(models: readonly ModelOption[], busy: boolean, modeModel: string | undefined, modeName: string): void;
  open(): void;
  close(focusButton?: boolean): void;
}

export { modelTitle };

export function createModelMenu(options: {
  readonly button: HTMLButtonElement;
  readonly menu: HTMLElement;
  readonly post: (message: WebviewMessage) => void;
  readonly closeOthers: (except: HTMLElement) => void;
}): ModelMenu {
  const { button, menu, post } = options;
  let models: readonly ModelOption[] = [];
  let busy = false;
  let modeModel: string | undefined;
  let modeName = "";
  let filter = "";
  let key = "";

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>(".model-item, .model-footer button")];

  const choose = (id: string) => {
    post({ type: "useModel", id });
    models = models.map((model) => ({ ...model, active: model.id === id }));
    close(true);
  };

  const row = (model: ModelOption, index: number) => {
    const { title, detail } = modelTitle(model);
    const item = el("button", "model-item");
    item.type = "button";
    item.tabIndex = -1;
    item.dataset.id = model.id;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(model.active));
    const text = el("span", "model-text");
    text.append(el("span", "model-name", title));
    if (detail) text.append(el("span", "model-detail", detail));
    const end = el("span", "model-end");
    if (model.active) end.append(iconNode("check"));
    else if (index < 9 && !filter) end.append(el("kbd", undefined, String(index + 1)));
    item.append(providerBadge(model), text, end);
    item.addEventListener("click", () => choose(model.id));
    return item;
  };

  const visible = () => {
    const query = filter.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) =>
      `${model.name} ${model.model} ${providerStyle[model.provider].label}`.toLowerCase().includes(query),
    );
  };

  const render = (focusSearch = false) => {
    const focusedId = menu.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.id
      : undefined;
    const children: Node[] = [];
    const head = el("div", "model-head");
    head.append(el("span", "popover-title", "Model"));
    let search: HTMLInputElement | undefined;
    if (models.length > 6) {
      search = el("input", "model-search");
      search.type = "search";
      search.placeholder = "Filter models";
      search.value = filter;
      search.setAttribute("aria-label", "Filter models");
      search.addEventListener("input", () => {
        filter = search?.value ?? "";
        render(true);
      });
      head.append(search);
    }
    children.push(head);
    if (busy)
      children.push(el("p", "popover-note model-note", "Phew is working. A new model answers from your next message."));
    const list = visible();
    if (list.length === 0) children.push(el("p", "popover-note model-note", "No model matches."));
    list.forEach((model, index) => {
      children.push(row(model, index));
    });
    if (modeModel)
      children.push(
        el("p", "model-mode-note", `${modeName} mode always uses ${modeModel}. Change it in the settings of the mode.`),
      );
    const footer = el("div", "model-footer");
    const add = el("button", "model-link");
    add.type = "button";
    add.tabIndex = -1;
    add.append(iconNode("plus"), el("span", undefined, "Connect another model…"));
    add.addEventListener("click", () => {
      close(false);
      post({ type: "configureModel" });
    });
    const manage = el("button", "model-link");
    manage.type = "button";
    manage.tabIndex = -1;
    manage.append(iconNode("edit"), el("span", undefined, "Manage models…"));
    manage.addEventListener("click", () => {
      close(false);
      post({ type: "manageModels" });
    });
    footer.append(add, manage);
    children.push(footer);
    menu.replaceChildren(...children);
    if (focusSearch && search) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    } else if (focusedId)
      menu.querySelector<HTMLButtonElement>(`.model-item[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  };

  const open = () => {
    options.closeOthers(menu);
    filter = "";
    render();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const search = menu.querySelector<HTMLInputElement>(".model-search");
    if (search) search.focus();
    else (menu.querySelector<HTMLButtonElement>('.model-item[aria-checked="true"]') ?? items()[0])?.focus();
  };

  const close = (focusButton = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };

  button.addEventListener("click", () => {
    // Without any model, the button opens the setup instead of an empty menu.
    if (models.length === 0) {
      post({ type: "configureModel" });
      return;
    }
    if (menu.hidden) open();
    else close();
  });
  button.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && models.length > 0) {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const list = items();
    const inSearch = (event.target as HTMLElement).classList.contains("model-search");
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.length === 0) return;
      const next = inSearch
        ? event.key === "ArrowDown"
          ? 0
          : list.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (event.key === "Enter" && inSearch) {
      event.preventDefault();
      const first = visible()[0];
      if (first) choose(first.id);
    } else if (/^[1-9]$/.test(event.key) && !inSearch) {
      const model = visible()[Number(event.key) - 1];
      if (!model) return;
      event.preventDefault();
      choose(model.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    } else if (!inSearch && event.key.length === 1 && /\S/.test(event.key)) {
      // Typing in the list starts the filter.
      const search = menu.querySelector<HTMLInputElement>(".model-search");
      if (search) {
        search.focus();
      }
    }
  });

  return {
    update(nextModels, nextBusy, nextModeModel, nextModeName) {
      const nextKey = JSON.stringify([nextModels, nextBusy, nextModeModel, nextModeName]);
      if (nextKey === key) return;
      key = nextKey;
      models = nextModels;
      busy = nextBusy;
      modeModel = nextModeModel;
      modeName = nextModeName;
      if (!menu.hidden) render();
    },
    open,
    close,
  };
}
