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
  price: { input: number; output: number } | null;
  api: "chat" | "responses" | null;
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
    model: "",
    name: "",
    filter: "",
  };
  private loaded: ModelInfo[] | undefined;
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
    const style = providerStyle(model.provider);
    const badge = el("span", "provider-badge", style.badge);
    badge.style.setProperty("--provider-color", style.color);
    badge.title = model.provider;
    const title = el("div", "model-title");
    const suffix = ` · ${model.model}`;
    const name =
      model.name.endsWith(suffix) && model.name.length > suffix.length
        ? model.name.slice(0, -suffix.length)
        : model.name;
    const nameRow = el("div", "model-name-row");
    nameRow.append(el("strong", "model-name", name));
    if (model.active) nameRow.append(el("span", "tag accent", "In use"));
    const facts = el("div", "facts");
    const parts = [model.model, model.provider];
    if (model.contextWindow) parts.push(`${formatTokens(model.contextWindow)} context`);
    facts.append(el("span", undefined, parts.join(" · ")));
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
    if (!model.active)
      actions.append(button("Use", () => this.post({ type: "useModel", id: model.id }), "primary small"));
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
    field("Model", text("model", model.model), "The exact model name of the provider.");
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
    prices.append(priceIn, priceOut);
    field(
      "Price",
      prices,
      "US dollars per million tokens, for the cost display and budget. Check the current prices of your provider.",
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
        form.append(
          el(
            "p",
            "hint",
            "Stored in the VS Code secret storage on this computer. Phew never writes it to the settings.",
          ),
        );
      }
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

  private toggle(key: string): void {
    if (this.open.has(key)) this.open.delete(key);
    else this.open.add(key);
    this.render();
  }
}

/** The badge of a provider, by its display name: the same letters and colors as the model menu of the chat. */
function providerStyle(provider: string): { badge: string; color: string } {
  const name = provider.toLowerCase();
  if (name.includes("anthropic")) return { badge: "A", color: "#d97757" };
  if (name.includes("gemini") || name.includes("google")) return { badge: "G", color: "#4285f4" };
  if (name.includes("vs code")) return { badge: "VS", color: "#3794ff" };
  return { badge: "O", color: "#10a37f" };
}
