import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildCommitMessages,
  describeCommitIdentity,
  effectiveIdentity,
  finalizeCommitMessage,
  parseAuthor,
  willSign,
} from "../core/commit";
import { diffForCommit, git, gitIdentity, recentSubjects, repositoryRoot } from "./git";
import type { ModelManager } from "./models";
import { readSettings } from "./settings";

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
}

function gitApi(): GitApi | undefined {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  return extension?.isActive ? extension.exports.getAPI(1) : undefined;
}

/** Finds the repository of a Source Control view, of the active editor, or of the first workspace folder. */
async function findRepository(source?: unknown): Promise<{ root: string; repository?: GitRepository } | undefined> {
  const api = gitApi();
  const editor = vscode.window.activeTextEditor?.document.uri;
  const folders: string[] = [
    (source as { rootUri?: vscode.Uri } | undefined)?.rootUri?.fsPath,
    editor?.scheme === "file" ? path.dirname(editor.fsPath) : undefined,
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  ].filter((folder): folder is string => !!folder);
  for (const folder of folders) {
    const root = await repositoryRoot(folder);
    if (root) return { root, repository: api?.repositories.find((item) => item.rootUri.fsPath === root) };
  }
  return undefined;
}

/** Generates and commits messages with the configured style, identity, and signing. */
export class CommitAssistant {
  constructor(
    private readonly models: ModelManager,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async generate(source?: unknown): Promise<string | undefined> {
    const found = await findRepository(source);
    if (!found) {
      void vscode.window.showWarningMessage("Phew: no Git repository found.");
      return undefined;
    }
    const settings = readSettings().commit;
    const profiles = this.models.profiles().profiles;
    const profile = (settings.model && profiles.find((item) => item.id === settings.model)) || this.models.active();
    if (!profile) {
      void vscode.commands.executeCommand("phew.addModel");
      return undefined;
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "Phew is writing the commit message…",
        cancellable: true,
      },
      async (_progress, token) => {
        const { diff, staged } = await diffForCommit(found.root);
        if (!diff.trim()) {
          void vscode.window.showInformationMessage("Phew: there are no changes to describe.");
          return undefined;
        }
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        const client = await this.models.client(profile);
        let raw = "";
        try {
          const result = await client.complete(
            {
              messages: buildCommitMessages(diff, settings, await recentSubjects(found.root)),
              tools: [],
              signal: controller.signal,
            },
            () => {},
          );
          raw = result.content;
        } catch (error) {
          if (!controller.signal.aborted) {
            void vscode.window.showErrorMessage(`Phew: ${error instanceof Error ? error.message : String(error)}`);
          }
          return undefined;
        }
        const identity = effectiveIdentity(settings, await gitIdentity(found.root));
        const message = finalizeCommitMessage(raw, settings, identity);
        if (found.repository) found.repository.inputBox.value = message;
        if (!staged) {
          void vscode.window.showInformationMessage(
            "Phew described all uncommitted changes, because nothing is staged. Stage the files that you want to commit.",
          );
        }
        this.log.info(`Commit message generated with ${profile.id}.`);
        return message;
      },
    );
  }

  /** Generates a message, lets the user edit it, and commits the staged changes with the configured options. */
  async commit(source?: unknown): Promise<void> {
    const found = await findRepository(source);
    if (!found) {
      void vscode.window.showWarningMessage("Phew: no Git repository found.");
      return;
    }
    const staged = await git(found.root, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) {
      void vscode.window.showInformationMessage("Phew: stage the changes that you want to commit first.");
      return;
    }
    const current = found.repository?.inputBox.value.trim();
    const message = current || (await this.generate(source));
    if (!message) return;
    const settings = readSettings().commit;
    const gitConfig = await gitIdentity(found.root);
    const edited = await vscode.window.showInputBox({
      title: "Phew: Commit",
      prompt: describeCommitIdentity(settings, gitConfig),
      value: message.replace(/\n/g, " ⏎ "),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "Enter a commit message."),
    });
    if (!edited) return;
    const finalMessage = edited.replace(/ ⏎ /g, "\n");
    const args = ["commit", "-F", "-"];
    if (settings.signOff && !/^Signed-off-by:/m.test(finalMessage)) args.push("--signoff");
    if (settings.gpgSign === "always") args.push("--gpg-sign");
    if (settings.gpgSign === "never") args.push("--no-gpg-sign");
    const author = parseAuthor(settings.author);
    if (author) args.push(`--author=${author.name} <${author.email}>`);
    const result = await git(found.root, args, finalMessage);
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        `Phew: git commit failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      );
      return;
    }
    if (found.repository) found.repository.inputBox.value = "";
    this.log.info(`[audit] commit created (signed=${willSign(settings, gitConfig)}, signoff=${settings.signOff})`);
    void vscode.window.showInformationMessage(`Phew! Committed: ${finalMessage.split("\n")[0]}`);
  }

  /** Shows which identity and signing commits use. */
  async showIdentity(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const settings = readSettings().commit;
    const answer = await vscode.window.showInformationMessage(
      "Phew commit identity",
      { modal: true, detail: describeCommitIdentity(settings, await gitIdentity(folder.uri.fsPath)) },
      "Open Commit Settings",
    );
    if (answer) await vscode.commands.executeCommand("workbench.action.openSettings", "phew.commit");
  }
}
