import type { RetryInfo } from "../core/chat";
import { type FailureKind, ProviderError } from "../core/fallback";
import { redactSecrets } from "../core/secrets";
import { SseParser } from "../core/sse";

export type FetchFunction = typeof fetch;

/** Extracts the error message from common provider error bodies. */
export function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const data = first as { error?: unknown; message?: unknown; detail?: unknown };
    if (typeof data.error === "string") return data.error;
    if (typeof data.error === "object" && data.error !== null) {
      const error = data.error as { message?: unknown; status?: unknown };
      if (typeof error.message === "string") return error.message;
    }
    if (typeof data.message === "string") return data.message;
    if (typeof data.detail === "string") return data.detail;
  } catch {
    // Not JSON.
  }
  return body.trim();
}

/** Builds an error for a failed HTTP request with a hint that helps the user fix it. */
export function httpError(providerName: string, status: number, body: string): Error {
  const message = redactSecrets(errorMessage(body)).text.slice(0, 500) || "no details";
  const hint =
    status === 401 || status === 403
      ? "Check the API key and the auth style with Phew: Manage Models."
      : status === 404
        ? "Check the base URL and the model name with Phew: Manage Models."
        : status === 429
          ? "The rate limit or the quota of the provider is reached. Wait or check your plan."
          : status === 400
            ? "The provider rejected the request. Check the model name and the extra body fields."
            : status >= 500
              ? "The provider has a problem. Try again later."
              : "";
  const kind: FailureKind =
    status === 401 || status === 403
      ? "auth"
      : status === 429
        ? "rate"
        : status === 529 || status === 503
          ? "overloaded"
          : "other";
  return new ProviderError(
    `${providerName} returned HTTP ${status}: ${message}${hint ? ` ${hint}` : ""}`,
    kind,
    status,
  );
}

/** Turns a network failure into an error that names the likely cause. */
export function networkError(providerName: string, url: string, error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const cause =
    error instanceof Error ? ((error.cause as { code?: string } | undefined)?.code ?? error.message) : String(error);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw value.
  }
  const local = /localhost|127\.0\.0\.1|\[::1\]/.test(host);
  const hint = local
    ? "Is the local server running?"
    : "Check the base URL, your internet connection, and the proxy settings of VS Code.";
  return new Error(`Cannot reach ${providerName} at ${host} (${cause}). ${hint}`);
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  readonly retries: number;
  readonly onRetry?: (info: RetryInfo) => void;
  /** Longest wait before one retry. */
  readonly maxDelayMs?: number;
}

const retryStatuses = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const quotaPattern =
  /insufficient_quota|exceeded your current quota|credit balance|out of credits|billing|payment required|quota exceeded|RESOURCE_EXHAUSTED.*(billing|plan)|monthly limit/i;

/**
 * True when the account has no quota or credit left. Retries do not help then.
 * Anthropic says so with HTTP 400: "Your credit balance is too low to access the Anthropic API."
 */
export function isQuotaError(status: number, body: string): boolean {
  return (status === 400 || status === 429 || status === 402 || status === 403) && quotaPattern.test(body);
}

/** Parses durations like `1s`, `6m0s`, `250ms`, or `1h2m3.5s` in milliseconds. */
export function parseDuration(value: string): number | undefined {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(text);
  if (!match || text === "") return undefined;
  const [, hours, minutes, seconds, ms] = match;
  return (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000 + Number(ms ?? 0);
}

/** The wait that the server asks for, from Retry-After or rate limit headers. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+$/.test(ms)) return Number(ms);
  const after = headers.get("retry-after");
  if (after) {
    if (/^\d+(\.\d+)?$/.test(after.trim())) return Number(after) * 1000;
    const date = Date.parse(after);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const resets = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]
    .map((name) => headers.get(name))
    .filter((value): value is string => !!value)
    .map((value) => parseDuration(value))
    .filter((value): value is number => value !== undefined);
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Builds the final error after a failed request, with clear advice for limits and quotas. */
export function finalError(providerName: string, status: number, body: string, attempts: number): Error {
  if (isQuotaError(status, body)) {
    return new ProviderError(
      `${providerName}: your account has no quota or credit left (${errorMessage(body).slice(0, 200)}). Check the billing of the provider, or switch the model with Phew: Switch Model.`,
      "quota",
      status,
    );
  }
  if (status === 429) {
    return new ProviderError(
      `${providerName} rate limit reached${attempts > 1 ? ` after ${attempts} attempts` : ""}: ${redactSecrets(errorMessage(body)).text.slice(0, 200)}. Wait a minute, use a model with higher limits, or switch the model with Phew: Switch Model.`,
      "rate",
      status,
    );
  }
  if (status === 529 || status === 503) {
    return new ProviderError(
      `${providerName} is overloaded${attempts > 1 ? ` after ${attempts} attempts` : ""}. Try again later or switch the model.`,
      "overloaded",
      status,
    );
  }
  return httpError(providerName, status, body);
}

/**
 * Sends a request and retries after rate limits, server errors, and network errors.
 * It waits as long as the server asks, or with exponential backoff, and never retries a missing quota.
 */
export async function fetchWithRetry(
  fetchFunction: FetchFunction,
  providerName: string,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  retry: RetryOptions = { retries: 0 },
): Promise<Response> {
  const maxAttempts = Math.max(1, retry.retries + 1);
  const maxDelay = retry.maxDelayMs ?? 60_000;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetchFunction(url, init);
    } catch (error) {
      if (init.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if (attempt >= maxAttempts) throw networkError(providerName, url, error);
      const delay = Math.min(maxDelay, 1000 * 2 ** (attempt - 1));
      retry.onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs: delay, reason: "network error" });
      await sleep(delay, init.signal);
      continue;
    }
    if (response.ok || !retryStatuses.has(response.status) || attempt >= maxAttempts) return response;
    const body = await response.clone().text();
    if (isQuotaError(response.status, body)) return response;
    const asked = retryAfterMs(response.headers);
    const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    const delay = Math.min(maxDelay, asked ?? backoff);
    retry.onRetry?.({
      attempt: attempt + 1,
      maxAttempts,
      delayMs: delay,
      reason: response.status === 429 ? "rate limit" : `server error ${response.status}`,
    });
    await sleep(delay, init.signal);
  }
}

/** Sends a JSON POST request with retries and returns the response, or throws a helpful error. */
export async function postJson(
  fetchFunction: FetchFunction,
  providerName: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  retry?: RetryOptions,
): Promise<Response> {
  const response = await fetchWithRetry(
    fetchFunction,
    providerName,
    url,
    { method: "POST", headers, body: JSON.stringify(body), signal },
    retry,
  );
  if (!response.ok) throw finalError(providerName, response.status, await response.text(), (retry?.retries ?? 0) + 1);
  return response;
}

/** Reads a Server-Sent Events response and calls `onEvent` with each parsed JSON payload. */
export async function readSse(response: Response, onEvent: (data: unknown) => void): Promise<void> {
  if (!response.body) throw new Error("The response has no body.");
  let failure: unknown;
  const parser = new SseParser((data) => {
    if (failure !== undefined || data.trim() === "[DONE]" || data.trim() === "") return;
    try {
      onEvent(JSON.parse(data));
    } catch (error) {
      failure = error;
    }
  });
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (failure !== undefined) throw failure;
    }
    parser.push(decoder.decode());
    parser.flush();
  } finally {
    reader.releaseLock();
  }
  if (failure !== undefined) throw failure;
}

/** Parses tool arguments for providers that need a JSON object. Invalid JSON becomes an empty object. */
export function argumentsObject(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json || "{}") as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
