import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { CodeIndex, type SearchHit } from "../core/codeIndex";
import { toRelative } from "../core/paths";
import { isSensitivePath } from "../core/secrets";
import { embed } from "../providers/embeddings";
import type { ModelManager } from "./models";
import { readSettings } from "./settings";

const defaultExclude = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/.next/**",
  "**/*.min.*",
  "**/*.lock",
  "**/package-lock.json",
];

const textExtensions =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|cpp|cc|c|h|hpp|rb|php|swift|scala|sh|bash|zsh|ps1|sql|md|mdx|txt|json|jsonc|yaml|yml|toml|ini|tf|hcl|proto|graphql|gql|vue|svelte|astro|html|css|scss|less|xml|gradle|cmake|dockerfile|ex|exs|erl|clj|lua|dart|r|jl|zig|nim|sol)$/i;
const maximumFileBytes = 400_000;
const embeddingBatch = 64;
const maximumEmbeddedChunks = 4000;

interface State {
  index: CodeIndex;
  ready?: Promise<void>;
  saveTimer?: ReturnType<typeof setTimeout>;
}

export interface IndexStatus {
  readonly files: number;
  readonly chunks: number;
  readonly building: boolean;
}

/** Builds, updates, and searches the code index of each workspace root. */
export class CodeIndexManager implements vscode.Disposable {
  private readonly states = new Map<string, State>();
  private building = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly storage: vscode.Uri,
    private readonly models: ModelManager,
    private readonly log: vscode.LogOutputChannel,
    private readonly onStatus: () => void,
  ) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => void this.updateFile(document.uri)),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) for (const state of this.states.values()) state.index.removeFile(uri.fsPath);
      }),
    );
  }

  status(root: vscode.Uri): IndexStatus {
    const state = this.states.get(root.fsPath);
    return { files: state?.index.fileCount ?? 0, chunks: state?.index.chunkCount ?? 0, building: this.building > 0 };
  }

  async search(root: vscode.Uri, query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
    const state = await this.ensure(root);
    let vector: number[] | undefined;
    const embedder = await this.embedder();
    if (embedder) {
      try {
        [vector] = await embed(embedder.profile, embedder.apiKey, embedder.model, [query], signal);
      } catch (error) {
        this.log.warn(`Query embedding failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return state.index.search(query, limit, vector);
  }

  async rebuild(root: vscode.Uri): Promise<IndexStatus> {
    this.states.delete(root.fsPath);
    try {
      await vscode.workspace.fs.delete(this.file(root));
    } catch {
      // Nothing saved yet.
    }
    await this.ensure(root);
    return this.status(root);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const state of this.states.values()) if (state.saveTimer) clearTimeout(state.saveTimer);
  }

  /** Loads the saved index and updates the files that changed since then. */
  private async ensure(root: vscode.Uri): Promise<State> {
    let state = this.states.get(root.fsPath);
    if (!state) {
      state = { index: await this.load(root) };
      this.states.set(root.fsPath, state);
      const current = state;
      current.ready = this.sync(root, current).finally(() => {
        current.ready = undefined;
      });
    }
    if (state.ready) await state.ready;
    return state;
  }

  private async sync(root: vscode.Uri, state: State): Promise<void> {
    const settings = readSettings(root).index;
    this.building++;
    this.onStatus();
    const started = Date.now();
    try {
      const exclude = `{${[...defaultExclude, ...settings.exclude].join(",")}}`;
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, "**/*"),
        exclude,
        settings.maxFiles,
      );
      const seen = new Set<string>();
      let changed = 0;
      for (const uri of files) {
        const relative = toRelative(root.fsPath, uri.fsPath);
        if (!textExtensions.test(uri.fsPath) && !/(^|\/)(Dockerfile|Makefile|README)$/i.test(relative)) continue;
        if (isSensitivePath(relative, readSettings(root).sensitiveNames)) continue;
        seen.add(uri.fsPath);
        if (await this.indexFile(state.index, uri)) changed++;
      }
      for (const path of state.index.paths()) if (!seen.has(path)) state.index.removeFile(path);
      await this.embedMissing(state.index);
      this.log.info(
        `Code index: ${state.index.fileCount} files, ${state.index.chunkCount} chunks, ${changed} updated in ${Date.now() - started} ms.`,
      );
      this.scheduleSave(root, state);
    } finally {
      this.building--;
      this.onStatus();
    }
  }

  private async indexFile(index: CodeIndex, uri: vscode.Uri): Promise<boolean> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      index.removeFile(uri.fsPath);
      return false;
    }
    if (stat.size > maximumFileBytes) return false;
    const stamp = `${stat.mtime}:${stat.size}`;
    if (index.stamp(uri.fsPath) === stamp) return false;
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    if (text.includes("\0")) return false;
    // Paths in the index are absolute, and the hits show them relative to the root.
    index.setFile(uri.fsPath, stamp, text);
    return true;
  }

  private async updateFile(uri: vscode.Uri): Promise<void> {
    for (const [rootPath, state] of this.states) {
      if (!uri.fsPath.startsWith(rootPath)) continue;
      const root = vscode.Uri.file(rootPath);
      if (!textExtensions.test(uri.fsPath) || isSensitivePath(toRelative(rootPath, uri.fsPath))) continue;
      if (await this.indexFile(state.index, uri)) {
        await this.embedMissing(state.index);
        this.scheduleSave(root, state);
      }
    }
  }

  private async embedder() {
    const settings = readSettings().index;
    if (!settings.embeddingProfile || !settings.embeddingModel) return undefined;
    const profile = this.models.profiles().profiles.find((item) => item.id === settings.embeddingProfile);
    if (!profile) return undefined;
    return { profile, model: settings.embeddingModel, apiKey: await this.models.apiKey(profile) };
  }

  private async embedMissing(index: CodeIndex): Promise<void> {
    const embedder = await this.embedder();
    if (!embedder) return;
    const apiKey = embedder.apiKey;
    let embedded = 0;
    for (const path of index.paths()) {
      if (index.hasVectors(path)) continue;
      const chunks = index.chunks(path);
      if (embedded + chunks.length > maximumEmbeddedChunks) break;
      try {
        const vectors: number[][] = [];
        for (let start = 0; start < chunks.length; start += embeddingBatch) {
          const batch = chunks
            .slice(start, start + embeddingBatch)
            .map((chunk) => `${chunk.path}\n${chunk.text}`.slice(0, 6000));
          vectors.push(...(await embed(embedder.profile, apiKey, embedder.model, batch, AbortSignal.timeout(60_000))));
        }
        index.setVectors(path, vectors);
        embedded += chunks.length;
      } catch (error) {
        this.log.warn(`Embeddings failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }

  private file(root: vscode.Uri): vscode.Uri {
    const hash = createHash("sha256").update(root.fsPath).digest("hex").slice(0, 16);
    return vscode.Uri.joinPath(this.storage, "index", `${hash}.json`);
  }

  private async load(root: vscode.Uri): Promise<CodeIndex> {
    try {
      return CodeIndex.fromJSON(
        JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file(root)))),
      );
    } catch {
      return new CodeIndex();
    }
  }

  private scheduleSave(root: vscode.Uri, state: State): void {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      void (async () => {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.storage, "index"));
        await vscode.workspace.fs.writeFile(
          this.file(root),
          new TextEncoder().encode(JSON.stringify(state.index.toJSON())),
        );
      })().catch((error: unknown) => this.log.warn(`Could not save the code index: ${String(error)}`));
    }, 2000);
  }
}

/** Converts absolute paths of hits to workspace-relative paths. */
export function relativeHits(root: vscode.Uri, hits: readonly SearchHit[]): SearchHit[] {
  return hits.map((hit) => ({ ...hit, path: toRelative(root.fsPath, hit.path) }));
}
