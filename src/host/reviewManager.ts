import * as vscode from "vscode";
import { hunkAnchorLine, keepHunk, reviewHunks, undoHunk } from "../core/review";

interface Review {
  readonly uri: vscode.Uri;
  original: string;
}

/**
 * Shows the agent's changes in the editor with Keep and Undo buttons for each hunk.
 * The change is already in the file; Undo restores the original lines of one hunk.
 */
export class ReviewManager implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly reviews = new Map<string, Review>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly onCountChange: (files: number) => void) {
    this.disposables.push(
      this.changed,
      this.added,
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.reviews.has(event.document.uri.toString())) this.refresh();
      }),
    );
  }

  get pendingFiles(): vscode.Uri[] {
    return [...this.reviews.values()].map((review) => review.uri);
  }

  /** Starts or continues the review of a file. The first original content wins. */
  track(uri: vscode.Uri, original: string): void {
    const key = uri.toString();
    if (!this.reviews.has(key)) this.reviews.set(key, { uri, original });
    this.refresh();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const review = this.reviews.get(document.uri.toString());
    if (!review) return [];
    const hunks = reviewHunks({ original: review.original, current: document.getText() });
    if (hunks.length === 0) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, {
        title: `$(sparkle) Phew: ${hunks.length} ${hunks.length === 1 ? "change" : "changes"} to review`,
        command: "",
      }),
      new vscode.CodeLens(top, { title: "Keep All", command: "phew.review.keepFile", arguments: [document.uri] }),
      new vscode.CodeLens(top, { title: "Undo All", command: "phew.review.undoFile", arguments: [document.uri] }),
    ];
    for (const hunk of hunks) {
      const line = hunkAnchorLine(hunk, document.lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      const summary = `+${hunk.newLines.length} −${hunk.oldLines.length}`;
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(check) Keep",
          command: "phew.review.keep",
          arguments: [document.uri, hunk.index],
        }),
        new vscode.CodeLens(range, {
          title: "$(discard) Undo",
          tooltip:
            hunk.oldLines.length > 0 ? `Restore:\n${hunk.oldLines.join("\n").slice(0, 800)}` : "Remove the added lines",
          command: "phew.review.undo",
          arguments: [document.uri, hunk.index],
        }),
        new vscode.CodeLens(range, { title: summary, command: "" }),
      );
    }
    return lenses;
  }

  async keep(uri: vscode.Uri, index: number): Promise<void> {
    const review = this.reviews.get(uri.toString());
    if (!review) return;
    const document = await vscode.workspace.openTextDocument(uri);
    review.original = keepHunk({ original: review.original, current: document.getText() }, index).original;
    this.refresh();
  }

  async undo(uri: vscode.Uri, index: number): Promise<void> {
    const review = this.reviews.get(uri.toString());
    if (!review) return;
    const document = await vscode.workspace.openTextDocument(uri);
    const next = undoHunk({ original: review.original, current: document.getText() }, index);
    await this.write(document, next.current);
  }

  async keepFile(uri: vscode.Uri): Promise<void> {
    this.reviews.delete(uri.toString());
    this.refresh();
  }

  async undoFile(uri: vscode.Uri): Promise<void> {
    const review = this.reviews.get(uri.toString());
    if (!review) return;
    const document = await vscode.workspace.openTextDocument(uri);
    this.reviews.delete(uri.toString());
    await this.write(document, review.original);
  }

  async keepAll(): Promise<void> {
    this.reviews.clear();
    this.refresh();
  }

  async undoAll(): Promise<void> {
    for (const uri of this.pendingFiles) await this.undoFile(uri);
  }

  /** Opens the next file with changes to review. */
  async next(): Promise<void> {
    const uri = this.pendingFiles[0];
    if (!uri) {
      void vscode.window.showInformationMessage("Phew: no changes to review.");
      return;
    }
    const editor = await vscode.window.showTextDocument(uri);
    const review = this.reviews.get(uri.toString());
    const first = review
      ? reviewHunks({ original: review.original, current: editor.document.getText() })[0]
      : undefined;
    if (first) {
      const position = new vscode.Position(hunkAnchorLine(first, editor.document.lineCount), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async write(document: vscode.TextDocument, content: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      content,
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
    this.refresh();
  }

  private refresh(): void {
    for (const [key, review] of this.reviews) {
      const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === key);
      if (document && reviewHunks({ original: review.original, current: document.getText() }).length === 0) {
        this.reviews.delete(key);
      }
    }
    this.changed.fire();
    this.decorate();
    void vscode.commands.executeCommand("setContext", "phew.reviewPending", this.reviews.size > 0);
    this.onCountChange(this.reviews.size);
  }

  private decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const review = this.reviews.get(editor.document.uri.toString());
      if (!review) {
        editor.setDecorations(this.added, []);
        continue;
      }
      const ranges: vscode.Range[] = [];
      for (const hunk of reviewHunks({ original: review.original, current: editor.document.getText() })) {
        for (
          let line = hunk.newStart;
          line < hunk.newStart + hunk.newLines.length && line < editor.document.lineCount;
          line++
        ) {
          ranges.push(new vscode.Range(line, 0, line, 0));
        }
      }
      editor.setDecorations(this.added, ranges);
    }
  }
}
