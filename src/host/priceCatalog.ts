import type * as vscode from "vscode";
import { automaticPrice, type CatalogPrice, parseOpenRouterModels, vendorOf } from "../core/priceCatalog";
import type { ModelProfile } from "../providers/profile";

const catalogKey = "phew.priceCatalog";
const catalogUrl = "https://openrouter.ai/api/v1/models";

type Fetch = typeof fetch;

/** The local day, YYYY-MM-DD. */
const dayOf = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/**
 * Fills the prices of models by itself: from the public list of OpenRouter, at most once a day, and only when some
 * model can use it. A price that the user typed is never changed. Only the public list is downloaded: no key and
 * nothing about the user goes to OpenRouter.
 */
export class PriceCatalogService {
  private running: Promise<number> | undefined;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly models: {
      profiles(): { profiles: readonly ModelProfile[] };
      update(id: string, changes: Partial<ModelProfile>): Promise<void>;
    },
    private readonly log: vscode.LogOutputChannel,
    private readonly fetchFunction: Fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Updates the prices that are not the user's; returns how many changed. One update at a time. */
  apply(): Promise<number> {
    this.running ??= this.update().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async update(): Promise<number> {
    const today = dayOf(this.now());
    const profiles = this.models.profiles().profiles;
    // The catalog is needed only for a model with a vendor, whose price is not the user's.
    const needsCatalog = profiles.some((profile) => {
      const vendor = vendorOf(profile);
      return vendor && vendor !== "local" && (!profile.price || (profile.price.source ?? "user") !== "user");
    });
    const catalog = needsCatalog ? await this.catalog(today) : [];
    let changed = 0;
    for (const profile of profiles) {
      const price = automaticPrice(profile, catalog, today);
      if (!price || samePrice(profile.price, price)) continue;
      await this.models.update(profile.id, { price });
      changed++;
    }
    if (changed > 0) this.log.info(`Prices: updated ${changed} model${changed === 1 ? "" : "s"} from the catalog.`);
    return changed;
  }

  /** The catalog of today: from the memory, or downloaded once; the last one when the download fails. */
  private async catalog(today: string): Promise<CatalogPrice[]> {
    const saved = this.memento.get<{ day: string; prices: CatalogPrice[] }>(catalogKey);
    if (saved?.day === today && saved.prices.length > 0) return saved.prices;
    try {
      const response = await this.fetchFunction(catalogUrl, {
        headers: { Accept: "application/json", "User-Agent": "Phew" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`the catalog answered ${response.status}`);
      const prices = parseOpenRouterModels(await response.json());
      if (prices.length === 0) throw new Error("the catalog has no prices");
      await this.memento.update(catalogKey, { day: today, prices });
      return prices;
    } catch (error) {
      this.log.warn(`Prices: the catalog is not available: ${error instanceof Error ? error.message : String(error)}`);
      return saved?.prices ?? [];
    }
  }
}

/** True when two prices are the same, so the settings are not written again. */
function samePrice(current: ModelProfile["price"], next: NonNullable<ModelProfile["price"]>): boolean {
  return (
    current !== undefined &&
    current.input === next.input &&
    current.output === next.output &&
    current.cachedInput === next.cachedInput &&
    current.source === next.source
  );
}
