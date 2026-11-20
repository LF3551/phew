/** Token usage that a model provider reports. */
export interface Usage {
  /** All input tokens of the request, also the ones read from or written to the prompt cache. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens that came from the prompt cache, at a lower price. */
  readonly cacheReadTokens?: number;
  /** Input tokens written to the prompt cache (Anthropic), at a slightly higher price. */
  readonly cacheWriteTokens?: number;
  /** The usual share of the input price for cached tokens with this provider, when the profile has no own price. */
  readonly cacheReadFactor?: number;
  readonly cacheWriteFactor?: number;
}

/** Price in US dollars per one million tokens. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  /** Input tokens from the prompt cache; by default a share of the input price that depends on the provider. */
  readonly cachedInput?: number;
}

export interface BudgetLimits {
  /** Maximum cost of one task in US dollars. Zero means no limit. */
  readonly maxCostPerTask: number;
  /** Maximum number of tokens of one task. Zero means no limit. */
  readonly maxTokensPerTask: number;
}

/** The cost of one model response in US dollars, with cached input at its own price. */
export function usageCost(usage: Usage, price: ModelPrice): number {
  const input = Math.max(0, usage.inputTokens);
  const read = Math.min(Math.max(0, usage.cacheReadTokens ?? 0), input);
  const write = Math.min(Math.max(0, usage.cacheWriteTokens ?? 0), input - read);
  const plain = input - read - write;
  const readPrice = price.cachedInput ?? price.input * (usage.cacheReadFactor ?? 1);
  const writePrice = price.input * (usage.cacheWriteFactor ?? 1);
  return (
    (plain * price.input + read * readPrice + write * writePrice + Math.max(0, usage.outputTokens) * price.output) /
    1_000_000
  );
}

/** Tracks the tokens and cost of one task. Each response counts at the price of the model that gave it. */
export class CostMeter {
  private input = 0;
  private output = 0;
  private cached = 0;
  private spent = 0;
  /** A price was known for some of the tokens. */
  private priced: boolean;
  /** True when some tokens were used by a model without a price, so the total is not known. */
  private unpriced = false;
  /** Input tokens of the last request, which shows how full the context window is. */
  lastInputTokens = 0;

  constructor(
    private price: ModelPrice | undefined,
    private readonly limits: BudgetLimits,
  ) {
    this.priced = price !== undefined;
  }

  add(usage: Usage): void {
    const input = Math.max(0, usage.inputTokens);
    const output = Math.max(0, usage.outputTokens);
    this.lastInputTokens = input;
    this.input += input;
    this.output += output;
    this.cached += Math.min(Math.max(0, usage.cacheReadTokens ?? 0), input);
    if (this.price) this.spent += usageCost(usage, this.price);
    else if (input + output > 0) this.unpriced = true;
  }

  /**
   * Adds the tokens and the cost of a subagent to this task, so the budget sees them. The fill of the context
   * window stays that of this chat.
   */
  absorb(other: CostMeter): void {
    this.input += other.inputTokens;
    this.output += other.outputTokens;
    this.cached += other.cachedTokens;
    const cost = other.cost;
    if (cost !== undefined) {
      this.spent += cost;
      this.priced = true;
    } else if (other.tokens > 0) this.unpriced = true;
  }

  /** Counts the next tokens with another price, for example after a switch to a fallback model. */
  usePrice(price: ModelPrice | undefined): void {
    this.price = price;
    if (price) this.priced = true;
  }

  get tokens(): number {
    return this.input + this.output;
  }

  get inputTokens(): number {
    return this.input;
  }

  get outputTokens(): number {
    return this.output;
  }

  /** Input tokens that came from the prompt cache. */
  get cachedTokens(): number {
    return this.cached;
  }

  /** Cost in US dollars, or undefined when the price of some tokens is not known. */
  get cost(): number | undefined {
    if (this.unpriced || !this.priced) return undefined;
    return this.spent;
  }

  /** Returns a reason when the task is over budget. */
  exceeded(): string | undefined {
    if (this.limits.maxTokensPerTask > 0 && this.tokens >= this.limits.maxTokensPerTask) {
      return `The task used ${this.tokens} tokens, which reaches the limit of ${this.limits.maxTokensPerTask}.`;
    }
    const cost = this.cost;
    if (cost !== undefined && this.limits.maxCostPerTask > 0 && cost >= this.limits.maxCostPerTask) {
      return `The task cost ${formatCost(cost)}, which reaches the limit of ${formatCost(this.limits.maxCostPerTask)}.`;
    }
    return undefined;
  }
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** Finds the price of a model in a user-defined table. Keys can end with `*` to match a prefix. */
export function findPrice(model: string, table: Readonly<Record<string, unknown>>): ModelPrice | undefined {
  const valid = (value: unknown): ModelPrice | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const { input, output } = value as Record<string, unknown>;
    if (typeof input !== "number" || typeof output !== "number" || input < 0 || output < 0) return undefined;
    return { input, output };
  };
  if (model in table) return valid(table[model]);
  const prefix = Object.keys(table)
    .filter((key) => key.endsWith("*") && model.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? valid(table[prefix]) : undefined;
}
