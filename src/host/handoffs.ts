import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatMessage, ModelClient } from "../core/chat";
import {
  agentsBlock,
  buildHandoffMessages,
  type CurrentState,
  continuePrompt,
  type HandoffMeta,
  handoffFileName,
  handoffFolder,
  handoffSchema,
  latestHandoff,
  parseHandoffMeta,
  parseNarrative,
  renderHandoff,
  type Staleness,
  staleness,
  upsertBlock,
} from "../core/handoff";
import { factsFromJournal, type HandoffNarrative, type JournalEvent, journalLine, parseJournal } from "../core/journal";
import type { Plan } from "../core/plan";
import { git } from "./git";
import { readSettings } from "./settings";

const sessionIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const maximumJournalBytes = 5_000_000;

export interface HandoffSummary {
  readonly path: string;
  readonly title: string;
  readonly status: HandoffMeta["status"];
  readonly created: string;
  readonly session?: string;
}

export interface HandoffTarget {
  readonly id: string;
  readonly title: string;
  readonly root: string;
  readonly history: readonly ChatMessage[];
  readonly plan: Plan;
  readonly client: ModelClient;
}

/** Writes the session journals and the handoff notes in `.phew/` of the workspace. */
export class HandoffService {
  private readonly started = new Set<string>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly latestByRoot = new Map<string, HandoffSummary | undefined>();
  private askedThisWindow = false;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly log: vscode.LogOutputChannel,
    private readonly onLatestChange: () => void,
  ) {}

  private enabled(): boolean {
    return readSettings().handoff.enabled && vscode.workspace.isTrusted;
  }

  private journalPath(root: string, session: string): string {
    return path.join(root, ".phew", "sessions", session, "journal.jsonl");
  }

  /** Appends an event. Writes for one session run one after another. Errors only go to the log. */
  record(root: string, session: string, title: string, event: JournalEvent): void {
    if (!this.enabled() || !sessionIdPattern.test(session)) return;
    const key = `${root}\n${session}`;
    const previous = this.writing.get(key) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const file = this.journalPath(root, session);
        const size = await fs.stat(file).then(
          (stat) => stat.size,
          () => -1,
        );
        if (size > maximumJournalBytes) return;
        let header = "";
        if (size < 0 || !this.started.has(key)) {
          this.started.add(key);
          if (size < 0) {
            await this.ensureGitignore(root);
            await fs.mkdir(path.dirname(file), { recursive: true });
            const { branch, head } = await this.gitState(root);
            header = journalLine({ t: "session", at: Date.now(), session, title, branch, head });
          }
        }
        await fs.appendFile(file, header + journalLine(event), "utf8");
      })
      .catch((error: unknown) => this.log.warn(`Could not write the journal: ${String(error)}`));
    this.writing.set(key, next);
  }

  private async readJournal(root: string, session: string): Promise<JournalEvent[]> {
    await this.writing.get(`${root}\n${session}`);
    try {
      return parseJournal(await fs.readFile(this.journalPath(root, session), "utf8"));
    } catch {
      return [];
    }
  }

  /** Keeps the journals out of Git, and the notes too unless the user shares them. */
  async ensureGitignore(root: string): Promise<void> {
    const file = path.join(root, ".phew", ".gitignore");
    const share = readSettings().handoff.share;
    const block = [
      "# phew:begin (managed by Phew)",
      "sessions/",
      ...(share === "commit" ? [] : ["handoff/"]),
      "# phew:end",
    ].join("\n");
    let content = "";
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      // A new file.
    }
    const start = content.indexOf("# phew:begin");
    const end = content.indexOf("# phew:end");
    const next =
      start >= 0 && end > start
        ? content.slice(0, start) + block + content.slice(end + "# phew:end".length)
        : `${content.replace(/\s*$/, "")}${content.trim() ? "\n\n" : ""}${block}\n`;
    if (next !== content) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, next, "utf8");
    }
  }

  private async gitState(root: string): Promise<{ branch?: string; head?: string }> {
    const [branch, head] = await Promise.all([
      git(root, ["rev-parse", "--abbrev-ref", "HEAD"], undefined, 10_000),
      git(root, ["rev-parse", "HEAD"], undefined, 10_000),
    ]);
    return {
      branch: branch.code === 0 ? branch.stdout.trim() || undefined : undefined,
      head: head.code === 0 ? head.stdout.trim() || undefined : undefined,
    };
  }

  private async fingerprints(root: string, files: readonly string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const file of files.slice(0, 100)) {
      const absolute = path.resolve(root, file);
      if (!absolute.startsWith(path.resolve(root) + path.sep)) continue;
      try {
        result[file] = createHash("sha256")
          .update(await fs.readFile(absolute))
          .digest("hex")
          .slice(0, 16);
      } catch {
        result[file] = "deleted";
      }
    }
    return result;
  }

  /** Writes a note for a session. Returns the relative path of the note. */
  async write(target: HandoffTarget, signal: AbortSignal): Promise<string | undefined> {
    if (!this.enabled()) return undefined;
    const settings = readSettings();
    const events = await this.readJournal(target.root, target.id);
    const facts = factsFromJournal(events);
    if (facts.tasks === 0 && target.history.length === 0) return undefined;
    const result = await target.client.complete(
      { messages: buildHandoffMessages({ history: target.history, facts, plan: target.plan }), tools: [], signal },
      () => {},
    );
    const narrative = parseNarrative(result.content, target.title, facts.previous);
    const { branch, head } = await this.gitState(target.root);
    const now = new Date();
    const meta: HandoffMeta = {
      schema: handoffSchema,
      title: narrative.title,
      status: narrative.status,
      session: target.id,
      created: now.toISOString(),
      branch,
      head,
      goal: target.plan.goal,
      check: facts.lastCheck ? { command: facts.lastCheck.command, passed: facts.lastCheck.passed } : undefined,
      fingerprints: await this.fingerprints(
        target.root,
        facts.files.map((file) => file.path),
      ),
      continues: facts.continuedFrom,
    };
    const markdown = renderHandoff({
      meta,
      narrative,
      facts,
      plan: target.plan,
      verifyCommand: settings.verifyCommand,
    });
    // One note per session: later notes of the same session replace it, so the folder stays readable.
    const existing = (await this.list(target.root)).find((item) => item.session === target.id);
    const relative = existing?.path ?? `${handoffFolder}/${handoffFileName(now, narrative.title, target.id)}`;
    await this.ensureGitignore(target.root);
    await fs.mkdir(path.join(target.root, handoffFolder), { recursive: true });
    await fs.writeFile(path.join(target.root, relative), markdown, "utf8");
    await fs.writeFile(path.join(target.root, latestHandoff), markdown, "utf8");
    this.record(target.root, target.id, target.title, { t: "handoff", at: Date.now(), file: relative, narrative });
    this.latestByRoot.set(target.root, {
      path: relative,
      title: meta.title,
      status: meta.status,
      created: meta.created,
      session: meta.session,
    });
    this.onLatestChange();
    this.log.info(`Handoff written: ${relative}`);
    void this.offerAgentsPointer(target.root);
    return relative;
  }

  /** All notes of a folder, newest first. */
  async list(root: string): Promise<(HandoffSummary & { readonly session: string })[]> {
    const folder = path.join(root, handoffFolder);
    let names: string[] = [];
    try {
      names = (await fs.readdir(folder)).filter((name) => name.endsWith(".md") && name !== "LATEST.md");
    } catch {
      return [];
    }
    const notes: (HandoffSummary & { session: string })[] = [];
    for (const name of names) {
      try {
        const meta = parseHandoffMeta(await fs.readFile(path.join(folder, name), "utf8"));
        if (meta)
          notes.push({
            path: `${handoffFolder}/${name}`,
            title: meta.title,
            status: meta.status,
            created: meta.created,
            session: meta.session,
          });
      } catch {
        // Skip a broken note.
      }
    }
    return notes.sort((a, b) => b.created.localeCompare(a.created));
  }

  /** The latest note of a folder, cached for the welcome screen. */
  latest(root: string): HandoffSummary | undefined {
    if (!this.latestByRoot.has(root)) {
      this.latestByRoot.set(root, undefined);
      void this.loadLatest(root);
    }
    return this.latestByRoot.get(root);
  }

  private async loadLatest(root: string): Promise<void> {
    try {
      const meta = parseHandoffMeta(await fs.readFile(path.join(root, latestHandoff), "utf8"));
      if (meta) {
        this.latestByRoot.set(root, {
          path: latestHandoff,
          title: meta.title,
          status: meta.status,
          created: meta.created,
          session: meta.session,
        });
        this.onLatestChange();
      }
    } catch {
      // No note yet.
    }
  }

  /** Reads a note and compares it with the current code. */
  async prepareContinue(
    root: string,
    relative = latestHandoff,
  ): Promise<
    { prompt: string; meta: HandoffMeta; state: Staleness; narrative?: HandoffNarrative; path: string } | undefined
  > {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root, ".phew") + path.sep)) return undefined;
    let markdown: string;
    try {
      markdown = await fs.readFile(absolute, "utf8");
    } catch {
      return undefined;
    }
    const meta = parseHandoffMeta(markdown);
    if (!meta) return undefined;
    const { branch, head } = await this.gitState(root);
    let commitsSince: number | undefined;
    let headReachable: boolean | undefined;
    if (meta.head && head && meta.head !== head) {
      const ancestor = await git(root, ["merge-base", "--is-ancestor", meta.head, head], undefined, 10_000);
      headReachable = ancestor.code === 0;
      if (headReachable) {
        const count = await git(root, ["rev-list", "--count", `${meta.head}..${head}`], undefined, 10_000);
        if (count.code === 0) commitsSince = Number(count.stdout.trim());
      }
    }
    const current: CurrentState = {
      branch,
      head,
      commitsSince,
      headReachable,
      fingerprints: await this.fingerprints(root, Object.keys(meta.fingerprints)),
    };
    const state = staleness(meta, current);
    // The decisions of the earlier session continue in the new one.
    const narrative = [...(await this.readJournal(root, meta.session))]
      .reverse()
      .find((event): event is Extract<JournalEvent, { t: "handoff" }> => event.t === "handoff")?.narrative;
    const shown =
      relative === latestHandoff
        ? ((await this.list(root)).find((note) => note.session === meta.session)?.path ?? relative)
        : relative;
    return { prompt: continuePrompt(shown, markdown, state), meta, state, narrative, path: shown };
  }

  /** Asks once whether Phew may point other agents to the notes in AGENTS.md. */
  private async offerAgentsPointer(root: string): Promise<void> {
    const mode = readSettings().handoff.agentsFile;
    if (mode === "never") return;
    const key = `phew.handoff.agents:${root}`;
    const answer = this.memento.get<string>(key);
    if (mode === "ask" && answer === "never") return;
    if (mode === "ask" && answer !== "yes") {
      if (this.askedThisWindow) return;
      this.askedThisWindow = true;
      const choice = await vscode.window.showInformationMessage(
        "Let any coding agent continue this work? Phew can add a short section to AGENTS.md that points to the latest handoff note. Codex, Copilot, Cursor, and others read AGENTS.md.",
        "Add",
        "Not now",
        "Never",
      );
      if (choice === "Never") await this.memento.update(key, "never");
      if (choice !== "Add") return;
      await this.memento.update(key, "yes");
    }
    await this.writeAgentsPointer(root);
  }

  async writeAgentsPointer(root: string): Promise<string[]> {
    const hasMemory = await fs.stat(path.join(root, ".phew", "memory.md")).then(
      () => true,
      () => false,
    );
    const block = agentsBlock(hasMemory);
    const written: string[] = [];
    // AGENTS.md is the open standard. Claude Code and Gemini CLI read their own files, so update those when they exist.
    for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      const file = path.join(root, name);
      let content: string | undefined;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        content = name === "AGENTS.md" ? "" : undefined;
      }
      if (content === undefined) continue;
      const next = upsertBlock(content, block);
      if (next !== content) {
        await fs.writeFile(file, next, "utf8");
        written.push(name);
      }
    }
    if (written.length > 0) this.log.info(`Handoff pointer updated in ${written.join(", ")}.`);
    return written;
  }
}
