import * as os from "node:os";
import * as vscode from "vscode";
import {
  addNote,
  forgetNote,
  type MemoryNote,
  type MemoryScope,
  parseNotes,
  renderMemory,
  type SourceState,
} from "../core/memory";

export const memoryPath = ".phew/memory.md";

const read = async (uri: vscode.Uri): Promise<string> => {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return "";
  }
};

/**
 * The memory files: `.phew/memory.md` of the project and `~/.phew/memory.md` with personal preferences.
 * They are plain Markdown, so people can read and edit them.
 */
export class MemoryStore {
  uri(root: vscode.Uri, scope: MemoryScope = "project"): vscode.Uri {
    return scope === "personal"
      ? vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), ".phew", "memory.md")
      : vscode.Uri.joinPath(root, memoryPath);
  }

  /** The texts of the project notes. An untrusted workspace has none. */
  async read(root: vscode.Uri, scope: MemoryScope = "project"): Promise<string[]> {
    if (scope === "project" && !vscode.workspace.isTrusted) return [];
    return parseNotes(await read(this.uri(root, scope))).map((note) => note.text);
  }

  /**
   * The notes for a chat. A project note with a source file is marked when that file changed after the note
   * was saved, or is gone, so the agent checks it before it relies on it.
   */
  async notes(
    root: vscode.Uri,
  ): Promise<{ project: (MemoryNote & { state?: SourceState })[]; personal: MemoryNote[] }> {
    const personal = parseNotes(await read(this.uri(root, "personal")));
    if (!vscode.workspace.isTrusted) return { project: [], personal };
    const project = await Promise.all(
      parseNotes(await read(this.uri(root))).map(async (note) => {
        if (!note.source) return note;
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, note.source));
          // Saved during that day: a change on a later day means the fact may be old.
          const savedUntil = note.added ? Date.parse(`${note.added}T23:59:59`) : Number.POSITIVE_INFINITY;
          return { ...note, state: (stat.mtime > savedUntil ? "changed" : "unchanged") as SourceState };
        } catch {
          return { ...note, state: "missing" as SourceState };
        }
      }),
    );
    return { project, personal };
  }

  async add(
    root: vscode.Uri,
    note: string,
    options: { scope?: MemoryScope; source?: string; replaces?: string } = {},
  ): Promise<{ added: boolean; replaced: boolean }> {
    const scope = options.scope ?? "project";
    const uri = this.uri(root, scope);
    const result = addNote(await read(uri), note, {
      ...options,
      scope,
      added: new Date().toISOString().slice(0, 10),
    });
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(result.content));
    return { added: result.added, replaced: result.replaced };
  }

  /** Removes a note from the project memory or, when it is not there, from the personal memory. */
  async forget(root: vscode.Uri, note: string): Promise<MemoryScope | undefined> {
    for (const scope of ["project", "personal"] as const) {
      const uri = this.uri(root, scope);
      const next = forgetNote(await read(uri), note, scope);
      if (next === undefined) continue;
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
      return scope;
    }
    return undefined;
  }

  async open(root: vscode.Uri, scope: MemoryScope = "project"): Promise<void> {
    const uri = this.uri(root, scope);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(renderMemory([], scope)));
    }
    await vscode.window.showTextDocument(uri);
  }
}
