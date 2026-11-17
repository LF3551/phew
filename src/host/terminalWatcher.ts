import * as vscode from "vscode";
import { AgentTerminal } from "./agentTerminal";
import { stripAnsi } from "./commandRunner";

export interface FailedCommand {
  readonly command: string;
  readonly exitCode: number | undefined;
  readonly output: string;
  readonly cwd?: string;
}

const maximumOutput = 60_000;

/** Remembers the last failed command in the integrated terminal. It needs VS Code shell integration. */
export class TerminalWatcher implements vscode.Disposable {
  private last: FailedCommand | undefined;
  private lastAny: FailedCommand | undefined;
  private readonly outputs = new WeakMap<vscode.TerminalShellExecution, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastOffer = 0;

  constructor(private readonly onFailure: (failure: FailedCommand) => void) {
    this.disposables.push(
      // The agent's own terminal is not watched: its commands are in the chat already.
      vscode.window.onDidStartTerminalShellExecution((event) => {
        if (!AgentTerminal.isAgentTerminal(event.terminal)) void this.capture(event.execution);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        if (!AgentTerminal.isAgentTerminal(event.terminal)) this.end(event);
      }),
    );
  }

  get lastFailure(): FailedCommand | undefined {
    return this.last;
  }

  /** The last finished command, successful or not. */
  get lastExecution(): FailedCommand | undefined {
    return this.lastAny;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async capture(execution: vscode.TerminalShellExecution): Promise<void> {
    let output = "";
    this.outputs.set(execution, output);
    try {
      for await (const data of execution.read()) {
        output += data;
        if (output.length > maximumOutput) output = output.slice(-maximumOutput);
        this.outputs.set(execution, output);
      }
    } catch {
      // The terminal closed. Keep the output that was read.
    }
  }

  private end(event: vscode.TerminalShellExecutionEndEvent): void {
    const exitCode = event.exitCode;
    const command = event.execution.commandLine.value.trim();
    if (command.length === 0) return;
    setTimeout(() => {
      this.lastAny = {
        command,
        exitCode,
        output: stripAnsi(this.outputs.get(event.execution) ?? ""),
        cwd: event.execution.cwd?.fsPath,
      };
    }, 300);
    if (exitCode === undefined || exitCode === 0 || exitCode === 130) return;
    // Output streaming can end slightly after the end event.
    setTimeout(() => {
      this.last = {
        command,
        exitCode,
        output: stripAnsi(this.outputs.get(event.execution) ?? ""),
        cwd: event.execution.cwd?.fsPath,
      };
      const now = Date.now();
      if (now - this.lastOffer > 15_000) {
        this.lastOffer = now;
        this.onFailure(this.last);
      }
    }, 300);
  }
}
