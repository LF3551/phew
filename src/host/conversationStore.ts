import * as vscode from "vscode";
import type { ChatMessage } from "../core/chat";
import type { SerializedCheckpoint } from "../core/checkpoints";
import type { Plan } from "../core/plan";
import type { CommandSetting, HistoryItem, HostMessage, ReviewSetting } from "../shared/protocol";

export interface StoredConversation {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly mode: string;
  readonly root: string;
  readonly worktree?: { readonly path: string; readonly branch: string; readonly repository: string };
  readonly history: ChatMessage[];
  readonly transcript: HostMessage[];
  readonly checkpoints: SerializedCheckpoint[];
  readonly tokens: number;
  readonly cost: number;
  readonly plan?: Plan;
  readonly overrides?: { readonly review?: ReviewSetting; readonly commands?: CommandSetting; readonly mcp?: boolean };
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** Removes image data before saving. The text of the conversation stays. */
function withoutImages(history: readonly ChatMessage[]): ChatMessage[] {
  return history.map((message) =>
    message.role === "user" && message.images && message.images.length > 0
      ? { role: "user", content: `${message.content}\n[${message.images.length} image(s) were attached]` }
      : message,
  );
}

/** Saves conversations as JSON files in the extension storage of the workspace. */
export class ConversationStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: vscode.Uri,
    private readonly limit: () => number,
  ) {}

  async list(): Promise<HistoryItem[]> {
    return (await this.readIndex()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<StoredConversation | undefined> {
    if (!idPattern.test(id)) return undefined;
    try {
      const data = JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file(id))),
      ) as StoredConversation;
      return data.version === 1 && data.id === id ? data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Saves a conversation. Saves run one after another so the index stays consistent. */
  save(conversation: StoredConversation): Promise<void> {
    this.writing = this.writing.then(async () => {
      await vscode.workspace.fs.createDirectory(this.directory);
      const data: StoredConversation = { ...conversation, history: withoutImages(conversation.history) };
      await vscode.workspace.fs.writeFile(this.file(conversation.id), new TextEncoder().encode(JSON.stringify(data)));
      const index = (await this.readIndex()).filter((item) => item.id !== conversation.id);
      index.push({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        messages: conversation.history.filter((message) => message.role === "user").length,
        ...(conversation.worktree ? { worktree: conversation.worktree.branch } : {}),
      });
      index.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const removed of index.splice(this.limit())) await this.remove(removed.id);
      await this.writeIndex(index);
    });
    return this.writing;
  }

  delete(id: string): Promise<void> {
    this.writing = this.writing.then(async () => {
      await this.remove(id);
      await this.writeIndex((await this.readIndex()).filter((item) => item.id !== id));
    });
    return this.writing;
  }

  private file(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.directory, `${id}.json`);
  }

  private async remove(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.file(id));
    } catch {
      // Already removed.
    }
  }

  private async readIndex(): Promise<HistoryItem[]> {
    try {
      const data = JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(this.indexFile())),
      ) as unknown;
      return Array.isArray(data)
        ? (data as HistoryItem[]).filter((item) => typeof item?.id === "string" && idPattern.test(item.id))
        : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(index: readonly HistoryItem[]): Promise<void> {
    await vscode.workspace.fs.writeFile(this.indexFile(), new TextEncoder().encode(JSON.stringify(index)));
  }

  private indexFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.directory, "index.json");
  }
}
