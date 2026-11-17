import { renderMarkdown } from "./markdown";

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface Property {
  type?: string | string[];
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
  models: { id: string; name: string; detail: string; active: boolean }[];
  identity: string;
  index: string;
  memory: string[];
  stats: string;
}

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;
let filter = "";

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

function control(key: string, property: Property, value: unknown): HTMLElement {
  const types = Array.isArray(property.type) ? property.type : [property.type ?? "string"];
  const set = (next: unknown) => vscode.postMessage({ type: "set", key, value: next });
  if (property.enum) {
    const select = el("select");
    property.enum.forEach((option, index) => {
      const item = el("option", undefined, String(option));
      item.value = String(option);
      if (property.enumDescriptions?.[index]) item.title = property.enumDescriptions[index];
      item.selected = option === value;
      select.append(item);
    });
    select.addEventListener("change", () => set(property.enum?.find((option) => String(option) === select.value)));
    const wrap = el("div", "enum");
    wrap.append(select);
    const index = property.enum.indexOf(value);
    if (index >= 0 && property.enumDescriptions?.[index])
      wrap.append(el("div", "hint", property.enumDescriptions[index]));
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
  header.append(el("span", "name", name));
  if (data.modified.includes(key)) {
    header.append(el("span", "badge", "Modified"));
    const reset = el("button", "link", "Reset");
    reset.type = "button";
    reset.addEventListener("click", () => vscode.postMessage({ type: "reset", key }));
    header.append(reset);
  }
  row.append(
    header,
    description(property.markdownDescription ?? property.description),
    control(key, property, data.values[key]),
  );
  row.append(el("div", "key", key));
  return row;
}

function render(data: Init): void {
  const focus = app.dataset.focus;
  app.replaceChildren();
  const top = el("header", "top");
  const title = el("h1", undefined, "Phew Settings");
  const search = el("input", "search");
  search.type = "search";
  search.placeholder = "Search settings";
  search.value = filter;
  search.addEventListener("input", () => {
    filter = search.value.toLowerCase();
    applyFilter();
  });
  top.append(
    title,
    search,
    button("Open settings.json", () => vscode.postMessage({ type: "openJson" })),
  );
  app.append(top);

  const nav = el("nav");
  const main = el("main");
  const sections: [string, HTMLElement][] = [];

  const models = el("section", "card");
  models.id = "models";
  models.append(el("h2", undefined, "Models"));
  models.append(
    description(
      "Phew works with OpenAI, Anthropic, Gemini, Azure, Mistral, xAI, DeepSeek, Groq, OpenRouter, local models, and GitHub Copilot. API keys are stored in the VS Code secret storage.",
    ),
  );
  for (const model of data.models) {
    const row = el("div", `model${model.active ? " active" : ""}`);
    const info = el("div");
    info.append(el("strong", undefined, `${model.active ? "✓ " : ""}${model.name}`), el("div", "hint", model.detail));
    const actions = el("div", "actions");
    if (!model.active) actions.append(button("Use", () => vscode.postMessage({ type: "useModel", id: model.id })));
    actions.append(button("Test", () => vscode.postMessage({ type: "testModel", id: model.id })));
    row.append(info, actions);
    models.append(row);
  }
  if (data.models.length === 0) models.append(el("p", "hint", "No models yet."));
  const modelActions = el("div", "actions");
  modelActions.append(
    button("Add model", () => vscode.postMessage({ type: "command", command: "phew.addModel" }), true),
    button("Manage models", () => vscode.postMessage({ type: "command", command: "phew.manageModels" })),
  );
  models.append(modelActions);
  sections.push(["Models", models]);

  for (const category of data.categories) {
    if (Object.keys(category.properties).length === 0) continue;
    const section = el("section", "card");
    section.id = slug(category.title);
    section.append(el("h2", undefined, category.title));
    if (category.title === "Commits") {
      const identity = el("div", "identity");
      identity.append(el("strong", undefined, "How commits look now"), el("p", undefined, data.identity));
      section.append(identity);
    }
    if (category.title === "Code Index")
      section.append(
        el("p", "hint", `Index: ${data.index}`),
        button("Rebuild index", () => vscode.postMessage({ type: "command", command: "phew.rebuildIndex" })),
      );
    if (category.title === "Memory and Modes") {
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
    for (const [key, property] of Object.entries(category.properties)) section.append(settingRow(key, property, data));
    sections.push([category.title, section]);
  }

  const statistics = el("section", "card");
  statistics.id = "statistics";
  statistics.append(el("h2", undefined, "Statistics"), el("pre", "stats", data.stats));
  statistics.append(
    button("Open the getting started guide", () =>
      vscode.postMessage({ type: "command", command: "phew.openWalkthrough" }),
    ),
  );
  sections.push(["Statistics", statistics]);

  for (const [name, section] of sections) {
    const link = el("a", undefined, name);
    link.href = `#${section.id}`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      section.scrollIntoView({ behavior: "smooth" });
    });
    nav.append(link);
    main.append(section);
  }
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
  if (message.type === "init") render(event.data as Init);
  else if (message.type === "focus" && message.section) document.getElementById(message.section)?.scrollIntoView();
});
vscode.postMessage({ type: "ready" });
