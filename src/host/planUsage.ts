import type * as vscode from "vscode";
import { type PlanUsage, parseCopilotUser, parseDeepSeekBalance, parseOpenRouter } from "../core/planUsage";
import type { ModelProfile } from "../providers/profile";

type Fetch = typeof fetch;

/** Which plan service a model has, by its address: Copilot, OpenRouter, DeepSeek, or none. */
export function planSource(
  profile: ModelProfile,
): "copilot" | "copilot-vscode" | "openrouter" | "deepseek" | undefined {
  if (profile.provider === "vscode") return "copilot-vscode";
  const host = (() => {
    try {
      return new URL(profile.baseUrl).host;
    } catch {
      return "";
    }
  })();
  if (/(^|\.)githubcopilot\.com$/.test(host)) return "copilot";
  if (/(^|\.)openrouter\.ai$/.test(host)) return "openrouter";
  if (/(^|\.)deepseek\.com$/.test(host)) return "deepseek";
  return undefined;
}

/**
 * The plans of the models, asked only when the user clicks the plan of a model with Show plan on: one request,
 * never on a timer. Nothing leaves the computer but that request to the provider, with its own key.
 */
export class PlanUsageService {
  private readonly cache = new Map<string, { at: number; usage?: PlanUsage }>();
  private readonly running = new Map<string, Promise<PlanUsage | undefined>>();

  constructor(
    private readonly apiKey: (profile: ModelProfile) => Promise<string | undefined>,
    private readonly log: vscode.LogOutputChannel,
    /** The GitHub token of VS Code when the user is signed in already, without asking; for Copilot models of VS Code. */
    private readonly githubToken: () => Promise<string | undefined> = async () => undefined,
    private readonly fetchFunction: Fetch = fetch,
  ) {}

  /** The last plan that a check found, and when; nothing is asked here. */
  last(profile: ModelProfile): { usage: PlanUsage; at: number } | undefined {
    const entry = this.cache.get(profile.id);
    return entry?.usage ? { usage: entry.usage, at: entry.at } : undefined;
  }

  /** Asks the provider once, now; a second click while it runs waits for the same answer. */
  check(profile: ModelProfile): Promise<PlanUsage | undefined> {
    const source = planSource(profile);
    if (!source) return Promise.resolve(undefined);
    const running = this.running.get(profile.id);
    if (running) return running;
    const task = this.load(profile, source)
      .then((usage) => {
        this.cache.set(profile.id, { at: Date.now(), usage });
        return usage;
      })
      .catch((error: unknown) => {
        this.log.warn(
          `The plan of ${profile.name} is not available: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      })
      .finally(() => this.running.delete(profile.id));
    this.running.set(profile.id, task);
    return task;
  }

  private async load(
    profile: ModelProfile,
    source: NonNullable<ReturnType<typeof planSource>>,
  ): Promise<PlanUsage | undefined> {
    const get = async (url: string, authorization: string) => {
      const response = await this.fetchFunction(url, {
        headers: { Authorization: authorization, Accept: "application/json", "User-Agent": "Phew" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return (await response.json()) as unknown;
    };
    switch (source) {
      case "copilot": {
        const key = await this.apiKey(profile);
        return key
          ? parseCopilotUser(await get("https://api.github.com/copilot_internal/user", `token ${key}`))
          : undefined;
      }
      case "copilot-vscode": {
        // Only when the user is signed in to GitHub in VS Code already: Phew never asks to sign in for this.
        const token = await this.githubToken();
        return token
          ? parseCopilotUser(await get("https://api.github.com/copilot_internal/user", `token ${token}`))
          : undefined;
      }
      case "openrouter": {
        const key = await this.apiKey(profile);
        if (!key) return undefined;
        const base = profile.baseUrl.replace(/\/+$/, "");
        const [credits, info] = await Promise.all([
          get(`${base}/credits`, `Bearer ${key}`).catch(() => ({})),
          get(`${base}/key`, `Bearer ${key}`).catch(() => ({})),
        ]);
        return parseOpenRouter(credits, info);
      }
      case "deepseek": {
        const key = await this.apiKey(profile);
        return key
          ? parseDeepSeekBalance(await get("https://api.deepseek.com/user/balance", `Bearer ${key}`))
          : undefined;
      }
    }
  }
}
