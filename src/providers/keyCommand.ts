import type { FetchFunction } from "./http";
import type { AuthStyle } from "./profile";

/**
 * A key from a command: for providers with short-lived tokens, such as Google Vertex AI
 * (`gcloud auth print-access-token`), Azure with Microsoft Entra ID, or a company sign-in.
 * The command prints the key, or JSON with the key and its expiry. Phew keeps the key in memory,
 * runs the command again before the key expires, and once more when the server answers 401.
 */

/** How long a key without an expiry is used before the command runs again. */
export const defaultKeyLifetimeMs = 5 * 60_000;
/** A key is renewed this long before it expires. */
const renewBeforeMs = 60_000;

export interface CommandKey {
  readonly key: string;
  /** Milliseconds since the epoch, when the output says when the key expires. */
  readonly expiresAt?: number;
}

const keyFields = ["access_token", "accessToken", "token", "api_key", "apiKey", "key"];
const expiryFields = ["expires_on", "expiresOn", "expires_at", "expiresAt", "expiry", "expiration", "expire_time"];

/** Reads the key from the output of a key command: a plain key, or JSON with the key and its expiry. */
export function parseKeyOutput(stdout: string, now = Date.now()): CommandKey {
  const text = stdout.trim();
  if (!text) throw new Error("The key command printed nothing.");
  if (text.startsWith("{")) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("The key command printed text that starts like JSON but is not JSON.");
    }
    const field = keyFields.find((name) => typeof data[name] === "string" && (data[name] as string).trim());
    if (!field) throw new Error(`The JSON of the key command has no key. Use one of: ${keyFields.join(", ")}.`);
    return { key: (data[field] as string).trim(), expiresAt: expiryOf(data, now) };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 1) throw new Error("The key command printed more than one line. Print only the key.");
  if (/\s/.test(text)) throw new Error("The key command printed text with spaces. Print only the key.");
  return { key: text };
}

function expiryOf(data: Record<string, unknown>, now: number): number | undefined {
  const seconds = data.expires_in ?? data.expiresIn;
  if (typeof seconds === "number" && Number.isFinite(seconds)) return now + seconds * 1000;
  if (typeof seconds === "string" && /^\d+$/.test(seconds)) return now + Number(seconds) * 1000;
  for (const name of expiryFields) {
    const value = data[name];
    if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
    if (typeof value === "string" && value.trim()) {
      if (/^\d+$/.test(value.trim())) {
        const number = Number(value.trim());
        return number > 1e12 ? number : number * 1000;
      }
      const time = Date.parse(value);
      if (!Number.isNaN(time)) return time;
    }
  }
  return undefined;
}

/** Runs a key command when needed and keeps its key in memory. Concurrent requests share one run. */
export class KeyCommand {
  private current: { key: string; renewAt: number } | undefined;
  private running: Promise<string> | undefined;

  constructor(
    private readonly run: () => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The key. With `renew`, or when the key is about to expire, the command runs again. */
  async get(renew = false): Promise<string> {
    if (!renew && this.current && this.now() < this.current.renewAt) return this.current.key;
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const parsed = parseKeyOutput(await this.run(), this.now());
        const now = this.now();
        const renewAt = parsed.expiresAt
          ? Math.max(now + 5_000, parsed.expiresAt - renewBeforeMs)
          : now + defaultKeyLifetimeMs;
        this.current = { key: parsed.key, renewAt };
        return parsed.key;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Forgets the key, for example after the command changed. */
  clear(): void {
    this.current = undefined;
  }
}

/** The headers that carry a key in each auth style. */
const authHeaders: Readonly<Record<AuthStyle, string | undefined>> = {
  bearer: "Authorization",
  "api-key": "api-key",
  "x-api-key": "x-api-key",
  "x-goog-api-key": "x-goog-api-key",
  none: undefined,
};

/**
 * A fetch that puts the current key of a command into each request. When the server answers 401,
 * it runs the command again and repeats the request once, so an expired token never stops a task.
 */
export function keyedFetch(auth: AuthStyle, key: KeyCommand, base: FetchFunction = fetch): FetchFunction {
  const header = authHeaders[auth];
  const send = async (input: Parameters<FetchFunction>[0], init: RequestInit | undefined, renew: boolean) => {
    const headers = new Headers(init?.headers);
    if (header) {
      const value = await key.get(renew);
      headers.set(header, auth === "bearer" ? `Bearer ${value}` : value);
    }
    return base(input, { ...init, headers });
  };
  return (async (input: Parameters<FetchFunction>[0], init?: RequestInit) => {
    const response = await send(input, init, false);
    // A body that is a stream cannot be sent twice; Phew sends JSON strings.
    if (response.status !== 401 || !header || (init?.body !== undefined && typeof init.body !== "string"))
      return response;
    await response.body?.cancel().catch(() => undefined);
    return send(input, init, true);
  }) as FetchFunction;
}
