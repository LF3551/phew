/** MCP server configuration from Phew settings, `.vscode/mcp.json`, and `.mcp.json` (Claude Code). */

export type McpServerConfig =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | { readonly type: "http"; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export interface McpServerEntry {
  readonly name: string;
  readonly source: "settings" | ".vscode/mcp.json" | ".mcp.json";
  readonly config: McpServerConfig;
}

export interface McpInput {
  readonly id: string;
  readonly description: string;
  readonly password: boolean;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const stringRecord = (value: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return result;
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") result[key] = item;
  return result;
};

/** Parses one server. HTTP is used when a URL is present. The legacy SSE type is treated as HTTP. */
export function parseServer(value: unknown): McpServerConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  if (
    typeof raw.url === "string" &&
    raw.url.trim() &&
    (type === "" || type === "http" || type === "sse" || type === "streamable-http")
  ) {
    return { type: "http", url: raw.url.trim(), headers: stringRecord(raw.headers) };
  }
  if (typeof raw.command === "string" && raw.command.trim() && (type === "" || type === "stdio")) {
    return {
      type: "stdio",
      command: raw.command.trim(),
      args: strings(raw.args),
      env: stringRecord(raw.env),
      ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
    };
  }
  return undefined;
}

/** Parses a configuration object. VS Code uses `servers`, Claude Code uses `mcpServers`. */
export function parseMcpFile(
  text: string,
  source: McpServerEntry["source"],
): { servers: McpServerEntry[]; inputs: McpInput[] } {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonComments(text));
  } catch {
    return { servers: [], inputs: [] };
  }
  const root = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const map = (root.servers ?? root.mcpServers ?? {}) as Record<string, unknown>;
  const servers: McpServerEntry[] = [];
  for (const [name, value] of Object.entries(typeof map === "object" && map !== null ? map : {})) {
    const config = parseServer(value);
    if (config) servers.push({ name, source, config });
  }
  const inputs: McpInput[] = [];
  for (const item of Array.isArray(root.inputs) ? root.inputs : []) {
    const input = item as Record<string, unknown>;
    if (typeof input.id === "string" && /^[\w.-]{1,64}$/.test(input.id)) {
      inputs.push({
        id: input.id,
        description: typeof input.description === "string" ? input.description : input.id,
        password: input.password === true,
      });
    }
  }
  return { servers, inputs };
}

/** Removes `//` and `/* *\/` comments and trailing commas, so JSONC files parse. Strings stay unchanged. */
export function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      result += character;
      if (character === "\\") {
        result += next ?? "";
        index++;
      } else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      result += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index++;
    } else result += character;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}

export interface VariableContext {
  readonly workspaceFolder?: string;
  readonly userHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly inputs: Readonly<Record<string, string>>;
}

/** Replaces `${input:id}`, `${env:NAME}`, `${NAME}`, `${workspaceFolder}`, and `${userHome}`. Unknown inputs are reported. */
export function resolveVariables(value: string, context: VariableContext, missingInputs?: Set<string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name.startsWith("input:")) {
      const id = name.slice(6);
      if (id in context.inputs) return context.inputs[id];
      missingInputs?.add(id);
      return "";
    }
    if (name.startsWith("env:")) return context.env[name.slice(4)] ?? "";
    if (name === "workspaceFolder") return context.workspaceFolder ?? whole;
    if (name === "userHome") return context.userHome;
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) return context.env[name] ?? "";
    return whole;
  });
}

/** Resolves all variables of a server configuration. */
export function resolveServer(
  config: McpServerConfig,
  context: VariableContext,
  missingInputs?: Set<string>,
): McpServerConfig {
  const resolve = (value: string) => resolveVariables(value, context, missingInputs);
  const record = (value: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  if (config.type === "http") return { type: "http", url: resolve(config.url), headers: record(config.headers) };
  return {
    type: "stdio",
    command: resolve(config.command),
    args: config.args.map(resolve),
    env: record(config.env),
    ...(config.cwd ? { cwd: resolve(config.cwd) } : {}),
  };
}

/** The inputs that a configuration uses. */
export function usedInputs(config: McpServerConfig): string[] {
  const text = JSON.stringify(config);
  return [...new Set([...text.matchAll(/\$\{input:([^}]+)\}/g)].map((match) => match[1]))];
}
