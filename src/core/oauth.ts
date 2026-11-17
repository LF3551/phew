import { createHash, randomBytes } from "node:crypto";

/** OAuth 2.1 helpers for MCP servers: discovery, dynamic client registration, PKCE, and tokens. */

export interface OAuthMetadata {
  readonly issuer?: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint?: string;
  readonly scopes_supported?: readonly string[];
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Expiry time in milliseconds since 1970, if known. */
  readonly expiresAt?: number;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly resource: string;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Reads `resource_metadata` from a `WWW-Authenticate: Bearer ...` header. */
export function resourceMetadataUrl(header: string | null): string | undefined {
  if (!header) return undefined;
  return /resource_metadata="([^"]+)"/i.exec(header)?.[1];
}

type FetchFunction = typeof fetch;

async function getJson(fetchFunction: FetchFunction, url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchFunction(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return undefined;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Well-known metadata URLs of an issuer, with the path insertion rule of RFC 8414. */
export function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;
  return path && path !== "/"
    ? [
        `${origin}/.well-known/oauth-authorization-server${path}`,
        `${origin}/.well-known/openid-configuration${path}`,
        `${origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
}

/** Finds the authorization server of an MCP server and loads its metadata. */
export async function discover(
  serverUrl: string,
  wwwAuthenticate: string | null,
  fetchFunction: FetchFunction = fetch,
): Promise<OAuthMetadata> {
  let issuer = new URL(serverUrl).origin;
  const resourceUrl =
    resourceMetadataUrl(wwwAuthenticate) ?? `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`;
  const resource = await getJson(fetchFunction, resourceUrl);
  const servers = resource?.authorization_servers;
  if (Array.isArray(servers) && typeof servers[0] === "string") issuer = servers[0];
  for (const url of metadataUrls(issuer)) {
    const data = await getJson(fetchFunction, url);
    if (data && typeof data.authorization_endpoint === "string" && typeof data.token_endpoint === "string") {
      return data as unknown as OAuthMetadata;
    }
  }
  // Fallback of the MCP specification for servers without metadata.
  return {
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
  };
}

/** Registers Phew as a public OAuth client (RFC 7591). */
export async function registerClient(
  metadata: OAuthMetadata,
  redirectUri: string,
  fetchFunction: FetchFunction = fetch,
): Promise<string> {
  if (!metadata.registration_endpoint) throw new Error("The MCP server does not support dynamic client registration.");
  const response = await fetchFunction(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Phew",
      client_uri: "https://github.com/LF3551/phew",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) throw new Error(`Client registration failed with HTTP ${response.status}.`);
  const data = (await response.json()) as { client_id?: unknown };
  if (typeof data.client_id !== "string") throw new Error("The registration response has no client_id.");
  return data.client_id;
}

export function authorizationUrl(
  metadata: OAuthMetadata,
  options: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string },
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  url.searchParams.set("resource", options.resource);
  if (metadata.scopes_supported && metadata.scopes_supported.length > 0) {
    url.searchParams.set("scope", metadata.scopes_supported.join(" "));
  }
  return url.toString();
}

async function tokenRequest(
  tokenEndpoint: string,
  form: Record<string, string>,
  fallback: { clientId: string; resource: string; refreshToken?: string },
  fetchFunction: FetchFunction,
): Promise<OAuthTokens> {
  const response = await fetchFunction(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  if (!response.ok || typeof data.access_token !== "string") {
    throw new Error(
      `The token request failed: ${String(data.error_description ?? data.error ?? `HTTP ${response.status}`)}`,
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : fallback.refreshToken,
    expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
    clientId: fallback.clientId,
    tokenEndpoint,
    resource: fallback.resource,
  };
}

export function exchangeCode(
  metadata: OAuthMetadata,
  options: { code: string; verifier: string; clientId: string; redirectUri: string; resource: string },
  fetchFunction: FetchFunction = fetch,
): Promise<OAuthTokens> {
  return tokenRequest(
    metadata.token_endpoint,
    {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      code_verifier: options.verifier,
      resource: options.resource,
    },
    { clientId: options.clientId, resource: options.resource },
    fetchFunction,
  );
}

export function refreshTokens(tokens: OAuthTokens, fetchFunction: FetchFunction = fetch): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw new Error("No refresh token.");
  return tokenRequest(
    tokens.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      resource: tokens.resource,
    },
    { clientId: tokens.clientId, resource: tokens.resource, refreshToken: tokens.refreshToken },
    fetchFunction,
  );
}

/** True when the token expires within the next minute. */
export function isExpired(tokens: OAuthTokens, now = Date.now()): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - 60_000 <= now;
}
