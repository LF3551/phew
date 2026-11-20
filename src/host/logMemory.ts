import type * as vscode from "vscode";

/**
 * The log of Phew with a memory of its latest lines. VS Code cannot read an output channel back, so "Report a
 * Problem" takes the recent lines from here. Everything else goes to the channel as before.
 */
export function rememberLog(
  channel: vscode.LogOutputChannel,
  size = 200,
): { channel: vscode.LogOutputChannel; recent: () => string[] } {
  const lines: string[] = [];
  const keep = (level: string, values: readonly unknown[]) => {
    const text = values.map((value) => (value instanceof Error ? value.message : String(value))).join(" ");
    lines.push(`${new Date().toISOString().slice(11, 19)} ${level} ${text.slice(0, 600)}`);
    if (lines.length > size) lines.splice(0, lines.length - size);
  };
  const levels = new Set(["trace", "debug", "info", "warn", "error"]);
  const proxy = new Proxy(channel, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === "string" && levels.has(property) && typeof value === "function")
        return (...values: unknown[]) => {
          keep(property, values);
          return (value as (...items: unknown[]) => unknown).apply(target, values);
        };
      return typeof value === "function" ? (value as (...items: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { channel: proxy, recent: () => [...lines] };
}
