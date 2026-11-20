import * as os from "node:os";
import * as vscode from "vscode";
import { buildReport, formFields, issueUrl, type ReportFacts } from "../core/report";
import { type ModelManager, providerNames } from "./models";
import { readSettings } from "./settings";
import { userShell } from "./shellScripts";
import { ptyLoadError, shellHealingSummary } from "./shellSession";

const repository = "LF3551/phew";

/** The facts of a report: versions, system, shell, model, safe settings, and the recent log. */
export function reportFacts(models: ModelManager, recentLog: () => string[], version: string): ReportFacts {
  const settings = readSettings();
  const model = models.active();
  return {
    phew: version,
    editor: { name: vscode.env.appName, version: vscode.version, remote: vscode.env.remoteName },
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    language: vscode.env.language,
    shell: {
      path: userShell(settings.commandsShell || undefined),
      terminal: settings.commandsTerminal,
      startupFiles: settings.commandsStartupFiles,
      healing: shellHealingSummary(),
      ...(ptyLoadError() ? { ptyError: ptyLoadError() } : {}),
    },
    ...(model ? { model: { provider: providerNames[model.provider], model: model.model } } : {}),
    // Modes and switches only: no addresses, lists, names, or commands.
    settings: {
      "agent.defaultMode": settings.defaultMode,
      "agent.maxSteps": settings.maxSteps,
      "review.mode": settings.reviewMode,
      "commands.approval": settings.commands.mode,
      "commands.timeoutSeconds": settings.commandTimeoutSeconds,
      "verify.command": settings.verifyCommand ? "set" : "empty",
      "memory.enabled": settings.memoryEnabled,
      "index.enabled": settings.index.enabled,
      "autocomplete.enabled": settings.autocomplete.enabled,
      "subagents.enabled": settings.subagents.enabled,
      "subagents.maxParallel": settings.subagents.maxParallel,
      "handoff.auto": settings.handoff.auto,
      "context.autoCompact": settings.autoCompact,
      "connection.maxRetries": settings.maxRetries,
      "mcp.servers": Object.keys(settings.mcpServers ?? {}).length,
    },
    log: recentLog().slice(-80),
  };
}

/**
 * Phew: Report a Problem. Asks what went wrong, shows the report in an editor, and opens a GitHub issue only when
 * the user chooses so. With `description`, it skips the question and only returns the report (for tests).
 */
export async function reportProblem(
  models: ModelManager,
  recentLog: () => string[],
  version: string,
  options: { description?: string } = {},
): Promise<string | undefined> {
  const description =
    options.description ??
    (await vscode.window.showInputBox({
      title: "Phew: Report a Problem",
      prompt: "What went wrong? You can also write it on GitHub. Nothing is sent yet.",
      placeHolder: "For example: the terminal of the chat hangs after npm install",
      ignoreFocusOut: true,
    }));
  if (description === undefined) return undefined;
  const facts = reportFacts(models, recentLog, version);
  const parts = {
    home: os.homedir(),
    user: os.userInfo().username,
    workspaces: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  };
  const report = buildReport(facts, description, parts);
  if (options.description !== undefined) return report;

  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
  await vscode.window.showTextDocument(document, { preview: true });
  // The title comes from the description after the cleaning, so it carries no path or secret either.
  const fields = formFields(facts, description, parts);
  const title = `Bug: ${fields.what?.split("\n")[0]?.slice(0, 70) || "a problem with Phew"}`;
  const answer = await vscode.window.showInformationMessage(
    "This is the report. It has no secrets, no user name, and no project folders. Nothing leaves your computer until you open the issue.",
    "Open GitHub Issue",
    "Copy Report",
  );
  // The report as the user sees it in the editor, with any changes the user made there.
  const final = document.getText();
  if (answer === "Copy Report") {
    await vscode.env.clipboard.writeText(final);
    void vscode.window.showInformationMessage("Phew: the report is in the clipboard.");
  } else if (answer === "Open GitHub Issue") {
    const link = issueUrl(repository, title, fields, final);
    if (!link.complete) {
      await vscode.env.clipboard.writeText(final);
      void vscode.window.showInformationMessage(
        "Phew: the report is long, so it is in the clipboard. Paste it into the issue.",
      );
    }
    await vscode.env.openExternal(vscode.Uri.parse(link.url));
  }
  return final;
}
