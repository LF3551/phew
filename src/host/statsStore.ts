import type * as vscode from "vscode";
import { formatCost, formatTokens } from "../core/cost";
import { estimatedMinutesSaved, normalizeStats, recordOutcome, type Stats, type TaskOutcome } from "../core/stats";

const key = "phew.stats";

/** Stores the local statistics in the global state of the extension. */
export class StatsStore {
  constructor(private readonly memento: vscode.Memento) {}

  get(): Stats {
    return normalizeStats(this.memento.get(key));
  }

  async record(outcome: TaskOutcome): Promise<Stats> {
    const next = recordOutcome(this.get(), outcome);
    await this.memento.update(key, next);
    return next;
  }

  async reset(): Promise<void> {
    await this.memento.update(key, undefined);
  }

  summary(minutesPerBug: number): string {
    const stats = this.get();
    const minutes = estimatedMinutesSaved(stats, minutesPerBug);
    const time = minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
    return `${stats.bugsFixed} bugs fixed · ~${time} saved`;
  }

  details(minutesPerBug: number): string {
    const stats = this.get();
    const minutes = estimatedMinutesSaved(stats, minutesPerBug);
    return [
      `Bugs fixed: ${stats.bugsFixed}`,
      `Tasks completed: ${stats.tasksCompleted}`,
      `Files changed: ${stats.filesChanged}`,
      `Estimated time saved: ${minutes} minutes (${minutesPerBug} minutes per bug)`,
      `Tokens: ${formatTokens(stats.tokens)}`,
      `Known cost: ${formatCost(stats.cost)}`,
      `Since: ${new Date(stats.firstUse).toLocaleDateString()}`,
    ].join("\n");
  }
}
