import * as vscode from "vscode";
import { addNote, parseMemory } from "../core/memory";

export const memoryPath = ".phew/memory.md";

/** Project memory in `.phew/memory.md`. The file is plain Markdown, so the user can read and edit it. */
export class MemoryStore {
  uri(root: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(root, memoryPath);
  }

  async read(root: vscode.Uri): Promise<string[]> {
    if (!vscode.workspace.isTrusted) return [];
    try {
      return parseMemory(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri(root))));
    } catch {
      return [];
    }
  }

  async add(root: vscode.Uri, note: string): Promise<boolean> {
    let text = "";
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri(root)));
    } catch {
      // A new memory file.
    }
    const result = addNote(text, note);
    if (result.added) await vscode.workspace.fs.writeFile(this.uri(root), new TextEncoder().encode(result.content));
    return result.added;
  }

  async open(root: vscode.Uri): Promise<void> {
    const uri = this.uri(root);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(addNote("", "").content));
    }
    await vscode.window.showTextDocument(uri);
  }
}
