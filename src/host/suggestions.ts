import * as path from "node:path";
import * as vscode from "vscode";
import type { Suggestion } from "../shared/protocol";
import { git } from "./git";
import { fileProblemsRequest } from "./phewIt";
import type { TaskRequest } from "./session";
import type { FailedCommand, TerminalWatcher } from "./terminalWatcher";

interface Action {
  readonly suggestion: Suggestion;
  readonly run: () => Promise<void>;
}

const ignored = /[\\/](node_modules|\.git|dist|out|build|\.next|target|vendor)[\\/]/;

/**
 * Real tasks for the welcome screen, from the state of the project: errors in Problems, a failed terminal command,
 * uncommitted changes, and the open file. The webview gets ids only; the actions stay here.
 */
export class SuggestionProvider {
  private actions = new Map<string, Action>();

  constructor(
    private readonly terminal: TerminalWatcher,
    private readonly start: (request: TaskRequest) => Promise<void>,
    private readonly fixFailedCommand: (failure: FailedCommand) => Promise<void>,
  ) {}

  async list(): Promise<Suggestion[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const actions: Action[] = [];

    // 1. The file with the most errors.
    const files = vscode.languages
      .getDiagnostics()
      .map(([uri, diagnostics]) => ({
        uri,
        errors: diagnostics.filter((item) => item.severity === vscode.DiagnosticSeverity.Error),
      }))
      .filter((item) => item.errors.length > 0 && item.uri.scheme === "file" && !ignored.test(item.uri.fsPath))
      .filter((item) => !folder || vscode.workspace.getWorkspaceFolder(item.uri))
      .sort((a, b) => b.errors.length - a.errors.length);
    const worst = files[0];
    if (worst) {
      const count = worst.errors.length;
      actions.push({
        suggestion: {
          id: "errors",
          title: `Fix ${count} ${count === 1 ? "error" : "errors"} in ${path.basename(worst.uri.fsPath)}`,
          detail: worst.errors[0].message.split("\n")[0].slice(0, 90),
          icon: "bug",
        },
        run: async () => {
          const document = await vscode.workspace.openTextDocument(worst.uri);
          const text = fileProblemsRequest(document);
          if (text)
            await this.start({
              text,
              display: `Fix the errors in ${vscode.workspace.asRelativePath(worst.uri)}`,
              kind: "fix",
              mode: "code",
            });
        },
      });
    }

    // 2. The last failed terminal command.
    const failure = this.terminal.lastFailure;
    if (failure) {
      const command = failure.command.length > 40 ? `${failure.command.slice(0, 39)}…` : failure.command;
      actions.push({
        suggestion: {
          id: "command",
          title: `Fix the failed ${command}`,
          detail:
            failure.exitCode !== undefined
              ? `It stopped with exit code ${failure.exitCode}.`
              : "It failed in the terminal.",
          icon: "terminal",
        },
        run: () => this.fixFailedCommand(failure),
      });
    }

    // 3. Uncommitted changes.
    if (folder) {
      const status = await git(folder.uri.fsPath, ["status", "--porcelain"], undefined, 5000);
      const changed = status.code === 0 ? status.stdout.split("\n").filter((line) => line.trim()).length : 0;
      if (changed > 0)
        actions.push({
          suggestion: {
            id: "review",
            title: `Review my ${changed} changed ${changed === 1 ? "file" : "files"}`,
            detail: "Find bugs and missing tests before you commit.",
            icon: "git",
          },
          run: () =>
            this.start({
              text: "Review my uncommitted changes. Use git_diff. List bugs, risks, and missing tests, the most important first, with file:line references. Do not change files.",
              display: "Review my uncommitted changes",
              kind: "chat",
              mode: "review",
            }),
        });
    }

    // 4. The open file.
    const editor = vscode.window.activeTextEditor?.document;
    if (editor && editor.uri.scheme === "file" && !ignored.test(editor.uri.fsPath)) {
      const name = vscode.workspace.asRelativePath(editor.uri);
      actions.push({
        suggestion: {
          id: "file",
          title: `Explain ${path.basename(editor.uri.fsPath)}`,
          detail: "What it does and where it is used.",
          icon: "file",
        },
        run: () =>
          this.start({
            text: `Explain ${name}: what it does, how it fits into the project, and where it is used. Keep it short.`,
            display: `Explain ${name}`,
            kind: "chat",
            mode: "ask",
          }),
      });
    }

    // 5. Always useful in a new project.
    if (folder)
      actions.push({
        suggestion: {
          id: "project",
          title: "Explain this project",
          detail: "The structure, how to run it, and where to start.",
          icon: "book",
        },
        run: () =>
          this.start({
            text: "Explain this project for a new developer: what it does, the structure, how to build, run, and test it, and the best place to start reading. Keep it short.",
            display: "Explain this project",
            kind: "chat",
            mode: "ask",
          }),
      });

    const top = actions.slice(0, 3);
    this.actions = new Map(top.map((action) => [action.suggestion.id, action]));
    return top.map((action) => action.suggestion);
  }

  async run(id: string): Promise<void> {
    await this.actions.get(id)?.run();
  }
}
