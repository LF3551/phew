import * as vscode from "vscode";
import { toRelative } from "../core/paths";
import { buildFixRequest, type ProblemContext } from "../core/prompts";

export const fixProblemCommand = "phew.fixProblem";

/** Offers "Phew it!" on every error and warning in the editor. */
export class PhewItCodeActionProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!vscode.workspace.getWorkspaceFolder(document.uri)) return [];
    return context.diagnostics
      .filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning)
      .slice(0, 3)
      .map((diagnostic) => {
        const action = new vscode.CodeAction("Phew it! Fix with Phew", vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.command = {
          command: fixProblemCommand,
          title: "Phew it!",
          arguments: [document.uri, diagnostic],
        };
        return action;
      });
  }
}

/** Builds the context of one problem with the source lines around it. */
export function problemContext(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): ProblemContext {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const path = folder ? toRelative(folder.uri.fsPath, document.uri.fsPath) : document.uri.fsPath;
  const first = Math.max(0, diagnostic.range.start.line - 6);
  const last = Math.min(document.lineCount - 1, diagnostic.range.end.line + 6);
  const width = String(last + 1).length;
  const excerpt: string[] = [];
  for (let line = first; line <= last; line++) {
    const marker = line >= diagnostic.range.start.line && line <= diagnostic.range.end.line ? ">" : " ";
    excerpt.push(`${marker}${String(line + 1).padStart(width)}| ${document.lineAt(line).text}`);
  }
  const code =
    typeof diagnostic.code === "object" && diagnostic.code !== null ? String(diagnostic.code.value) : diagnostic.code;
  return {
    path,
    line: diagnostic.range.start.line + 1,
    severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
    message: diagnostic.message,
    source: diagnostic.source,
    code: code === undefined ? undefined : String(code),
    excerpt: excerpt.join("\n"),
  };
}

/** Builds one request that fixes all errors in a file. */
export function fileProblemsRequest(document: vscode.TextDocument): string | undefined {
  const errors = vscode.languages
    .getDiagnostics(document.uri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
    .slice(0, 30);
  if (errors.length === 0) return undefined;
  const contexts = errors.map((diagnostic) => problemContext(document, diagnostic));
  return [
    `Fix all ${errors.length} errors in ${contexts[0].path}:`,
    ...contexts.map(
      (context) => `- Line ${context.line}: ${context.message}${context.source ? ` [${context.source}]` : ""}`,
    ),
    "",
    "Read the file first. Fix the root causes with the smallest correct changes.",
  ].join("\n");
}

export { buildFixRequest };
