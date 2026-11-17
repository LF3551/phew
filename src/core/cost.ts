/** Token usage that a model provider reports. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Price in US dollars per one million tokens. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

export interface BudgetLimits {
  /** Maximum cost of one task in US dollars. Zero means no limit. */
  readonly maxCostPerTask: number;
  /** Maximum number of tokens of one task. Zero means no limit. */
  readonly maxTokensPerTask: number;
}

/** Tracks the tokens and cost of one task. */
export class CostMeter {
  private input = 0;
  private output = 0;

  constructor(
    private readonly price: ModelPrice | undefined,
    private readonly limits: BudgetLimits,
  ) {}

  add(usage: Usage): void {
    this.input += Math.max(0, usage.inputTokens);
    this.output += Math.max(0, usage.outputTokens);
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

  /** Cost in US dollars, or undefined when the model price is not configured. */
  get cost(): number | undefined {
    if (!this.price) return undefined;
    return (this.input * this.price.input + this.output * this.price.output) / 1_000_000;
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
