/** Context that the user attaches to a message. */
export type Attachment =
  | { readonly kind: "file"; readonly path: string }
  | {
      readonly kind: "selection";
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly text: string;
      readonly language?: string;
    }
  | { readonly kind: "terminal"; readonly command?: string; readonly output: string }
  | { readonly kind: "problems"; readonly path?: string }
  | { readonly kind: "git" }
  | { readonly kind: "image"; readonly name: string; readonly mimeType: string; readonly data: string };

export const imageMimeTypes: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Maximum size of one image in base64 characters, about 5 MB of image data. */
export const maximumImageCharacters = 7_000_000;
export const maximumAttachments = 20;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

/** Validates an attachment from the webview. Returns undefined for invalid input. */
export function parseAttachment(value: unknown): Attachment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  switch (item.kind) {
    case "file": {
      const path = text(item.path, 1000);
      return path && !path.includes("\0") ? { kind: "file", path } : undefined;
    }
    case "selection": {
      const path = text(item.path, 1000);
      const body = text(item.text, 200_000);
      const startLine = Number(item.startLine);
      const endLine = Number(item.endLine);
      if (!path || body === undefined || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return undefined;
      return { kind: "selection", path, startLine, endLine, text: body, language: text(item.language, 50) };
    }
    case "terminal": {
      const output = text(item.output, 200_000);
      return output === undefined ? undefined : { kind: "terminal", command: text(item.command, 2000), output };
    }
    case "problems":
      return { kind: "problems", path: text(item.path, 1000) };
    case "git":
      return { kind: "git" };
    case "image": {
      const mimeType = text(item.mimeType, 40);
      const data = text(item.data, maximumImageCharacters);
      if (!mimeType || !imageMimeTypes.includes(mimeType) || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) return undefined;
      return { kind: "image", name: text(item.name, 200) ?? "image", mimeType, data };
    }
    default:
      return undefined;
  }
}

/** A short label for an attachment chip. */
export function attachmentLabel(attachment: Attachment): string {
  switch (attachment.kind) {
    case "file":
      return attachment.path;
    case "selection":
      return `${attachment.path}:${attachment.startLine}-${attachment.endLine}`;
    case "terminal":
      return attachment.command ? `Terminal: ${attachment.command.slice(0, 40)}` : "Terminal output";
    case "problems":
      return attachment.path ? `Problems: ${attachment.path}` : "Problems";
    case "git":
      return "Git changes";
    case "image":
      return attachment.name;
  }
}

/**
 * Finds `@` mentions that the user typed: `@problems`, `@git`, `@terminal`, and file paths such as `@src/app.ts`.
 * Email addresses and decorators like `@Component(` are ignored.
 */
export function extractMentions(message: string): Attachment[] {
  const found: Attachment[] = [];
  const seen = new Set<string>();
  for (const match of message.matchAll(/(^|[\s(])@([A-Za-z0-9_./\\-]+)(?=$|[\s),;:!?])/g)) {
    const token = match[2].replace(/[.,]+$/, "");
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === "problems") found.push({ kind: "problems" });
    else if (key === "git" || key === "diff") found.push({ kind: "git" });
    else if (key === "terminal") found.push({ kind: "terminal", output: "" });
    else if (/[/\\]|\.[A-Za-z0-9]{1,8}$/.test(token)) found.push({ kind: "file", path: token });
  }
  return found;
}

export interface ContextBlock {
  readonly title: string;
  readonly body: string;
  readonly language?: string;
}

/** Formats attached context for the model, separate from the question. */
export function formatContext(blocks: readonly ContextBlock[]): string {
  if (blocks.length === 0) return "";
  const parts = blocks.map((block) => {
    const fence = block.body.includes("```") ? "````" : "```";
    return `### ${block.title}\n${fence}${block.language ?? ""}\n${block.body}\n${fence}`;
  });
  return `Attached context:\n\n${parts.join("\n\n")}`;
}
