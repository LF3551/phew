/**
 * The first-run card of the chat: what can run right away on this computer, what is free to start,
 * and the private option. It only points to the setup page; it never downloads anything.
 * The free-tier facts were checked on the provider pages in November 2026.
 */

/** The facts about a provider that the card needs (a part of ProviderStatus). */
export interface ProviderFacts {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly keyEnv?: string;
  readonly envFound: boolean;
  readonly available?: boolean;
  readonly note?: string;
  readonly piKey?: boolean;
}

export interface SetupOption {
  /** The preset id; the button opens the setup page with this provider selected. */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly kind: "ready" | "free" | "private";
}

const freeDetails: Readonly<Record<string, string>> = {
  copilot: "Sign in to GitHub in VS Code. The free Copilot plan is enough to start, with no key.",
  gemini:
    "A free key from Google AI Studio, with no card. On the free tier, Google may use your requests to improve its products.",
  openrouter: "Free models with a free key: 50 requests a day, enough to try Phew.",
};

/** The setup page says "GitHub Copilot and other VS Code models"; the card keeps it short. */
const labelOf = (provider: ProviderFacts) => (provider.id === "copilot" ? "GitHub Copilot" : provider.label);

/** The options of the first-run card, the ones that are ready first. */
export function setupOptions(providers: readonly ProviderFacts[], copilotPossible: boolean): SetupOption[] {
  const ready: SetupOption[] = [];
  const readyIds = new Set<string>();
  for (const provider of providers) {
    let detail: string | undefined;
    if (provider.id === "copilot" && provider.available)
      detail = `${provider.note ?? "Models"} from your GitHub Copilot plan, also the free one. No key.`;
    else if (provider.group === "Local" && provider.available)
      detail = `${provider.note ?? "Running"}. Private: your code stays on this computer.`;
    else if (provider.envFound && provider.keyEnv) detail = `Key found in $${provider.keyEnv}.`;
    else if (provider.piKey) detail = "Token found in the settings of Pi.";
    if (!detail) continue;
    ready.push({ id: provider.id, label: labelOf(provider), detail, kind: "ready" });
    readyIds.add(provider.id);
  }

  const known = new Map(providers.map((provider) => [provider.id, provider]));
  const free: SetupOption[] = [];
  for (const id of ["copilot", "gemini", "openrouter"]) {
    const provider = known.get(id);
    if (!provider || readyIds.has(id)) continue;
    if (id === "copilot" && !copilotPossible) continue;
    free.push({ id, label: labelOf(provider), detail: freeDetails[id] ?? "", kind: "free" });
  }

  const localRunning = ready.some((option) => known.get(option.id)?.group === "Local");
  const ollama = known.get("ollama");
  const privateOption: SetupOption[] =
    localRunning || !ollama
      ? []
      : [
          {
            id: "ollama",
            label: ollama.label,
            detail: "Runs on your computer, so your code stays there. Install Ollama and a model of a few GB.",
            kind: "private",
          },
        ];

  return [...ready.slice(0, 4), ...free, ...privateOption];
}
