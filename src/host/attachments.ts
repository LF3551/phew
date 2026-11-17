import * as path from "node:path";
import * as vscode from "vscode";
import { type Attachment, attachmentLabel, type ContextBlock, formatContext } from "../core/attachments";
import type { ImagePart } from "../core/chat";
import { truncateMiddle } from "../core/chat";
import { resolveInside, toRelative } from "../core/paths";
import { isSensitivePath, redactSecrets } from "../core/secrets";
import type { MentionItem } from "../shared/protocol";
import { readWorkspaceText } from "./changes";
import { git } from "./git";
import type { Settings } from "./settings";
import type { TerminalWatcher } from "./terminalWatcher";

const maximumFileCharacters = 120_000;
const maximumGitCharacters = 60_000;

export interface ResolvedAttachments {
  readonly context: string;
  readonly images: ImagePart[];
  readonly labels: string[];
  readonly warnings: string[];
}

const languageOf = (file: string) => path.extname(file).replace(/^\./, "");

/** Turns attachments into context text and images for the model. */
export async function resolveAttachments(
  attachments: readonly Attachment[],
  root: vscode.Uri,
  settings: Settings,
  terminal: TerminalWatcher,
): Promise<ResolvedAttachments> {
  const blocks: ContextBlock[] = [];
  const images: ImagePart[] = [];
  const labels: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const key = JSON.stringify(
      attachment.kind === "image" ? [attachment.kind, attachment.name, attachment.data.length] : attachment,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(attachmentLabel(attachment));
    switch (attachment.kind) {
      case "file": {
        const absolute = resolveInside(root.fsPath, attachment.path);
        if (!absolute) {
          warnings.push(`${attachment.path} is outside the workspace.`);
          break;
        }
        const relative = toRelative(root.fsPath, absolute);
        if (isSensitivePath(relative, settings.sensitiveNames)) {
          warnings.push(`${relative} can contain secrets, so Phew did not attach it.`);
          break;
        }
        const text = await readWorkspaceText(vscode.Uri.file(absolute)).catch(() => null);
        if (text === null) {
          warnings.push(`${relative} does not exist.`);
          break;
        }
        if (text.includes("\0")) {
          warnings.push(`${relative} is binary.`);
          break;
        }
        blocks.push({
          title: relative,
          body: truncateMiddle(text, maximumFileCharacters),
          language: languageOf(relative),
        });
        break;
      }
      case "selection":
        blocks.push({
          title: `${attachment.path} lines ${attachment.startLine}-${attachment.endLine}`,
          body: attachment.text,
          language: attachment.language ?? languageOf(attachment.path),
        });
        break;
      case "terminal": {
        const execution = attachment.output ? attachment : terminal.lastExecution;
        if (!execution?.output.trim()) {
          warnings.push("No terminal output is available. Phew needs terminal shell integration to read it.");
          break;
        }
        blocks.push({
          title: execution.command ? `Terminal: ${execution.command}` : "Terminal output",
          body: truncateMiddle(execution.output, 30_000),
        });
        break;
      }
      case "problems": {
        const lines: string[] = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
          const absolute = resolveInside(root.fsPath, uri.fsPath);
          if (!absolute) continue;
          const relative = toRelative(root.fsPath, absolute);
          if (attachment.path && relative !== attachment.path) continue;
          for (const diagnostic of diagnostics) {
            if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
            const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
            lines.push(`${relative}:${diagnostic.range.start.line + 1}: ${severity} ${diagnostic.message}`);
          }
        }
        blocks.push({ title: "Problems", body: lines.slice(0, 300).join("\n") || "No errors or warnings." });
        break;
      }
      case "git": {
        const result = await git(root.fsPath, ["diff", "HEAD", "--no-color", "--no-ext-diff"]);
        blocks.push({
          title: "Git changes",
          body:
            result.code === 0
              ? truncateMiddle(result.stdout || "No changes.", maximumGitCharacters)
              : "Not a Git repository.",
          language: "diff",
        });
        break;
      }
      case "image":
        images.push({ mimeType: attachment.mimeType, data: attachment.data });
        break;
    }
  }
  let context = formatContext(blocks);
  if (settings.redactSecrets) context = redactSecrets(context).text;
  return { context, images, labels, warnings };
}

/** Suggestions for the `@` menu: special context first, then matching files. */
export class MentionProvider {
  private cache: { root: string; files: string[]; time: number } | undefined;

  async suggest(root: vscode.Uri, query: string, settings: Settings): Promise<MentionItem[]> {
    const lower = query.toLowerCase();
    const all: MentionItem[] = [
      { label: "@problems", detail: "Errors and warnings", attachment: { kind: "problems" } },
      { label: "@git", detail: "Uncommitted changes", attachment: { kind: "git" } },
      { label: "@terminal", detail: "Last terminal command and output", attachment: { kind: "terminal", output: "" } },
    ];
    const specials = all.filter((item) => item.label.slice(1).startsWith(lower));
    const files = await this.files(root, settings);
    const open = vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === "file")
      .map((document) => resolveInside(root.fsPath, document.uri.fsPath))
      .filter((file): file is string => !!file)
      .map((file) => toRelative(root.fsPath, file));
    const ranked = [...new Set([...open, ...files])]
      .map((file) => ({ file, score: fuzzyScore(file, lower) + (open.includes(file) ? 5 : 0) }))
      .filter((item) => item.score > 0 || lower === "")
      .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
      .slice(0, 30);
    return [
      ...specials,
      ...ranked.map((item) => ({
        label: path.basename(item.file),
        detail: item.file,
        attachment: { kind: "file" as const, path: item.file },
      })),
    ];
  }

  private async files(root: vscode.Uri, settings: Settings): Promise<string[]> {
    if (this.cache && this.cache.root === root.fsPath && Date.now() - this.cache.time < 30_000) return this.cache.files;
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, "**/*"),
      "**/{node_modules,.git,dist,out,build,coverage,.venv,__pycache__,target}/**",
      10_000,
    );
    const files = uris
      .map((uri) => toRelative(root.fsPath, uri.fsPath))
      .filter((file) => !isSensitivePath(file, settings.sensitiveNames));
    this.cache = { root: root.fsPath, files, time: Date.now() };
    return files;
  }
}

/** Scores a path for a query: matching file names rank above matching folders. Zero means no match. */
export function fuzzyScore(file: string, query: string): number {
  if (!query) return 1;
  const lower = file.toLowerCase();
  const name = path.basename(lower);
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  if (lower.includes(query)) return 40;
  let position = 0;
  for (const character of query) {
    position = lower.indexOf(character, position);
    if (position < 0) return 0;
    position++;
  }
  return 10;
}
