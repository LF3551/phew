import type { ChatMessage } from "./chat";

export interface ExportOptions {
  readonly title: string;
  readonly model?: string;
  readonly mode?: string;
  readonly date?: Date;
  /** Include tool calls and tool results. */
  readonly includeTools?: boolean;
}

function fenced(body: string, language = ""): string {
  const fence = body.includes("```") ? "````" : "```";
  return `${fence}${language}\n${body.trimEnd()}\n${fence}`;
}

/** Converts a conversation to Markdown for sharing or documentation. */
export function conversationToMarkdown(history: readonly ChatMessage[], options: ExportOptions): string {
  const lines = [`# ${options.title}`, ""];
  const meta = [
    options.date ? `Date: ${options.date.toISOString().slice(0, 16).replace("T", " ")}` : "",
    options.model ? `Model: ${options.model}` : "",
    options.mode ? `Mode: ${options.mode}` : "",
  ].filter(Boolean);
  if (meta.length > 0) lines.push(`_${meta.join(" · ")}_`, "");
  for (const message of history) {
    switch (message.role) {
      case "user":
        lines.push("## You", "", message.content, "");
        break;
      case "assistant":
        if (message.content.trim()) lines.push("## Phew", "", message.content, "");
        if (options.includeTools !== false) {
          for (const call of message.toolCalls ?? []) {
            lines.push(
              `> Tool: \`${call.name}\` ${call.arguments.length > 200 ? `${call.arguments.slice(0, 200)}…` : call.arguments}`,
              "",
            );
          }
        }
        break;
      case "tool":
        if (options.includeTools !== false) {
          const body = message.content.length > 2000 ? `${message.content.slice(0, 2000)}\n…` : message.content;
          lines.push("<details><summary>Tool result</summary>", "", fenced(body), "", "</details>", "");
        }
        break;
      case "system":
        break;
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A short title from the first request. */
export function titleFromText(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line || "New chat";
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}
