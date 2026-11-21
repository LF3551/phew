/**
 * The plan of a model: how much it allows, how much is used, and how much is left, when the provider tells it.
 * GitHub Copilot reports its monthly quotas, OpenRouter its credits, and DeepSeek its balance. Other providers do
 * not share a plan with an API key, so their models show no ring.
 */

export interface PlanQuota {
  /** What is counted: "Chat messages", "Premium requests", "Credits", "Balance". */
  readonly name: string;
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly unlimited?: boolean;
  /** "requests", or a currency such as "USD". */
  readonly unit: string;
}

export interface PlanUsage {
  readonly provider: string;
  /** The plan, for example "Free", "Pro", "Business". */
  readonly plan?: string;
  /** The quota that the chat spends; the ring shows it. */
  readonly main?: PlanQuota;
  /** Other quotas of the plan, for the details. */
  readonly others: readonly PlanQuota[];
  /** The day when the quotas start again, YYYY-MM-DD. */
  readonly resetsOn?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The plan of GitHub Copilot from api.github.com/copilot_internal/user. */
export function parseCopilotUser(json: unknown): PlanUsage | undefined {
  const data = record(json);
  const snapshots = record(data.quota_snapshots);
  if (Object.keys(snapshots).length === 0 && typeof data.copilot_plan !== "string") return undefined;
  const sku = String(data.access_type_sku ?? "").toLowerCase();
  const plan = String(data.copilot_plan ?? "").toLowerCase();
  const planName = sku.includes("free")
    ? "Free"
    : plan === "business"
      ? "Business"
      : plan === "enterprise"
        ? "Enterprise"
        : sku.includes("plus") || sku.includes("pro_plus")
          ? "Pro+"
          : plan === "individual"
            ? "Pro"
            : plan
              ? plan[0]?.toUpperCase() + plan.slice(1)
              : undefined;
  const quota = (key: string, name: string): PlanQuota | undefined => {
    const snapshot = record(snapshots[key]);
    if (Object.keys(snapshot).length === 0) return undefined;
    const unlimited = snapshot.unlimited === true;
    const limit = number(snapshot.entitlement);
    const remaining = number(snapshot.remaining) ?? number(snapshot.quota_remaining);
    const used = limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined;
    return { name, unit: "requests", unlimited, limit, remaining, used };
  };
  const chat = quota("chat", "Chat messages");
  const premium = quota("premium_interactions", "Premium requests");
  const completions = quota("completions", "Completions");
  // The free plan counts chat messages; paid plans count premium requests (chat itself is unlimited there).
  const spendsPremium = premium !== undefined && (premium.unlimited || (premium.limit ?? 0) > 0);
  const main = spendsPremium ? premium : (chat ?? premium);
  const others = [chat, premium, completions].filter(
    (item): item is PlanQuota => item !== undefined && item !== main && !(item.limit === 0 && !item.unlimited),
  );
  const resetsOn = typeof data.quota_reset_date === "string" ? data.quota_reset_date.slice(0, 10) : undefined;
  return { provider: "GitHub Copilot", plan: planName, main, others, resetsOn };
}

/** The credits of OpenRouter from /api/v1/credits, with the plan of the key from /api/v1/key. */
export function parseOpenRouter(credits: unknown, key: unknown): PlanUsage | undefined {
  const total = record(record(credits).data);
  const info = record(record(key).data);
  const limit = number(total.total_credits);
  const used = number(total.total_usage);
  if (limit === undefined && Object.keys(info).length === 0) return undefined;
  const main: PlanQuota | undefined =
    limit !== undefined
      ? {
          name: "Credits",
          unit: "USD",
          limit,
          used,
          remaining: used !== undefined ? Math.max(0, limit - used) : undefined,
        }
      : undefined;
  return { provider: "OpenRouter", plan: info.is_free_tier === true ? "Free" : "Paid", main, others: [] };
}

/** The balance of DeepSeek from /user/balance: only what is left, without a limit. */
export function parseDeepSeekBalance(json: unknown): PlanUsage | undefined {
  const infos = Array.isArray(record(json).balance_infos) ? (record(json).balance_infos as unknown[]) : [];
  const first = record(infos[0]);
  const remaining = Number(first.total_balance);
  if (!Number.isFinite(remaining)) return undefined;
  return {
    provider: "DeepSeek",
    plan: "Pay as you go",
    main: { name: "Balance", unit: String(first.currency ?? "USD"), remaining },
    others: [],
  };
}

const amount = (value: number, unit: string) =>
  unit === "requests"
    ? Number.isInteger(value)
      ? String(value)
      : value.toFixed(1)
    : `${unit === "USD" ? "$" : unit === "CNY" ? "¥" : `${unit} `}${value.toFixed(2)}`;

/** One quota in words: "190 of 200 left", "Unlimited", "$4.20 left". */
export function describeQuota(quota: PlanQuota): string {
  if (quota.unlimited) return `${quota.name}: unlimited`;
  if (quota.remaining !== undefined && quota.limit !== undefined)
    return `${quota.name}: ${amount(quota.remaining, quota.unit)} of ${amount(quota.limit, quota.unit)} left${
      quota.used !== undefined ? ` (${amount(quota.used, quota.unit)} used)` : ""
    }`;
  if (quota.remaining !== undefined) return `${quota.name}: ${amount(quota.remaining, quota.unit)} left`;
  return quota.name;
}

/** What the ring shows: the share that is left, a short text, the plan, and the details for its tooltip. */
export interface PlanRing {
  readonly plan?: string;
  /** From 0 to 1, what is left; undefined when there is no limit to compare with. */
  readonly left?: number;
  readonly short: string;
  readonly details: readonly string[];
}

export function planRing(usage: PlanUsage, today = new Date()): PlanRing | undefined {
  const main = usage.main;
  if (!main) return undefined;
  const left = main.unlimited
    ? 1
    : main.remaining !== undefined && main.limit
      ? Math.min(1, Math.max(0, main.remaining / main.limit))
      : undefined;
  const short = main.unlimited
    ? "∞"
    : main.remaining !== undefined && main.limit !== undefined
      ? `${amount(main.remaining, main.unit)}/${amount(main.limit, main.unit)}`
      : main.remaining !== undefined
        ? amount(main.remaining, main.unit)
        : "";
  const reset = usage.resetsOn ? new Date(`${usage.resetsOn}T00:00:00Z`) : undefined;
  const days = reset ? Math.ceil((reset.getTime() - today.getTime()) / 86_400_000) : undefined;
  const details = [
    `${usage.provider}${usage.plan ? ` ${usage.plan}` : ""}`,
    describeQuota(main),
    ...usage.others.map(describeQuota),
    reset && days !== undefined && days >= 0
      ? `Starts again on ${reset.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}${
          days <= 31 ? ` (in ${days} day${days === 1 ? "" : "s"})` : ""
        }`
      : "",
  ].filter(Boolean);
  return { ...(usage.plan ? { plan: usage.plan } : {}), ...(left !== undefined ? { left } : {}), short, details };
}
