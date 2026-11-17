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
  return new Error(`${providerName} returned HTTP ${status}: ${message}${hint ? ` ${hint}` : ""}`);
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

/** Sends a JSON POST request and returns the response, or throws a helpful error. */
export async function postJson(
  fetchFunction: FetchFunction,
  providerName: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFunction(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (error) {
    throw networkError(providerName, url, error);
  }
  if (!response.ok) throw httpError(providerName, response.status, await response.text());
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
