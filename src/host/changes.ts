import * as vscode from "vscode";
import type { ToolResult } from "../core/agent";
import type { CheckpointStore, RestoreWrite } from "../core/checkpoints";
import { applyHunks, computeHunks, formatHunk } from "../core/diff";
import type { ApprovalBroker } from "./approvals";
import type { ReviewManager } from "./reviewManager";
import type { ReviewMode } from "./settings";

export const diffScheme = "phew-diff";

/** Serves read-only documents for the diff editor. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? "";
  }

  register(relativePath: string, content: string): vscode.Uri {
    const id = `d${++this.counter}`;
    this.contents.set(id, content);
    if (this.contents.size > 200) this.contents.delete(this.contents.keys().next().value as string);
    return vscode.Uri.from({ scheme: diffScheme, path: `/${relativePath}`, query: id });
  }
}

/** Reads a file. Unsaved editor content wins over the content on disk. Returns null when the file does not exist. */
export async function readWorkspaceText(uri: vscode.Uri): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return null;
    throw error;
  }
}

async function writeWorkspaceText(uri: vscode.Uri, content: string, exists: boolean): Promise<void> {
  if (!exists) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code did not apply the edit.");
  await document.save();
}

/** Tells whether another running chat changed a file. Returns the title of that chat. */
export type FileClaims = (absolutePath: string) => string | undefined;

export interface ProposeOptions {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly newContent: string;
  readonly reviewMode: ReviewMode;
  readonly signal: AbortSignal;
}

/** Shows file changes as hunks, applies the hunks that the user selects, and records checkpoints. */
export class ChangeManager {
  constructor(
    private readonly broker: ApprovalBroker,
    private readonly diffs: DiffContentProvider,
    private readonly checkpoints: CheckpointStore,
    private readonly reviews: ReviewManager,
    private readonly claims: FileClaims = () => undefined,
    private readonly onWritten: (absolutePath: string) => void = () => {},
  ) {}

  async propose(options: ProposeOptions): Promise<ToolResult> {
    const { uri, relativePath, newContent } = options;
    const owner = this.claims(uri.fsPath);
    if (owner) {
      const answer = await this.broker.request(
        {
          kind: "command",
          title: `Change ${relativePath}?`,
          detail: relativePath,
          reason: `The chat "${owner}" is working and changed this file in its current task. Two chats that change one file can overwrite each other.`,
        },
        options.signal,
      );
      if (!answer.allowed)
        return {
          content: `The user did not allow the change, because another chat is changing ${relativePath}. Do not retry it.`,
        };
    }
    const original = await readWorkspaceText(uri);
    if (original === newContent) return { content: `No change: ${relativePath} already has this content.` };
    const hunks = computeHunks(original ?? "", newContent);
    let selected = new Set(hunks.map((hunk) => hunk.index));

    if (options.reviewMode === "chat") {
      const added = hunks.reduce((sum, hunk) => sum + hunk.newLines.length, 0);
      const removed = hunks.reduce((sum, hunk) => sum + hunk.oldLines.length, 0);
      const decision = await this.broker.request(
        {
          kind: "edit",
          title: `${original === null ? "Create" : "Edit"} ${relativePath}`,
          detail: `+${added} −${removed} lines in ${hunks.length} ${hunks.length === 1 ? "hunk" : "hunks"}`,
          hunks: hunks.map((hunk) => ({ index: hunk.index, preview: formatHunk(hunk) })),
          openDiff: () => {
            const left = this.diffs.register(relativePath, original ?? "");
            const right = this.diffs.register(relativePath, newContent);
            void vscode.commands.executeCommand("vscode.diff", left, right, `${relativePath} (Phew proposal)`, {
              preview: true,
            });
          },
        },
        options.signal,
      );
      if (!decision.allowed)
        return { content: `The user rejected the change to ${relativePath}. Do not retry it unchanged.` };
      if (decision.hunks) selected = new Set(decision.hunks.filter((index) => index < hunks.length));
      if (selected.size === 0) return { content: `The user applied no hunks to ${relativePath}.` };
    }

    const all = selected.size === hunks.length;
    const finalContent = all ? newContent : applyHunks(original ?? "", hunks, selected);
    this.checkpoints.record(relativePath, original);
    await writeWorkspaceText(uri, finalContent, original !== null);
    this.onWritten(uri.fsPath);
    if (options.reviewMode === "editor") this.reviews.track(uri, original ?? "");
    const skipped = hunks.filter((hunk) => !selected.has(hunk.index)).map((hunk) => hunk.index + 1);
    return {
      changed: true,
      content: all
        ? `Applied the change to ${relativePath}.${options.reviewMode === "editor" ? " The user can keep or undo it in the editor." : ""}`
        : `Applied ${selected.size} of ${hunks.length} hunks to ${relativePath}. The user skipped hunks ${skipped.join(", ")}. Read the file again before you edit it.`,
    };
  }

  /** Writes the planned restore of a checkpoint. `resolve` turns a recorded path into a file URI. */
  async restore(resolve: (path: string) => vscode.Uri | undefined, writes: readonly RestoreWrite[]): Promise<void> {
    for (const write of writes) {
      const uri = resolve(write.path);
      if (!uri) continue;
      if (write.content === null) {
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
        }
      } else {
        const exists = (await readWorkspaceText(uri)) !== null;
        await writeWorkspaceText(uri, write.content, exists);
      }
    }
  }
}
