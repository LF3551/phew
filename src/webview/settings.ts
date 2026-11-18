import { renderMarkdown } from "./markdown";
import { type ModelItem, ModelsSection } from "./modelsSection";
import { groupOrder, iconNode, sectionHeader, sectionInfo } from "./settingsParts";

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface Property {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  enumDescriptions?: string[];
  markdownDescription?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: { type?: string };
}

interface Init {
  type: "init";
  categories: { title: string; properties: Record<string, Property> }[];
  values: Record<string, unknown>;
  modified: string[];
  models: ModelItem[];
  identity: string;
  index: string;
  memory: string[];
  stats: string;
}

const vscode = acquireVsCodeApi();
const modelsSection = new ModelsSection((message) => vscode.postMessage(message));
const app = document.getElementById("app") as HTMLElement;
let filter = "";
/** The scroll listener of the menu, replaced when the page renders again. */
let onScroll: (() => void) | undefined;

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

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const node = el("button", primary ? "primary" : "secondary", label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function description(text: string | undefined): HTMLElement {
  const node = el("div", "description");
  node.append(renderMarkdown((text ?? "").replace(/#(phew\.[\w.]+)#/g, "`$1`")));
  return node;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Settings that the page shows in its own way, not as a raw row. */
const managedElsewhere = new Set(["phew.models", "phew.activeModel"]);

/** Readable names for the values of a choice; other values are capitalized. */
const optionLabels: Record<string, Record<string, string>> = {
  "phew.review.mode": { editor: "Review in the editor", chat: "Ask before each edit", none: "Apply without review" },
  "phew.commands.approval": { ask: "Ask for every command", allowlist: "Smart", safe: "All except dangerous" },
  "phew.commands.terminal": { open: "Open with the first command", background: "Open on request", off: "Off" },
};

function optionLabel(key: string, option: unknown): string {
  const text = String(option);
  const known = optionLabels[key]?.[text];
  if (known) return known;
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());
}

function control(key: string, property: Property, value: unknown): HTMLElement {
  const types = Array.isArray(property.type) ? property.type : [property.type ?? "string"];
  const set = (next: unknown) => vscode.postMessage({ type: "set", key, value: next });
  if (property.enum) {
    const select = el("select");
    property.enum.forEach((option, index) => {
      const item = el("option", undefined, optionLabel(key, option));
      item.value = String(option);
      if (property.enumDescriptions?.[index]) item.title = property.enumDescriptions[index];
      item.selected = option === value;
      select.append(item);
    });
    select.addEventListener("change", () => set(property.enum?.find((option) => String(option) === select.value)));
    const wrap = el("div", "enum");
    wrap.append(select);
    const index = property.enum.indexOf(value);
    // "#phew.commands.autoApprove#" is a link in the VS Code settings; here it reads as the name of the setting.
    if (index >= 0 && property.enumDescriptions?.[index])
      wrap.append(el("div", "hint", property.enumDescriptions[index].replace(/#(phew\.[\w.]+)#/g, "$1")));
    return wrap;
  }
  if (types.includes("boolean")) {
    const label = el("label", "toggle");
    const box = el("input");
    box.type = "checkbox";
    box.checked = value === true;
    box.addEventListener("change", () => set(box.checked));
    label.append(box, el("span", undefined, box.checked ? "On" : "Off"));
    return label;
  }
  if (types.includes("number") || types.includes("integer")) {
    const input = el("input");
    input.type = "number";
    if (property.minimum !== undefined) input.min = String(property.minimum);
    if (property.maximum !== undefined) input.max = String(property.maximum);
    input.value = value === null || value === undefined ? "" : String(value);
    input.placeholder = types.includes("null") ? "Default" : "";
    input.addEventListener("change", () => {
      if (input.value === "" && types.includes("null")) set(null);
      else if (input.value !== "")
        set(types.includes("integer") ? Math.round(Number(input.value)) : Number(input.value));
    });
    return input;
  }
  if (types.includes("array") && property.items?.type === "string") {
    const area = el("textarea");
    area.rows = Math.min(8, Math.max(2, (Array.isArray(value) ? value.length : 0) + 1));
    area.placeholder = "One value per line";
    area.value = Array.isArray(value) ? value.join("\n") : "";
    area.addEventListener("change", () =>
      set(
        area.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    );
    return area;
  }
  if (types.includes("array") || types.includes("object")) {
    const area = el("textarea", "json");
    area.rows = 6;
    area.spellcheck = false;
    area.value = JSON.stringify(value ?? (types.includes("array") ? [] : {}), null, 2);
    const error = el("div", "error");
    area.addEventListener("change", () => {
      try {
        set(JSON.parse(area.value || (types.includes("array") ? "[]" : "{}")));
        error.textContent = "";
      } catch {
        error.textContent = "This is not valid JSON.";
      }
    });
    const wrap = el("div");
    wrap.append(area, error);
    return wrap;
  }
  if (property.format === "color") {
    const wrap = el("div", "color-row");
    const picker = el("input");
    picker.type = "color";
    picker.value = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#22b8cf";
    const text = el("input");
    text.type = "text";
    text.value = typeof value === "string" ? value : "";
    text.placeholder = "Theme color";
    picker.addEventListener("change", () => {
      text.value = picker.value;
      set(picker.value);
    });
    text.addEventListener("change", () => set(text.value.trim()));
    const reset = el("button", "link", "Use theme color");
    reset.type = "button";
    reset.addEventListener("click", () => set(""));
    wrap.append(picker, text, reset);
    return wrap;
  }
  const input = el("input");
  input.type = "text";
  input.value = typeof value === "string" ? value : "";
  input.addEventListener("change", () => set(input.value));
  return input;
}

function settingRow(key: string, property: Property, data: Init): HTMLElement {
  const row = el("div", "setting");
  row.dataset.key = key;
  const header = el("div", "setting-header");
  const name = key
    .slice("phew.".length)
    .split(".")
    .map((part) => part.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()))
    .join(": ");
  const label = el("span", "name", name);
  // The key of the setting, for settings.json, shows on hover instead of taking a line.
  label.title = key;
  header.append(label);
  if (data.modified.includes(key)) {
    header.append(el("span", "badge", "Modified"));
    const reset = el("button", "link", "Reset");
    reset.type = "button";
    reset.addEventListener("click", () => vscode.postMessage({ type: "reset", key }));
    header.append(reset);
  }
  // Two columns: what the setting does on the left, its control on the right; long controls take the full row.
  const info = el("div", "setting-info");
  info.append(header, description(property.markdownDescription ?? property.description));
  const input = control(key, property, data.values[key]);
  const wide =
    input.tagName === "TEXTAREA" || input.querySelector?.("textarea") !== null || input.classList.contains("color-row");
  row.classList.toggle("wide", wide);
  const side = el("div", "setting-control");
  side.append(input);
  row.append(info, side);
  return row;
}

function render(data: Init): void {
  const focus = app.dataset.focus;
  app.replaceChildren();
  const top = el("header", "top");
  const title = el("div", "brand");
  const logo = el("img", "brand-logo");
  logo.src = document.body.dataset.icon ?? "";
  logo.alt = "";
  title.append(logo, el("h1", undefined, "Settings"));
  const searchBox = el("label", "search-box");
  searchBox.append(iconNode("search"));
  const search = el("input", "search");
  search.type = "search";
  search.placeholder = "Search settings";
  search.setAttribute("aria-label", "Search settings");
  searchBox.append(search);
  search.value = filter;
  search.addEventListener("input", () => {
    filter = search.value.toLowerCase();
    applyFilter();
  });
  const json = el("button", "icon-button");
  json.type = "button";
  json.title = "Open settings.json";
  json.setAttribute("aria-label", "Open settings.json");
  json.append(iconNode("file"), el("span", undefined, "settings.json"));
  json.addEventListener("click", () => vscode.postMessage({ type: "openJson" }));
  top.append(title, searchBox, json);
  app.append(top);

  const nav = el("nav");
  const main = el("main");
  const sections: [string, HTMLElement][] = [];

  modelsSection.setModels(data.models);
  sections.push(["Models", modelsSection.root]);

  for (const category of data.categories) {
    if (Object.keys(category.properties).filter((key) => !managedElsewhere.has(key)).length === 0) continue;
    const section = el("section", "card");
    section.id = slug(category.title);
    section.append(sectionHeader(category.title));
    if (category.title === "Commits") {
      const identity = el("div", "identity");
      identity.append(el("strong", undefined, "How commits look now"), el("p", undefined, data.identity));
      section.append(identity);
    }
    if (category.title === "Assistant")
      section.append(
        button("Open the assistant card", () => vscode.postMessage({ type: "command", command: "phew.editAssistant" })),
      );
    if (category.title === "Code Index")
      section.append(
        el("p", "hint", `Index: ${data.index}`),
        button("Rebuild index", () => vscode.postMessage({ type: "command", command: "phew.rebuildIndex" })),
      );
    if (category.title.startsWith("Memory")) {
      const memory = el("div", "identity");
      memory.append(el("strong", undefined, `Project memory (${data.memory.length} notes)`));
      const list = el("ul");
      for (const note of data.memory.slice(-10)) list.append(el("li", undefined, note));
      memory.append(
        list,
        button("Open memory file", () => vscode.postMessage({ type: "command", command: "phew.openMemory" })),
      );
      section.append(memory);
    }
    for (const [key, property] of Object.entries(category.properties)) {
      // The Models section above manages these two; settings.json still has them.
      if (managedElsewhere.has(key)) continue;
      section.append(settingRow(key, property, data));
    }
    sections.push([category.title, section]);
  }

  const statistics = el("section", "card");
  statistics.id = "statistics";
  statistics.append(sectionHeader("Statistics"), el("pre", "stats", data.stats));
  statistics.append(
    button("Open Phew Wrapped", () => vscode.postMessage({ type: "command", command: "phew.showWrapped" })),
    button("Open the getting started guide", () =>
      vscode.postMessage({ type: "command", command: "phew.openWalkthrough" }),
    ),
  );
  sections.push(["Statistics", statistics]);

  // The menu groups the sections, with an icon for each. The page shows the sections in the same order.
  const links = new Map<string, HTMLAnchorElement>();
  const byGroup = new Map<string, [string, HTMLElement][]>();
  for (const entry of sections) {
    const group = sectionInfo(entry[0]).group;
    byGroup.set(group, [...(byGroup.get(group) ?? []), entry]);
  }
  const ordered: [string, HTMLElement][] = [];
  for (const group of [...groupOrder, ...[...byGroup.keys()].filter((name) => !groupOrder.includes(name))]) {
    const entries = byGroup.get(group);
    if (!entries) continue;
    nav.append(el("div", "nav-group", group));
    for (const [name, section] of entries) {
      const link = el("a");
      link.href = `#${section.id}`;
      link.title = name;
      link.append(iconNode(sectionInfo(name).icon), el("span", "nav-label", sectionInfo(name).short ?? name));
      link.addEventListener("click", (event) => {
        event.preventDefault();
        // The clicked section is marked at once, also when the page cannot scroll it to the top.
        clickedUntil = Date.now() + 1500;
        markActive(section.id);
        section.scrollIntoView({ behavior: "smooth" });
      });
      links.set(section.id, link);
      nav.append(link);
      ordered.push([name, section]);
    }
  }
  for (const [, section] of ordered) main.append(section);
  let clickedUntil = 0;
  const markActive = (id: string) => {
    for (const [sectionId, link] of links) link.classList.toggle("active", sectionId === id);
  };
  // The section in view is the last one whose top is above the line under the header.
  const updateActive = () => {
    if (Date.now() < clickedUntil) return;
    const line = 96;
    let current = ordered[0]?.[1];
    for (const [, section] of ordered) if (section.getBoundingClientRect().top <= line) current = section;
    // At the bottom of the page, the last section counts as in view.
    const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (bottom && window.scrollY > 0) current = ordered[ordered.length - 1]?.[1];
    if (current) markActive(current.id);
  };
  if (onScroll) window.removeEventListener("scroll", onScroll);
  onScroll = () => requestAnimationFrame(updateActive);
  window.addEventListener("scroll", onScroll, { passive: true });
  requestAnimationFrame(updateActive);
  const layout = el("div", "layout");
  layout.append(nav, main);
  app.append(layout);
  applyFilter();
  if (focus) {
    app.dataset.focus = "";
    document.getElementById(focus)?.scrollIntoView();
  }
}

function applyFilter(): void {
  for (const row of app.querySelectorAll<HTMLElement>(".setting")) {
    row.hidden = filter !== "" && !row.textContent?.toLowerCase().includes(filter);
  }
  for (const section of app.querySelectorAll<HTMLElement>("section.card")) {
    const rows = [...section.querySelectorAll<HTMLElement>(".setting")];
    section.hidden =
      filter !== "" &&
      rows.length > 0 &&
      rows.every((row) => row.hidden) &&
      !section.textContent?.toLowerCase().includes(filter);
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as { type?: string; section?: string };
  if (modelsSection.receive(event.data as Record<string, unknown>)) return;
  if (message.type === "init") render(event.data as Init);
  else if (message.type === "focus" && message.section) document.getElementById(message.section)?.scrollIntoView();
});
vscode.postMessage({ type: "ready" });
vscode.postMessage({ type: "providers" });
