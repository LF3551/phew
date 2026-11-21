import { modelMaker } from "../core/modelLabels";
import type { ModelPlanView } from "../shared/protocol";
import { planRingNode } from "./planRing";
import { iconNode, sectionHeader } from "./settingsParts";
/** The Models section of the settings page: connected models and a guided form to connect a new one. */

export interface ProviderItem {
  id: string;
  label: string;
  group: string;
  description: string;
  needsKey: boolean;
  keyUrl?: string;
  keyEnv?: string;
  envFound: boolean;
  askBaseUrl?: string;
  baseUrl: string;
  modelHint: string;
  available?: boolean;
  note?: string;
  piKey?: boolean;
}

export interface ModelItem {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  active: boolean;
  needsKey: boolean;
  key: "saved" | "env" | "command" | "none";
  keyEnv?: string;
  temperature: number | null;
  maxTokens: number | null;
  contextWindow: number | null;
  price: { input: number; output: number; source?: "user" | "provider" | "catalog" | "local"; checked?: string } | null;
  /** A monthly budget in US dollars, and what Phew spent of it this month. */
  budget?: number | null;
  spent?: number;
  api: "chat" | "responses" | null;
  /** The id of the model that takes over when this one runs out of quota. */
  fallback: string | null;
  /** The plan of the model, when its provider tells it. */
  plan?: ModelPlanView | null;
  /** Show the plan next to the model. */
  showPlan?: boolean;
  /** How the provider tells its plan: an official API, the address of Copilot, or not at all. */
  planSource?: "official" | "copilot" | null;
}

interface TestResult {
  ok: boolean;
  toolCalling: boolean;
  milliseconds: number;
  message: string;
}

interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  endpoints?: string[];
}

type Post = (message: Record<string, unknown>) => void;

const groupTitles: Record<string, string> = {
  Editor: "No API key needed",
  Cloud: "Cloud providers",
  Gateway: "Gateways and custom APIs",
  Local: "On your computer",
};

const groupOrder = ["Editor", "Cloud", "Local", "Gateway"];

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

