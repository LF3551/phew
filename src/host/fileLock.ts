import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Lets one writer at a time change a shared file, such as the memory that several chats and windows update.
 * Inside this window a queue orders the writers. Between windows a lock directory does it: creating a directory
 * either succeeds or fails at once on every system, so two windows never both get the lock.
 */

export interface LockOptions {
  /** How long to wait for another window before writing anyway, so an agent never hangs on a lock. */
  readonly timeoutMs?: number;
  /** A lock older than this is left over from a window that closed in the middle of a write. */
  readonly staleMs?: number;
  /** How the lock waits, for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const queues = new Map<string, Promise<void>>();

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `task` while no other writer in this window or in another window changes `file`. */
export async function withFileLock<T>(file: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const key = path.resolve(file);
  const previous = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn);
  queues.set(key, queued);
  await previous;
  try {
    return await betweenWindows(key, task, options);
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

async function betweenWindows<T>(file: string, task: () => Promise<T>, options: LockOptions): Promise<T> {
  const lock = `${file}.lock`;
  const timeout = options.timeoutMs ?? 5000;
  const stale = options.staleMs ?? 15_000;
  const sleep = options.sleep ?? wait;
  const started = Date.now();
  let locked = false;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
  } catch {
    // The task reports a folder that cannot be created.
  }
  for (let attempt = 0; !locked; attempt++) {
    try {
      await fs.mkdir(lock);
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
      const age = await fs.stat(lock).then(
        (stat) => Date.now() - stat.mtimeMs,
        () => 0,
      );
      if (age > stale) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= timeout) break;
      await sleep(Math.min(200, 10 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 10));
    }
  }
  try {
    return await task();
  } finally {
    if (locked) await fs.rm(lock, { recursive: true, force: true });
  }
}
