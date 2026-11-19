import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { withFileLock } from "../src/host/fileLock";

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "phew-lock-"));
  file = path.join(directory, ".phew", "memory.md");
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

/** Reads, waits a moment, and writes: the pattern that loses lines without a lock. */
async function appendSlowly(target: string, line: string): Promise<void> {
  const before = await fs.readFile(target, "utf8").catch(() => "");
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
  await fs.writeFile(target, `${before}${line}\n`);
}

const lines = async (target: string) => (await fs.readFile(target, "utf8")).split("\n").filter(Boolean);

describe("withFileLock", () => {
  test("chats in one window never lose a note", async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_, index) => withFileLock(file, () => appendSlowly(file, `note ${index}`))),
    );
    const written = await lines(file);
    expect(written).toHaveLength(60);
    expect(new Set(written).size).toBe(60);
  });

  test("without the lock the same writes lose notes, so the test above means something", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await Promise.all(Array.from({ length: 60 }, (_, index) => appendSlowly(file, `note ${index}`)));
    expect((await lines(file)).length).toBeLessThan(60);
  });

  test("windows, that is separate processes, never lose a note", async () => {
    const bundle = path.join(directory, "lock.cjs");
    buildSync({
      entryPoints: [path.join(__dirname, "../src/host/fileLock.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      logLevel: "silent",
    });
    const worker = path.join(directory, "worker.cjs");
    await fs.writeFile(
      worker,
      `const fs = require("node:fs/promises");
const { withFileLock } = require(${JSON.stringify(bundle)});
const [file, name, count] = process.argv.slice(2);
(async () => {
  for (let index = 0; index < Number(count); index++) {
    await withFileLock(file, async () => {
      const before = await fs.readFile(file, "utf8").catch(() => "");
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
      await fs.writeFile(file, before + name + " " + index + "\\n");
    }, { timeoutMs: 30000 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
`,
    );
    const run = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [worker, file, name, "25"], { stdio: ["ignore", "ignore", "inherit"] });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      });
    const codes = await Promise.all(["a", "b", "c", "d"].map(run));
    expect(codes).toEqual([0, 0, 0, 0]);
    const written = await lines(file);
    expect(written).toHaveLength(100);
    expect(new Set(written).size).toBe(100);
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
  }, 60_000);

  test("waits while another window holds the lock", async () => {
    await fs.mkdir(`${file}.lock`, { recursive: true });
    const order: string[] = [];
    const task = withFileLock(
      file,
      async () => {
        order.push("task");
      },
      { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push("released");
    await fs.rm(`${file}.lock`, { recursive: true });
    await task;
    expect(order).toEqual(["released", "task"]);
  });

  test("takes over a lock that a closed window left behind", async () => {
    await fs.mkdir(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.lock`, old, old);
    const started = Date.now();
    await withFileLock(file, async () => {});
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
  });

  test("writes anyway after the timeout, so an agent never hangs", async () => {
    await fs.mkdir(`${file}.lock`, { recursive: true });
    let ran = false;
    await withFileLock(
      file,
      async () => {
        ran = true;
      },
      { timeoutMs: 50 },
    );
    expect(ran).toBe(true);
    // The lock of the other window stays: it is not ours.
    await expect(fs.stat(`${file}.lock`)).resolves.toBeTruthy();
  });

  test("frees the lock when the task fails, and the next writer goes on", async () => {
    await expect(
      withFileLock(file, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
    await expect(withFileLock(file, async () => "next")).resolves.toBe("next");
  });

  test("different files do not wait for each other", async () => {
    const other = path.join(directory, "other.md");
    let releaseFirst = () => {};
    const first = withFileLock(
      file,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await expect(withFileLock(other, async () => "free")).resolves.toBe("free");
    releaseFirst();
    await first;
  });

  test("returns the value of the task", async () => {
    await expect(withFileLock(file, async () => 42)).resolves.toBe(42);
  });
});