function button(
  label: string,
  onClick: () => void,
  /** "primary", "secondary", "link", or "ghost", with "small", "icon-only", or "danger". */
  kind = "secondary",
): HTMLButtonElement {
  const node = el("button", kind, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function input(type: string, value: string, placeholder = ""): HTMLInputElement {
  const node = el("input");
  node.type = type;
  node.value = value;
  node.placeholder = placeholder;
  return node;
}

function formatTokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}k`;
}

function testLine(result: TestResult | "running" | undefined): HTMLElement {
  if (!result) return el("span");
  if (result === "running") return el("span", "status running", "⋯ Testing the connection…");
  if (result.ok && result.toolCalling)
    return el("span", "status ok", `✓ Works · ${result.milliseconds} ms · tools work`);
  if (result.ok)
    return el(
      "span",
      "status warn",
      `⚠ Answers, but ${result.message.charAt(0).toLowerCase()}${result.message.slice(1)}`,
    );
  return el("span", "status error", `✕ ${result.message}`);
}

/** The API addresses of the GitHub Copilot plans. Phew tries them in turn when the plan is not chosen. */
const copilotPlans: readonly [value: string, label: string][] = [
  ["", "Find my plan automatically"],
  ["https://api.individual.githubcopilot.com", "Individual: Free, Pro, Pro+, or Max"],
  ["https://api.business.githubcopilot.com", "Business"],
  ["https://api.enterprise.githubcopilot.com", "Enterprise"],
  ["custom", "Another address: GitHub Enterprise on GHE.com, or a proxy"],
];

/** Models that cannot chat: they are not chosen by default when the suggested model is missing. */
const notForChat = /embed|tts|audio|transcri|whisper|dall-e|imagen|image-|veo|moderation|rerank|aqa|-live/i;

export class ModelsSection {
  readonly root = el("section", "card models-section");
  private providers: ProviderItem[] = [];
  private models: ModelItem[] = [];
  private tests = new Map<string, TestResult | "running">();
  private open = new Set<string>();
  private selected: ProviderItem | undefined;
  /** A provider to select as soon as the list of providers arrives. */
  private wanted: string | undefined;
  private form = {
    apiKey: "",
    useEnv: true,
    usePi: false,
    baseUrl: "",
    foundBaseUrl: "",
    customUrl: false,
    model: "",
    name: "",
    filter: "",
  };
  private loaded: ModelInfo[] | undefined;
  /** The models of a connected provider, to choose another one in the card of a model. */
  private catalogs = new Map<
    string,
    { state: "loading" | "ready" | "error"; models: ModelInfo[]; filter: string; error?: string; choosing?: string }
  >();
  private loading = false;
  private connecting = false;
  private error = "";
  private requestCounter = 0;
  private pending = "";

  constructor(private readonly post: Post) {
    this.root.id = "models";
  }

  setModels(models: ModelItem[]): void {
    this.models = models;
    if (models.length === 0 && !this.selected) this.root.classList.add("empty");
    this.render();
  }

  receive(message: Record<string, unknown>): boolean {
    switch (message.type) {
      case "providers":
        this.providers = message.items as ProviderItem[];
        this.render();
        if (this.wanted) this.selectProvider(this.wanted);
        return true;
      case "selectProvider":
        if (typeof message.id === "string") this.selectProvider(message.id);
        return true;
      case "profileModels": {
        const id = String(message.id ?? "");
        const catalog = this.catalogs.get(id);
        if (!catalog) return true;
        if (message.ok) {
          catalog.state = "ready";
          catalog.models = (message.models as ModelInfo[]) ?? [];
        } else {
          catalog.state = "error";
          catalog.choosing = undefined;
          catalog.error = String(message.error ?? "Phew could not load the models.");
        }
        this.render();
        return true;
      }
      case "models":
        if (message.requestId !== this.pending) return true;
        this.loading = false;
        if (message.ok) {
          this.loaded = message.models as ModelInfo[];
          if (typeof message.baseUrl === "string" && message.baseUrl) this.form.foundBaseUrl = message.baseUrl;
          this.error = this.loaded.length === 0 ? "The provider returned no models. Type the model name below." : "";
          if (!this.form.model && this.loaded.length > 0) {
            this.form.model =
              this.loaded.find((model) => model.id === this.selected?.modelHint)?.id ??
              this.loaded.find((model) => !notForChat.test(model.id))?.id ??
              this.loaded[0].id;
          }
        } else {
          this.loaded = [];
          this.error = String(message.error ?? "Phew could not load the models.");
        }
        this.render();
        return true;
      case "created":
        if (message.requestId !== this.pending) return true;
        this.connecting = false;
        if (message.ok) {
          this.tests.set(String(message.id), message.test as TestResult);
          this.selected = undefined;
          this.loaded = undefined;
          this.error = "";
          this.form = {
            apiKey: "",
            useEnv: true,
            usePi: false,
            baseUrl: "",
            foundBaseUrl: "",
            customUrl: false,
            model: "",
            name: "",
            filter: "",
          };
        } else this.error = String(message.error ?? "Phew could not connect the model.");
        this.render();
        return true;
      case "testResult":
        this.tests.set(String(message.id), message.result as TestResult);
        this.render();
        return true;
      default:
        return false;
    }
  }

  render(): void {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    this.root.replaceChildren();
    this.root.append(sectionHeader("Models"));
    this.root.append(
      el(
        "p",
        "hint",
        "Connect one or more models. Phew keeps API keys in the VS Code secret storage, never in the settings files.",
      ),
    );
    if (this.models.length > 0) {
      this.root.append(el("h3", undefined, "Your models"));
      for (const model of this.models) this.root.append(this.modelCard(model));
    }
    this.root.append(
      el("h3", undefined, this.models.length > 0 ? "Connect another model" : "Connect your first model"),
    );
    this.root.append(this.providerGrid());
    if (this.selected) this.root.append(this.setupForm(this.selected));
    if (focused) (this.root.querySelector(`[data-focus-key="${focused}"]`) as HTMLElement | null)?.focus();
  }

  private modelCard(model: ModelItem): HTMLElement {
    // One clear row: the provider, the name, the facts, and the actions by weight; the rest is behind ⋯.
    const card = el("div", `model-card${model.active ? " active" : ""}`);
    const header = el("div", "model-header");
    const style = modelMaker({ provider: providerKind(model.provider), model: model.model });
    const badge = el("span", "provider-badge", style.badge);
    badge.style.setProperty("--provider-color", style.color);
    badge.title = style.label === model.provider ? style.label : `${style.label}, via ${model.provider}`;
    const title = el("div", "model-title");
    const suffix = ` · ${model.model}`;
    const name =
      model.name.endsWith(suffix) && model.name.length > suffix.length
        ? model.name.slice(0, -suffix.length)
        : model.name;
    const nameRow = el("div", "model-name-row");
    nameRow.append(el("strong", "model-name", name));
    if (model.active) {
      const tag = el("span", "tag accent", "Default");
      tag.title = "New chats start with this model. Each chat can choose its own in the menu under the input.";
      nameRow.append(tag);
    }
    const facts = el("div", "facts");
    const parts = [model.model, model.provider];
    if (model.contextWindow) parts.push(`${formatTokens(model.contextWindow)} context`);
    facts.append(el("span", undefined, parts.join(" · ")));
    // The plan: a ring with what is left, and the details in its tooltip.
    if (model.plan) {
      const plan = planRingNode(model.plan, true);
      plan.setAttribute("role", "img");
      plan.setAttribute("aria-label", model.plan.details.join(". "));
      facts.append(plan);
    }
    const fallback = this.models.find((item) => item.id === model.fallback && item.id !== model.id);
    if (fallback) {
      const line = el("span", "fallback-fact", `Fallback: ${fallback.name}`);
      line.title = `When ${model.name} runs out of quota or credit, or stays rate limited or overloaded, ${fallback.name} goes on with the task.`;
      facts.append(line);
    }
    if (model.needsKey) {
      facts.append(
        model.key === "saved"
          ? el("span", "tag ok", "Key saved")
          : model.key === "env"
            ? el("span", "tag ok", `Key from $${model.keyEnv}`)
            : model.key === "command"
              ? el("span", "tag ok", "Key from a command")
              : el("span", "tag error", "No API key"),
      );
    }
    title.append(nameRow, facts);
    header.append(badge, title);
    const actions = el("div", "model-actions");
    if (!model.active) {
      const use = button("Use", () => this.post({ type: "useModel", id: model.id }), "ghost small");
      use.title = "Use it in the chat in front and in new chats";
      actions.append(use);
    }
    actions.append(
      button(
        "Test",
        () => {
          this.tests.set(model.id, "running");
          this.render();
          this.post({ type: "testModel", id: model.id });
        },
        "ghost small",
      ),
    );
    if (model.needsKey)
      actions.append(
        button(
          this.open.has(`key:${model.id}`) ? "Cancel" : "Key",
          () => this.toggle(`key:${model.id}`),
          "ghost small",
        ),
      );
    const more = button(
      "",
      () => this.toggle(`more:${model.id}`),
      `ghost small icon-only${this.open.has(`more:${model.id}`) ? " pressed" : ""}`,
    );
    more.title = "Rename, settings, and more";
    more.setAttribute("aria-label", `More for ${name}`);
    more.append(iconNode("more"));
    const remove = button("", () => this.post({ type: "removeModel", id: model.id }), "ghost small icon-only danger");
    remove.title = "Remove this model";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.append(iconNode("trash"));
    actions.append(more, remove);
    header.append(actions);
    card.append(header);
    card.append(testLine(this.tests.get(model.id)));

    if (this.open.has(`key:${model.id}`)) {
      const row = el("div", "inline-form");
      const key = input("password", "", "Paste the new API key");
      key.dataset.focusKey = `key-${model.id}`;
      row.append(
        key,
        button(
          "Save key",
          () => {
            this.open.delete(`key:${model.id}`);
            this.tests.set(model.id, "running");
            this.post({ type: "setKey", id: model.id, key: key.value });
            this.render();
          },
          "primary",
        ),
      );
      card.append(row, el("p", "hint", "Leave it empty and save to delete the saved key."));
    }
    if (this.open.has(`more:${model.id}`)) card.append(this.advanced(model));
    return card;
  }

  private advanced(model: ModelItem): HTMLElement {
    const box = el("div", "advanced");
    const field = (label: string, control: HTMLElement, hint?: string) => {
      const row = el("label", "field");
      row.append(el("span", "field-label", label), control);
      if (hint) row.append(el("span", "hint", hint));
      box.append(row);
    };
    const text = (name: string, value: string) => {
      const control = input("text", value);
      control.addEventListener("change", () =>
        this.post({ type: "updateModel", id: model.id, field: name, value: control.value }),
      );
      return control;
    };
    const number = (name: string, value: number | null, placeholder: string, step = "any") => {
      const control = input("number", value === null ? "" : String(value), placeholder);
      control.step = step;
      control.addEventListener("change", () =>
        this.post({
          type: "updateModel",
          id: model.id,
          field: name,
          value: control.value === "" ? null : Number(control.value),
        }),
      );
      return control;
    };
    field("Name", text("name", model.name));
    // The model: typed, or chosen from the list of the provider with the saved key.
    const modelRow = el("div", "pair model-pick");
    const choose = button(
      this.catalogs.has(model.id) ? "Hide list" : "Choose…",
      () => {
        if (this.catalogs.has(model.id)) this.catalogs.delete(model.id);
        else {
          this.catalogs.set(model.id, { state: "loading", models: [], filter: "" });
          this.post({ type: "loadProfileModels", id: model.id });
        }
        this.render();
      },
      "ghost small",
    );
    choose.title = "Load the models of the provider and choose one";
    modelRow.append(text("model", model.model), choose);
    field("Model", modelRow, "The exact model name of the provider, or choose it from the list.");
    const catalog = this.catalogs.get(model.id);
    // After a switch, the card shows the new model and its test; the list closes.
    if (catalog?.choosing && catalog.choosing === model.model) this.catalogs.delete(model.id);
    else if (catalog) box.append(this.catalogView(model, catalog));
    field(
      "Context window",
      number("contextWindow", model.contextWindow, "Default", "1000"),
      "Tokens. For the context meter and automatic compaction.",
    );
    field(
      "Temperature",
      number("temperature", model.temperature, "Provider default"),
      "0 to 2. Empty uses the provider default.",
    );
    field("Max output tokens", number("maxTokens", model.maxTokens, "Provider default", "1"));
    // The plan: off by default; checked only when the user clicks it next to the model.
    if (model.planSource) {
      const row = el("label", "check-row");
      const box2 = input("checkbox", "");
      box2.checked = model.showPlan === true;
      box2.addEventListener("change", () =>
        this.post({ type: "updateModel", id: model.id, field: "showPlan", value: box2.checked }),
      );
      row.append(box2, el("span", undefined, "Show what is left of the plan next to the model"));
      box.append(row);
      box.append(
        el(
          "p",
          "hint",
          model.planSource === "copilot"
            ? "Phew checks only when you click the plan next to the model. GitHub has no official API for the quotas of Copilot, so Phew reads them from the address that Copilot itself uses, with your token."
            : "Phew checks only when you click the plan next to the model, through the official API of the provider.",
        ),
      );
    } else box.append(el("p", "hint", "This provider does not share its plan or what is left of it."));
    const others = this.models.filter((item) => item.id !== model.id);
    if (others.length > 0) {
      const select = el("select");
      select.dataset.focusKey = `fallback-${model.id}`;
      for (const [value, label] of [["", "None"], ...others.map((item) => [item.id, item.name])] as const) {
        const option = el("option", undefined, label);
        option.value = value;
        option.selected = (model.fallback ?? "") === value;
        select.append(option);
      }
      select.addEventListener("change", () =>
        this.post({ type: "updateModel", id: model.id, field: "fallback", value: select.value || null }),
      );
      field(
        "Fallback model",
        select,
        "Takes over a task when this model runs out of quota or credit, or stays rate limited or overloaded after all retries. A wrong key does not fall back.",
      );
    }
    if (model.api) {
      const select = el("select");
      for (const [value, label] of [
        ["chat", "Chat Completions (/chat/completions)"],
        ["responses", "Responses API (/responses)"],
      ]) {
        const option = el("option", undefined, label);
        option.value = value;
        option.selected = model.api === value;
        select.append(option);
      }
      select.addEventListener("change", () =>
        this.post({ type: "updateModel", id: model.id, field: "api", value: select.value }),
      );
      field("API format", select, "Newer OpenAI and GitHub Copilot GPT models need the Responses API.");
    }
    const priceIn = input("number", model.price ? String(model.price.input) : "", "Input $/1M");
    const priceOut = input("number", model.price ? String(model.price.output) : "", "Output $/1M");
    const savePrice = () =>
      this.post({
        type: "updateModel",
        id: model.id,
        field: "price",
        value:
          priceIn.value === "" || priceOut.value === ""
            ? null
            : { input: Number(priceIn.value), output: Number(priceOut.value) },
      });
    priceIn.addEventListener("change", savePrice);
    priceOut.addEventListener("change", savePrice);
    const prices = el("div", "pair");
    // Each field says what it is, also when it is filled.
    const priced = (caption: string, control: HTMLInputElement) => {
      const part = el("label", "price-part");
      part.append(el("span", "price-caption", caption), control);
      return part;
    };
    prices.append(priced("Input, $ per 1M", priceIn), priced("Output, $ per 1M", priceOut));
    // Where the price came from: a price of the user is never changed; one of the catalog is updated daily.
    const priceNote = el("p", "hint price-note");
    const source = model.price ? (model.price.source ?? "user") : undefined;
    const day = model.price?.checked
      ? new Date(`${model.price.checked}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "";
    priceNote.append(
      source === "user"
        ? "Your price: Phew never changes it. "
        : source === "catalog"
          ? `From the catalog of OpenRouter${day ? `, ${day}` : ""}. Phew updates it once a day; type a price to use your own.`
          : source === "provider"
            ? `From OpenRouter${day ? `, ${day}` : ""}, updated once a day.`
            : source === "local"
              ? "A model on this computer: free."
              : "No price found for this model. Type it from the pricing page of the provider, in US dollars per million tokens.",
    );
    if (source === "user") {
      const auto = button(
        "Use the catalog price",
        () => this.post({ type: "updateModel", id: model.id, field: "priceAuto", value: null }),
        "link",
      );
      auto.title = "Let Phew fill the price from the catalog of OpenRouter, when it has this model";
      priceNote.append(auto);
    }
    field("Price", prices);
    box.append(priceNote);
    const budget = number("budget", model.budget ?? null, "No budget", "1");
    field(
      "Monthly budget, US dollars",
      budget,
      model.budget
        ? `The ring next to the model shows what Phew spent of it this month: $${(model.spent ?? 0).toFixed(2)} so far.`
        : "With a budget, a ring next to the model shows what Phew spent of it this month.",
    );
    box.append(
      el("p", "hint", "Headers, query parameters, and extra request fields are in settings.json (phew.models)."),
    );
    return box;
  }

  private providerGrid(): HTMLElement {
    const wrapper = el("div");
    if (this.providers.length === 0) {
      wrapper.append(el("p", "hint", "Loading providers…"));
      return wrapper;
    }
    for (const group of groupOrder) {
      const items = this.providers.filter((provider) => provider.group === group);
      if (items.length === 0) continue;
      wrapper.append(el("h4", "group-title", groupTitles[group] ?? group));
      const grid = el("div", "provider-grid");
      for (const provider of items) {
        const card = el("button", `provider${this.selected?.id === provider.id ? " selected" : ""}`);
        card.type = "button";
        const badges = el("div", "badges");
        if (!provider.needsKey && provider.group !== "Local") badges.append(el("span", "tag ok", "No key"));
        if (provider.envFound) badges.append(el("span", "tag ok", `Key found: $${provider.keyEnv}`));
        else if (provider.piKey) badges.append(el("span", "tag ok", "Token found in Pi"));
        else if (provider.needsKey) badges.append(el("span", "tag", "API key"));
        if (provider.note) badges.append(el("span", `tag ${provider.available ? "ok" : ""}`, provider.note));
        card.append(
          el("strong", undefined, provider.label),
          el("span", "provider-description", provider.description),
          badges,
        );
        card.addEventListener("click", () => this.select(provider));
        grid.append(card);
      }
      wrapper.append(grid);
    }
    return wrapper;
  }

  /** Selects a provider for setup, for example from the first-run card of the chat. */
  selectProvider(id: string): void {
    const provider = this.providers?.find((item) => item.id === id);
    if (!provider) {
      this.wanted = id;
      return;
    }
    this.wanted = undefined;
    if (this.selected?.id !== id) this.select(provider);
    this.root.querySelector(".setup")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  private select(provider: ProviderItem): void {
    this.selected = this.selected?.id === provider.id ? undefined : provider;
    this.loaded = undefined;
    this.error = "";
    this.form = {
      apiKey: "",
      usePi: !provider.envFound && provider.piKey === true,
      foundBaseUrl: "",
      customUrl: false,
      useEnv: provider.envFound,
      baseUrl: provider.askBaseUrl || provider.group === "Local" ? provider.baseUrl : "",
      model: "",
      name: "",
      filter: "",
    };
    this.render();
    this.root.querySelector(".setup")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (this.selected && !provider.needsKey && provider.group !== "Gateway") this.loadModels();
  }

  private request(type: string, extra: Record<string, unknown> = {}): void {
    if (!this.selected) return;
    this.pending = `r${++this.requestCounter}`;
    const useEnv = this.form.useEnv && this.selected.envFound;
    const usePi = !useEnv && this.form.usePi && this.selected.piKey === true;
    this.post({
      type,
      requestId: this.pending,
      presetId: this.selected.id,
      apiKey: useEnv || usePi ? undefined : this.form.apiKey,
      useEnv,
      usePi,
      baseUrl: this.form.baseUrl || (type === "createModel" ? this.form.foundBaseUrl : "") || undefined,
      ...extra,
    });
  }

  private loadModels(): void {
    this.loading = true;
    this.error = "";
    this.request("loadModels");
    this.render();
  }

  private setupForm(provider: ProviderItem): HTMLElement {
    const form = el("div", "setup");
    form.append(el("h3", undefined, `Connect ${provider.label}`), el("p", "hint", provider.description));
    if (provider.id === "copilot") {
      form.append(
        el(
          "p",
          "notice info",
          "No API key is needed. Phew uses the models that your GitHub Copilot sign-in gives VS Code. To use your own key, choose OpenAI, Anthropic, Google Gemini, or another cloud provider below.",
        ),
      );
    }
    const needsTypedKey = () =>
      provider.needsKey && !(this.form.useEnv && provider.envFound) && !(this.form.usePi && provider.piKey);
    const load = button(
      this.loading ? "Loading models…" : this.loaded ? "Refresh list" : "Load models",
      () => this.loadModels(),
      this.loaded ? "secondary" : "primary",
    );
    const updateLoad = () => {
      load.disabled = this.loading || (needsTypedKey() && !this.form.apiKey.trim());
    };
    let step = 1;
    const stepTitle = (text: string) => form.append(el("div", "step", `${step++}. ${text}`));

    if (provider.group === "Local" && provider.available === false) {
      form.append(
        el(
          "p",
          "notice warn",
          provider.id === "ollama"
            ? "Ollama is not running on this computer. Install it from ollama.com, run `ollama pull qwen2.5-coder`, and click Load models again."
            : "The local server is not running. Start it, check the URL below, and click Load models.",
        ),
      );
    }

    if (provider.askBaseUrl || provider.group === "Local") {
      stepTitle(provider.askBaseUrl ?? "Server URL");
      const url = input("url", this.form.baseUrl, provider.baseUrl);
      url.dataset.focusKey = "url";
      url.addEventListener("input", () => {
        this.form.baseUrl = url.value;
      });
      form.append(url);
    }

    if (provider.needsKey) {
      stepTitle("API key");
      if (provider.envFound) {
        const label = el("label", "check");
        const box = input("checkbox", "");
        box.checked = this.form.useEnv;
        box.addEventListener("change", () => {
          this.form.useEnv = box.checked;
          this.render();
        });
        label.append(box, el("span", undefined, `Use $${provider.keyEnv} from your environment`));
        form.append(label);
      }
      if (provider.piKey && !(this.form.useEnv && provider.envFound)) {
        const label = el("label", "check");
        const box = input("checkbox", "");
        box.checked = this.form.usePi;
        box.addEventListener("change", () => {
          this.form.usePi = box.checked;
          this.render();
        });
        label.append(box, el("span", undefined, "Use the GitHub Copilot token of Pi (~/.pi/agent/auth.json)"));
        form.append(label);
      }
      if (!(this.form.useEnv && provider.envFound) && !(this.form.usePi && provider.piKey)) {
        const row = el("div", "inline-form");
        const key = input("password", this.form.apiKey, "Paste your API key");
        key.dataset.focusKey = "apiKey";
        key.addEventListener("input", () => {
          this.form.apiKey = key.value;
          updateLoad();
        });
        key.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && key.value.trim()) this.loadModels();
        });
        row.append(key);
        if (provider.keyUrl) {
          const link = el("a", "link", "Get a key ↗");
          link.href = provider.keyUrl;
          row.append(link);
        }
        form.append(row);
        if (provider.id === "copilot-token")
          form.append(
            el(
              "p",
              "hint",
              "Create the token with Get a key: Resource owner is your personal account, and under Permissions → Account, add Copilot Requests. The same token works in GitHub Copilot CLI.",
            ),
          );
        form.append(
          el(
            "p",
            "hint",
            "Stored in the VS Code secret storage on this computer. Phew never writes it to the settings.",
          ),
        );
      }
    }

    if (provider.id === "copilot-token") {
      stepTitle("Plan");
      const plan = el("select");
      for (const [value, label] of copilotPlans) {
        const option = el("option", undefined, label);
        option.value = value;
        plan.append(option);
      }
      plan.value = this.form.customUrl ? "custom" : this.form.baseUrl;
      plan.addEventListener("change", () => {
        this.form.customUrl = plan.value === "custom";
        this.form.baseUrl = this.form.customUrl ? "" : plan.value;
        this.loaded = undefined;
        this.form.foundBaseUrl = "";
        this.error = "";
        this.render();
      });
      form.append(plan);
      if (this.form.customUrl) {
        const url = input("url", this.form.baseUrl, "https://copilot-api.example.ghe.com");
        url.dataset.focusKey = "url";
        url.addEventListener("input", () => {
          this.form.baseUrl = url.value.trim();
        });
        form.append(
          url,
          el(
            "p",
            "hint",
            "The Copilot API address of your company. On GHE.com, it is on the subdomain of your enterprise; your admin knows it. The token must come from the same GitHub.",
          ),
        );
      } else if (!this.form.baseUrl)
        form.append(el("p", "hint", "Phew tries Individual, Business, and Enterprise and keeps the one that works."));
    }

    updateLoad();
    form.append(load);
    if (this.error) form.append(el("p", "notice error", this.error));

    if (this.loaded && this.form.foundBaseUrl && provider.id === "copilot-token") {
      const plan = /api\.([a-z]+)\.githubcopilot\.com/.exec(this.form.foundBaseUrl)?.[1] ?? "custom";
      form.append(el("p", "notice info", `Found your GitHub Copilot plan: ${plan} (${this.form.foundBaseUrl}).`));
    }
    if (this.loaded) {
      stepTitle("Choose a model");
      if (this.loaded.length > 0) {
        const filter = input("search", this.form.filter, `Search ${this.loaded.length} models`);
        filter.dataset.focusKey = "filter";
        filter.addEventListener("input", () => {
          this.form.filter = filter.value;
          this.renderList(list);
        });
        const list = el("div", "model-list");
        form.append(filter, list);
        this.renderList(list);
      }
      const manual = input(
        "text",
        this.form.model,
        provider.modelHint ? `Model name, for example ${provider.modelHint}` : "Model name",
      );
      manual.dataset.focusKey = "model";
      manual.addEventListener("input", () => {
        this.form.model = manual.value;
      });
      form.append(el("span", "hint", "Selected model (you can also type a name):"), manual);
      stepTitle("Name (optional)");
      const name = input("text", this.form.name, `${provider.label} · model`);
      name.dataset.focusKey = "name";
      name.addEventListener("input", () => {
        this.form.name = name.value;
      });
      form.append(name);
      const connect = button(
        this.connecting ? "Connecting and testing…" : "Connect and test",
        () => {
          if (!this.form.model.trim()) {
            this.error = "Choose or type a model.";
            this.render();
            return;
          }
          this.connecting = true;
          this.error = "";
          const info = this.loaded?.find((model) => model.id === this.form.model.trim());
          this.request("createModel", {
            model: this.form.model.trim(),
            name: this.form.name.trim() || undefined,
            contextWindow: info?.contextWindow,
            endpoints: info?.endpoints,
          });
          this.render();
        },
        "primary",
      );
      connect.disabled = this.connecting;
      form.append(connect);
    }
    const cancel = button(
      "Cancel",
      () => {
        this.selected = undefined;
        this.render();
      },
      "link",
    );
    form.append(cancel);
    return form;
  }

  private renderList(list: HTMLElement): void {
    const query = this.form.filter.toLowerCase();
    const items = (this.loaded ?? [])
      .filter((model) => `${model.id} ${model.label ?? ""}`.toLowerCase().includes(query))
      .slice(0, 200);
    list.replaceChildren(
      ...items.map((model) => {
        const row = el("label", `model-option${model.id === this.form.model ? " chosen" : ""}`);
        const radio = input("radio", model.id);
        radio.name = "model";
        radio.checked = model.id === this.form.model;
        radio.addEventListener("change", () => {
          this.form.model = model.id;
          const manual = this.root.querySelector<HTMLInputElement>('[data-focus-key="model"]');
          if (manual) manual.value = model.id;
          for (const option of list.querySelectorAll(".model-option")) option.classList.remove("chosen");
          row.classList.add("chosen");
        });
        row.append(radio, el("span", "model-id", model.id));
        if (model.label && model.label !== model.id) row.append(el("span", "hint", model.label));
        if (model.contextWindow) row.append(el("span", "hint", `${formatTokens(model.contextWindow)} context`));
        if (
          model.endpoints &&
          !model.endpoints.includes("/chat/completions") &&
          model.endpoints.some((item) => item.includes("/responses"))
        ) {
          row.append(el("span", "hint", "Responses API"));
        }
        return row;
      }),
    );
    if (items.length === 0) list.append(el("p", "hint", "No models match."));
  }

  /** The models of the provider of a connected model, with search; a click switches the model and tests it. */
  private catalogView(
    model: ModelItem,
    catalog: {
      state: "loading" | "ready" | "error";
      models: ModelInfo[];
      filter: string;
      error?: string;
      choosing?: string;
    },
  ): HTMLElement {
    const wrap = el("div", "model-catalog");
    if (catalog.state === "loading") {
      wrap.append(el("p", "hint", "Loading the models of the provider…"));
      return wrap;
    }
    if (catalog.state === "error") {
      wrap.append(el("p", "error", catalog.error ?? "Phew could not load the models."));
      return wrap;
    }
    if (catalog.models.length === 0) {
      wrap.append(el("p", "hint", "The provider lists no models. Type the name above."));
      return wrap;
    }
    // The provider knows the context of the model in use better than an old setting: one click takes it.
    const inUse = catalog.models.find((item) => item.id === model.model);
    if (inUse?.contextWindow && inUse.contextWindow !== model.contextWindow) {
      const note = el("p", "hint catalog-note");
      note.append(
        `The provider says ${formatTokens(inUse.contextWindow)} context for ${model.model}, the setting says ${
          model.contextWindow ? formatTokens(model.contextWindow) : "nothing"
        }. `,
      );
      const take = button(
        `Use ${formatTokens(inUse.contextWindow)}`,
        () => this.post({ type: "updateModel", id: model.id, field: "contextWindow", value: inUse.contextWindow }),
        "link",
      );
      note.append(take);
      wrap.append(note);
    }
    const search = input("search", catalog.filter, `Search ${catalog.models.length} models`);
    search.dataset.focusKey = `catalog-${model.id}`;
    search.setAttribute("aria-label", "Search the models");
    const list = el("div", "model-list");
    const fill = () => {
      const query = catalog.filter.toLowerCase();
      // The model in use first, then by name, with numbers in order (4.5, 4.6, 4.10).
      const name = (item: ModelInfo) => item.label || item.id;
      const items = catalog.models
        .filter((item) => `${item.id} ${item.label ?? ""}`.toLowerCase().includes(query))
        .sort(
          (a, b) =>
            Number(b.id === model.model) - Number(a.id === model.model) ||
            name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: "base" }),
        )
        .slice(0, 200);
      list.replaceChildren(
        ...items.map((item) => {
          const current = item.id === model.model;
          const row = el("button", `model-option${current ? " chosen" : ""}`);
          row.type = "button";
          row.disabled = current || catalog.choosing !== undefined;
          row.setAttribute("aria-pressed", String(current));
          // The readable name first; the exact id of the provider below it, small.
          const text = el("span", "model-option-text");
          const hasLabel = item.label && item.label !== item.id;
          text.append(el("span", "model-option-name", hasLabel ? (item.label as string) : item.id));
          if (hasLabel) text.append(el("span", "model-id", item.id));
          row.append(text);
          if (item.contextWindow) row.append(el("span", "hint model-option-context", formatTokens(item.contextWindow)));
          if (current) row.append(el("span", "tag ok", "In use"));
          if (catalog.choosing === item.id) row.append(el("span", "hint", "Switching and testing…"));
          row.addEventListener("click", () => {
            catalog.choosing = item.id;
            this.tests.set(model.id, "running");
            this.post({
              type: "switchProfileModel",
              id: model.id,
              model: item.id,
              ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
              ...(item.endpoints ? { endpoints: item.endpoints } : {}),
            });
            fill();
          });
          return row;
        }),
      );
      if (items.length === 0) list.append(el("p", "hint", "No models match."));
    };
    search.addEventListener("input", () => {
      catalog.filter = search.value;
      fill();
    });
    fill();
    wrap.append(search, list);
    return wrap;
  }

  private toggle(key: string): void {
    if (this.open.has(key)) this.open.delete(key);
    else this.open.add(key);
    this.render();
  }
}

/** The badge of a provider, by its display name: the same letters and colors as the model menu of the chat. */
/** The settings page gets the provider name; the badge needs its protocol. */
function providerKind(provider: string): "openai" | "anthropic" | "gemini" | "vscode" {
  const name = provider.toLowerCase();
  if (name.includes("anthropic")) return "anthropic";
  if (name.includes("gemini") || name.includes("google")) return "gemini";
  if (name.includes("vs code")) return "vscode";
  return "openai";
}
