/**
 * The prices of models, so the cost and the monthly budget work without typing prices. OpenRouter publishes the
 * prices of almost every model, also of Anthropic, OpenAI, and Google, at the price of the provider. Phew takes a
 * price only for an exact match of the model; a price that the user typed always wins and is never overwritten.
 */

/** A price in US dollars per one million tokens. */
export interface CatalogPrice {
  readonly id: string;
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
}

/** The prices from the public list of OpenRouter (/api/v1/models), which gives US dollars per token. */
export function parseOpenRouterModels(json: unknown): CatalogPrice[] {
  const data = typeof json === "object" && json !== null ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const perMillion = (value: unknown) => {
    const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
    return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000 * 10_000) / 10_000 : undefined;
  };
  const prices: CatalogPrice[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const { id, pricing } = item as { id?: unknown; pricing?: Record<string, unknown> };
    if (typeof id !== "string" || !pricing) continue;
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    // OpenRouter marks "variable" prices with -1, and router models with no price: those are not prices.
    if (input === undefined || output === undefined) continue;
    const cachedInput = perMillion(pricing.input_cache_read);
    prices.push({ id, input, output, ...(cachedInput !== undefined && cachedInput > 0 ? { cachedInput } : {}) });
  }
  return prices;
}

/**
 * The vendor prefix of OpenRouter for a provider, or "local" for a model on this computer. Only vendors that serve
 * their models on OpenRouter at their own price: DeepSeek, for example, is also served by other hosts at other prices.
 */
export function vendorOf(profile: { readonly provider: string; readonly baseUrl: string }): string | undefined {
  let host = "";
  try {
    host = new URL(profile.baseUrl).hostname;
  } catch {
    // An address that does not parse has no vendor.
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(host)) return "local";
  if (profile.provider === "anthropic") return host.endsWith("anthropic.com") ? "anthropic" : undefined;
  if (profile.provider === "gemini") return host.endsWith("googleapis.com") ? "google" : undefined;
  const vendors: readonly [RegExp, string][] = [
    [/(^|\.)openrouter\.ai$/, "openrouter"],
    [/(^|\.)openai\.com$/, "openai"],
    [/(^|\.)mistral\.ai$/, "mistralai"],
    [/(^|\.)x\.ai$/, "x-ai"],
  ];
  return vendors.find(([pattern]) => pattern.test(host))?.[1];
}

/** A model name in one form for both catalogs: "claude-sonnet-4.5" and "claude-sonnet-4-5" are the same. */
const normalize = (name: string) => name.toLowerCase().replace(/:.*$/, "").replace(/[._]/g, "-");
/** "claude-haiku-4-5-20251001" is "claude-haiku-4-5": a dated snapshot has the price of its model. */
const undated = (name: string) => name.replace(/-(20\d{6}|\d{4}-\d{2}-\d{2}|latest)$/, "");

/**
 * The price of a model, only when one entry of the catalog matches it exactly (also without a date at the end).
 * Two or no matches give no price: a wrong price looks right, which is worse than none.
 */
export function matchPrice(
  model: string,
  vendor: string | undefined,
  catalog: readonly CatalogPrice[],
): CatalogPrice | undefined {
  if (!vendor || vendor === "local") return undefined;
  if (vendor === "openrouter") return catalog.find((entry) => entry.id === model);
  const candidates = catalog.filter((entry) => entry.id.startsWith(`${vendor}/`) && !entry.id.includes(":"));
  const name = (entry: CatalogPrice) => normalize(entry.id.slice(vendor.length + 1));
  for (const wanted of [normalize(model), undated(normalize(model))]) {
    const found = candidates.filter((entry) => name(entry) === wanted);
    if (found.length === 1) return found[0];
    if (found.length > 1) return undefined;
  }
  return undefined;
}

/** Where a price came from: the user, the provider, the catalog of OpenRouter, or a model on this computer. */
export type PriceSource = "user" | "provider" | "catalog" | "local";

/** The price that Phew sets by itself for a model, or undefined to leave it as it is. A price of the user stays. */
export function automaticPrice(
  profile: {
    readonly provider: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly price?: { readonly source?: PriceSource };
  },
  catalog: readonly CatalogPrice[],
  today: string,
): { input: number; output: number; cachedInput?: number; source: PriceSource; checked: string } | undefined {
  // A price without a source was typed before Phew knew sources: it is the price of the user too.
  if (profile.price && (profile.price.source ?? "user") === "user") return undefined;
  const vendor = vendorOf(profile);
  if (vendor === "local") return { input: 0, output: 0, source: "local", checked: today };
  const found = matchPrice(profile.model, vendor, catalog);
  if (!found) return undefined;
  return {
    input: found.input,
    output: found.output,
    ...(found.cachedInput !== undefined ? { cachedInput: found.cachedInput } : {}),
    source: vendor === "openrouter" ? "provider" : "catalog",
    checked: today,
  };
}
