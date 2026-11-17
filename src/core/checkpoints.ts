/** Original content of files before a checkpoint changed them. `null` means the file did not exist. */
export type FileSnapshot = ReadonlyMap<string, string | null>;

export interface Checkpoint {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  readonly files: Map<string, string | null>;
}

export interface RestoreWrite {
  readonly path: string;
  /** New content, or null to delete the file. */
  readonly content: string | null;
}

/**
 * Keeps the original state of every file that the agent changes.
 * Each user request starts a new checkpoint, and a restore reverts all later changes.
 */
export class CheckpointStore {
  private readonly checkpoints: Checkpoint[] = [];

  begin(id: string, label: string, now = Date.now()): Checkpoint {
    const checkpoint: Checkpoint = { id, label, createdAt: now, files: new Map() };
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /** Records the original content of a file once per checkpoint, before the first change. */
  record(path: string, original: string | null): void {
    const current = this.checkpoints.at(-1);
    if (!current) throw new Error("No checkpoint is active.");
    if (!current.files.has(path)) current.files.set(path, original);
  }

  list(): readonly Checkpoint[] {
    return this.checkpoints;
  }

  has(id: string): boolean {
    return this.checkpoints.some((checkpoint) => checkpoint.id === id);
  }

  /** Files that changed since the checkpoint started. */
  changedSince(id: string): string[] {
    const index = this.checkpoints.findIndex((checkpoint) => checkpoint.id === id);
    if (index < 0) return [];
    const paths = new Set<string>();
    for (const checkpoint of this.checkpoints.slice(index)) for (const path of checkpoint.files.keys()) paths.add(path);
    return [...paths].sort();
  }

  /**
   * Plans the writes that restore the workspace to the state before the checkpoint.
   * The checkpoint and all later checkpoints are removed.
   */
  restore(id: string): RestoreWrite[] {
    const index = this.checkpoints.findIndex((checkpoint) => checkpoint.id === id);
    if (index < 0) throw new Error("The checkpoint does not exist.");
    const originals = new Map<string, string | null>();
    for (const checkpoint of this.checkpoints.slice(index)) {
      for (const [path, content] of checkpoint.files) if (!originals.has(path)) originals.set(path, content);
    }
    this.checkpoints.splice(index);
    return [...originals].map(([path, content]) => ({ path, content }));
  }

  clear(): void {
    this.checkpoints.length = 0;
  }
}
