import type * as vscode from "vscode";
import { type ActivityDay, earnedAchievements, recordActivity, type TaskRecord } from "../core/achievements";
import { formatCost, formatTokens } from "../core/cost";
import { estimatedMinutesSaved, normalizeStats, recordOutcome, type Stats, type TaskOutcome } from "../core/stats";

const key = "phew.stats";
const activityKey = "phew.activity";
const seenKey = "phew.achievementsSeen";

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
    await this.memento.update(activityKey, undefined);
    await this.memento.update(seenKey, undefined);
  }

  activity(): ActivityDay[] {
    const value = this.memento.get<unknown>(activityKey);
    return Array.isArray(value) ? (value as ActivityDay[]).filter((day) => typeof day?.day === "string") : [];
  }

  /** Records a finished task and returns the achievements that the user earned now. */
  async recordTask(task: TaskRecord): Promise<string[]> {
    await this.memento.update(activityKey, recordActivity(this.activity(), task));
    const earned = earnedAchievements(this.get(), this.activity(), task.date);
    const seen = new Set(this.memento.get<string[]>(seenKey) ?? []);
    const fresh = earned.filter((id) => !seen.has(id));
    if (fresh.length > 0) await this.memento.update(seenKey, [...seen, ...fresh]);
    return fresh;
  }

  earned(): string[] {
    return earnedAchievements(this.get(), this.activity());
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
