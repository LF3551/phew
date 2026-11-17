import * as vscode from "vscode";
import type { ModelClient } from "../core/chat";
import {
  buildCompletionMessages,
  buildNextEditMessages,
  cleanCompletion,
  parseNextEdit,
  type RecentEdit,
} from "../core/completion";
import { isSensitivePath } from "../core/secrets";
import type { ModelProfile } from "../providers/profile";
import type { ModelManager } from "./models";
import type { ReviewManager } from "./reviewManager";
import { readSettings, updateSetting } from "./settings";

/** Inline completions with the model of `phew.autocomplete.model` or a fast copy of the active model. */
export class CompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private cache: { key: string; text: string } | undefined;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);

  constructor(private readonly models: ModelManager) {
    this.status.command = "phew.toggleAutocomplete";
    this.update();
  }

  update(): void {
    const enabled = readSettings().autocomplete.enabled;
    this.status.text = enabled ? "$(sparkle) Tab" : "$(circle-slash) Tab";
    this.status.tooltip = enabled
      ? "Phew autocomplete is on. Click to turn it off."
      : "Phew autocomplete is off. Click to turn it on.";
    this.status.show();
  }

  async toggle(): Promise<void> {
    await updateSetting("autocomplete.enabled", !readSettings().autocomplete.enabled);
    this.update();
  }

  dispose(): void {
    this.status.dispose();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const settings = readSettings(document.uri);
    if (!settings.autocomplete.enabled && context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) return [];
    if (document.uri.scheme !== "file" || isSensitivePath(vscode.workspace.asRelativePath(document.uri, false)))
      return [];
    if (document.lineCount > 20_000) return [];
    const offset = document.offsetAt(position);
    const text = document.getText();
    const prefix = text.slice(0, offset);
    const suffix = text.slice(offset);
    const key = `${document.uri.toString()}:${document.version}:${offset}`;
    if (this.cache?.key === key)
      return [new vscode.InlineCompletionItem(this.cache.text, new vscode.Range(position, position))];

    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      await new Promise((resolve) => setTimeout(resolve, settings.autocomplete.debounceMs));
      if (token.isCancellationRequested) return [];
    }
    const client = await this.client(settings.autocomplete.model);
    if (!client) return [];
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      const completionContext = {
        path: vscode.workspace.asRelativePath(document.uri, false),
        language: document.languageId,
        prefix,
        suffix,
      };
      const result = await client.complete(
        { messages: buildCompletionMessages(completionContext), tools: [], signal: controller.signal },
        () => {},
      );
      if (token.isCancellationRequested) return [];
      const insert = cleanCompletion(result.content, completionContext, settings.autocomplete.maxLines);
      if (!insert) return [];
      this.cache = { key, text: insert };
      return [new vscode.InlineCompletionItem(insert, new vscode.Range(position, position))];
    } catch {
      return [];
    } finally {
      subscription.dispose();
    }
  }

  private async client(profileId: string): Promise<ModelClient | undefined> {
    const profiles = this.models.profiles().profiles;
    const profile = (profileId && profiles.find((item) => item.id === profileId)) || this.models.active();
    if (!profile) return undefined;
    const fast: ModelProfile = {
      ...profile,
      maxTokens: Math.min(profile.maxTokens ?? 256, 256),
      temperature: profile.temperature ?? 0.1,
    };
    return this.models.client(fast);
  }
}

/** Remembers the recent edits of each file and predicts the next edit on demand. */
export class NextEditPredictor implements vscode.Disposable {
  private readonly edits = new Map<string, RecentEdit[]>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly models: ModelManager,
    private readonly reviews: ReviewManager,
  ) {
    this.subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== "file" || event.contentChanges.length === 0) return;
      const list = this.edits.get(event.document.uri.toString()) ?? [];
      for (const change of event.contentChanges) {
        if (change.text.length > 2000 || change.rangeLength > 2000) continue;
        const line = change.range.start.line;
        list.push({
          line: line + 1,
          before: `(${change.rangeLength} characters replaced)`,
          after: event.document.lineAt(Math.min(line, event.document.lineCount - 1)).text,
        });
      }
      this.edits.set(event.document.uri.toString(), list.slice(-20));
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  async suggest(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const document = editor.document;
    const profiles = this.models.profiles().profiles;
    const settings = readSettings(document.uri);
    const profile =
      (settings.nextEditModel && profiles.find((item) => item.id === settings.nextEditModel)) || this.models.active();
    if (!profile) {
      void vscode.commands.executeCommand("phew.addModel");
      return;
    }
    const cursor = editor.selection.active.line;
    const windowStart = Math.max(0, cursor - 60);
    const windowEnd = Math.min(document.lineCount, cursor + 60);
    const windowLines: string[] = [];
    for (let line = windowStart; line < windowEnd; line++) windowLines.push(document.lineAt(line).text);
    const recentEdits = this.edits.get(document.uri.toString()) ?? [];

    const edit = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Phew: predicting the next edit…", cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        const client = await this.models.client({ ...profile, temperature: profile.temperature ?? 0 });
        const result = await client.complete(
          {
            messages: buildNextEditMessages({
              path: vscode.workspace.asRelativePath(document.uri, false),
              language: document.languageId,
              windowStart: windowStart + 1,
              windowLines,
              cursorLine: cursor + 1,
              recentEdits,
            }),
            tools: [],
            signal: controller.signal,
          },
          () => {},
        );
        return parseNextEdit(result.content, document.lineCount);
      },
    );
    if (!edit) {
      void vscode.window.setStatusBarMessage("Phew: no next edit predicted.", 3000);
      return;
    }
    const original = document.getText();
    const start = new vscode.Position(edit.startLine - 1, 0);
    const range =
      edit.endLine >= edit.startLine
        ? new vscode.Range(start, document.lineAt(edit.endLine - 1).rangeIncludingLineBreak.end)
        : new vscode.Range(start, start);
    const replacement =
      edit.replacement.endsWith("\n") || edit.endLine === document.lineCount
        ? edit.replacement
        : `${edit.replacement}\n`;
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, replacement);
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) return;
    this.reviews.track(document.uri, original);
    editor.selection = new vscode.Selection(start, start);
    editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
