import * as vscode from "vscode";
import {
  afterRating,
  feedbackUrl,
  parseRatingState,
  type RatingState,
  ratingTarget,
  shouldAskForRating,
} from "../core/rating";
import type { StatsStore } from "./statsStore";

const key = "phew.rating";

/** Asks for a rating at a good moment, opens the store or the feedback page, and remembers the answer. */
export class RatingService {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly stats: StatsStore,
  ) {}

  private get state(): RatingState {
    return parseRatingState(this.memento.get(key));
  }

  private async save(state: RatingState): Promise<void> {
    await this.memento.update(key, state);
  }

  /**
   * After a task: the store to name in the card when it is time to ask, or undefined. Showing the card
   * counts as an ask, so it never shows twice in a row.
   */
  async maybeAsk(goodMoment: boolean, enabled: boolean): Promise<string | undefined> {
    const stats = this.stats.get();
    const now = Date.now();
    const ask = shouldAskForRating({
      enabled,
      goodMoment,
      tasksCompleted: stats.tasksCompleted,
      activeDays: this.stats.activity().filter((day) => day.tasks > 0).length,
      firstUse: stats.firstUse,
      state: this.state,
      now,
    });
    if (!ask) return undefined;
    await this.save(afterRating(this.state, "shown", now));
    return ratingTarget(vscode.env.appName).store;
  }

  /** The answer of the card, or the Rate Phew command. */
  async answer(answer: "rate" | "feedback" | "later" | "never"): Promise<void> {
    if (answer === "rate") await vscode.env.openExternal(vscode.Uri.parse(ratingTarget(vscode.env.appName).url));
    if (answer === "feedback") await vscode.env.openExternal(vscode.Uri.parse(feedbackUrl));
    await this.save(afterRating(this.state, answer, Date.now()));
  }
}
