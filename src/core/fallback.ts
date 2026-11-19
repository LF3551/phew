import type { CompletionRequest, CompletionResult, ModelClient } from "./chat";

/**
 * A fallback model: when the model of a task runs out of quota or credit, or stays rate limited or overloaded
 * after all retries, the task goes on with the fallback model that the user chose for it, instead of stopping.
 * A wrong key does not fall back: that needs a fix, not a quiet switch.
 */

/** Why a request to a model failed. */
export type FailureKind = "quota" | "rate" | "overloaded" | "auth" | "other";

/** An error of a model provider that keeps its kind, so Phew can decide what to do next. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const patterns: readonly [FailureKind, RegExp][] = [
  [
    "quota",
    /insufficient_quota|no quota or credit|exceeded your current quota|credit balance|out of credits|quota exceeded|payment required|monthly limit/i,
  ],
  ["rate", /rate limit|rate_limit|too many requests|\b429\b/i],
  ["overloaded", /overloaded|overloaded_error|\b529\b|service unavailable|\b503\b/i],
  ["auth", /\b401\b|\b403\b|invalid api key|incorrect api key|unauthorized|authentication/i],
];

/** The kind of a failure: from a ProviderError, or from the words of other errors (stream errors, VS Code models). */
export function failureKind(error: unknown): FailureKind {
  if (error instanceof ProviderError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  return patterns.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
}

/** True when a fallback model may take over: no quota, a lasting rate limit, or an overloaded provider. */
export function shouldFallBack(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const kind = failureKind(error);
  return kind === "quota" || kind === "rate" || kind === "overloaded";
}

/** Says why a model handed a task over, for the chat: "has no quota or credit left". */
export function fallbackReason(error: unknown): string {
  switch (failureKind(error)) {
    case "quota":
      return "has no quota or credit left";
    case "rate":
      return "stays rate limited";
    case "overloaded":
      return "is overloaded";
    default:
      return "failed";
  }
}

/** The models of a task: the model itself, then its fallback, then the fallback of that one; no loops. */
export function fallbackChain(
  startId: string,
  profiles: readonly { readonly id: string; readonly fallback?: string }[],
  maximum = 3,
): string[] {
  const chain: string[] = [];
  let id: string | undefined = startId;
  while (id && !chain.includes(id) && chain.length < maximum) {
    const profile = profiles.find((item) => item.id === id);
    if (!profile) break;
    chain.push(id);
    id = profile.fallback;
  }
  return chain;
}

export interface FallbackStep {
  readonly name: string;
  /** Creates the client when the step is needed, so a fallback costs nothing until it is used. */
  readonly client: () => Promise<ModelClient>;
}

/**
 * A model client that moves to the next model of the chain when a request fails with no quota, a lasting rate
 * limit, or an overloaded provider. It stays on the new model for the rest of the task.
 */
export class FallbackClient implements ModelClient {
  private index = 0;
  private readonly clients = new Map<number, Promise<ModelClient>>();

  constructor(
    private readonly steps: readonly FallbackStep[],
    /** Called with the indexes of the steps, before the next model gets the request. */
    private readonly onSwitch: (from: number, to: number, error: unknown) => void,
  ) {
    if (steps.length === 0) throw new Error("A task needs at least one model.");
  }

  /** The name of the model that answers now. */
  get current(): string {
    return this.steps[this.index]?.name ?? "";
  }

  private client(index: number): Promise<ModelClient> {
    let client = this.clients.get(index);
    if (!client) {
      client = (this.steps[index] as FallbackStep).client();
      this.clients.set(index, client);
    }
    return client;
  }

  async complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
    for (;;) {
      try {
        return await (await this.client(this.index)).complete(request, onText);
      } catch (error) {
        const next = this.index + 1;
        if (request.signal.aborted || next >= this.steps.length || !shouldFallBack(error)) throw error;
        this.onSwitch(this.index, next, error);
        this.index = next;
      }
    }
  }
}
