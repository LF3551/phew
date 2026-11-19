import { describe, expect, test } from "vitest";
import { defaultKeyLifetimeMs, KeyCommand, keyedFetch, parseKeyOutput } from "../src/providers/keyCommand";
import { parseProfile, serializeProfile } from "../src/providers/profile";

describe("parseKeyOutput", () => {
  test("reads a plain key with a trailing newline", () => {
    expect(parseKeyOutput("ya29.a0Abc-123_x\n")).toEqual({ key: "ya29.a0Abc-123_x" });
  });

  test("reads JSON with expires_in in seconds", () => {
    expect(parseKeyOutput('{"access_token":"tok","expires_in":3599}', 1_000)).toEqual({
      key: "tok",
      expiresAt: 1_000 + 3_599_000,
    });
  });

  test("reads the JSON of az account get-access-token with expires_on in epoch seconds", () => {
    const output = JSON.stringify({
      accessToken: "eyJ0eXAi",
      expiresOn: "2026-11-19 07:00:00.000000",
      expires_on: 1_795_000_000,
      tokenType: "Bearer",
    });
    expect(parseKeyOutput(output)).toEqual({ key: "eyJ0eXAi", expiresAt: 1_795_000_000_000 });
  });

  test("reads an ISO expiry", () => {
    expect(parseKeyOutput('{"token":"t","expiry":"2026-11-19T07:00:00Z"}')).toEqual({
      key: "t",
      expiresAt: Date.parse("2026-11-19T07:00:00Z"),
    });
  });

  test("explains empty, wordy, and keyless output without repeating it", () => {
    expect(() => parseKeyOutput("  \n")).toThrow("printed nothing");
    expect(() => parseKeyOutput("Logged in as me\nsecret-key")).toThrow("more than one line");
    expect(() => parseKeyOutput("Bearer abc")).toThrow("spaces");
    expect(() => parseKeyOutput('{"user":"me"}')).toThrow("has no key");
    expect(() => parseKeyOutput("{not json")).toThrow("not JSON");
  });
});

describe("KeyCommand", () => {
  test("runs the command once and keeps the key until it is about to expire", async () => {
    let now = 0;
    let runs = 0;
    const key = new KeyCommand(
      async () => `key-${++runs}`,
      () => now,
    );
    expect(await key.get()).toBe("key-1");
    now = defaultKeyLifetimeMs - 1;
    expect(await key.get()).toBe("key-1");
    now = defaultKeyLifetimeMs;
    expect(await key.get()).toBe("key-2");
    expect(await key.get(true)).toBe("key-3");
  });

  test("renews a minute before the expiry from the output", async () => {
    let now = 0;
    let runs = 0;
    const key = new KeyCommand(
      async () => JSON.stringify({ token: `t${++runs}`, expires_in: 600 }),
      () => now,
    );
    await key.get();
    now = 539_000;
    expect(await key.get()).toBe("t1");
    now = 540_000;
    expect(await key.get()).toBe("t2");
  });

  test("shares one run between requests that start together", async () => {
    let runs = 0;
    const key = new KeyCommand(async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "shared";
    });
    expect(await Promise.all([key.get(), key.get(), key.get()])).toEqual(["shared", "shared", "shared"]);
    expect(runs).toBe(1);
  });

  test("passes the error of the command and tries again next time", async () => {
    let fail = true;
    const key = new KeyCommand(async () => {
      if (fail) throw new Error("The key command of Vertex failed (exit 1): not signed in");
      return "ok";
    });
    await expect(key.get()).rejects.toThrow("not signed in");
    fail = false;
    expect(await key.get()).toBe("ok");
  });
});

describe("keyedFetch", () => {
  const recorder = (statuses: number[]) => {
    const seen: { auth: string | null; apiKey: string | null; body: unknown }[] = [];
    const base = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ auth: headers.get("Authorization"), apiKey: headers.get("x-api-key"), body: init?.body });
      return new Response("{}", { status: statuses.shift() ?? 200 });
    }) as typeof fetch;
    return { seen, base };
  };

  test("puts the current key into each request and keeps the other headers", async () => {
    const { seen, base } = recorder([200]);
    let runs = 0;
    const fetcher = keyedFetch("bearer", new KeyCommand(async () => `k${++runs}`), base);
    const response = await fetcher("https://example.test/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ auth: "Bearer k1", apiKey: null, body: "{}" }]);
  });

  test("gets a new key after a 401 and repeats the request once", async () => {
    const { seen, base } = recorder([401, 200]);
    let runs = 0;
    const fetcher = keyedFetch("x-api-key", new KeyCommand(async () => `k${++runs}`), base);
    const response = await fetcher("https://example.test", { method: "POST", body: '{"a":1}' });
    expect(response.status).toBe(200);
    expect(seen.map((request) => request.apiKey)).toEqual(["k1", "k2"]);
    expect(seen[1]?.body).toBe('{"a":1}');
  });

  test("does not repeat other errors or a second 401", async () => {
    const forbidden = recorder([403]);
    const key = new KeyCommand(async () => "k");
    expect((await keyedFetch("bearer", key, forbidden.base)("https://example.test")).status).toBe(403);
    expect(forbidden.seen).toHaveLength(1);
    const twice = recorder([401, 401]);
    expect((await keyedFetch("bearer", key, twice.base)("https://example.test")).status).toBe(401);
    expect(twice.seen).toHaveLength(2);
  });
});

test("a profile keeps its key command", () => {
  const profile = parseProfile({
    id: "vertex",
    name: "Vertex",
    provider: "openai",
    baseUrl: "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
    model: "google/gemini-2.5-pro",
    apiKeyCommand: "  gcloud auth print-access-token  ",
  });
  if (typeof profile === "string") throw new Error(profile);
  expect(profile.apiKeyCommand).toBe("gcloud auth print-access-token");
  expect(serializeProfile(profile).apiKeyCommand).toBe("gcloud auth print-access-token");
});
