/**
 * Asking for a rating, the polite way: only after a task went well, only for people who use Phew for a while,
 * rarely, and never again once they rated it or said no. Rating and feedback are offered side by side, so
 * nobody is steered to the store only when happy. Everything stays on the computer.
 */

export interface RatingState {
  /** How many times the card was shown. */
  readonly asked: number;
  readonly lastAsked?: number;
  /** "rated" after a click on Rate, "never" after Don't ask again. */
  readonly done?: "rated" | "never";
}

export const ratingRules = {
  /** Successful tasks before the first ask. */
  minTasks: 5,
  /** Different days with tasks. */
  minActiveDays: 3,
  /** Days since the first use. */
  minAgeDays: 3,
  /** Days between two asks. */
  pauseDays: 30,
  /** Asks in total. */
  maxAsks: 3,
} as const;

const day = 86_400_000;

export function parseRatingState(value: unknown): RatingState {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    asked: typeof raw.asked === "number" && raw.asked >= 0 ? Math.floor(raw.asked) : 0,
    ...(typeof raw.lastAsked === "number" ? { lastAsked: raw.lastAsked } : {}),
    ...(raw.done === "rated" || raw.done === "never" ? { done: raw.done } : {}),
  };
}

/** True when the card may show now: a good moment, a regular user, and not too often. */
export function shouldAskForRating(input: {
  readonly enabled: boolean;
  /** This task finished well: it changed files, or the check passed. */
  readonly goodMoment: boolean;
  readonly tasksCompleted: number;
  readonly activeDays: number;
  readonly firstUse: number;
  readonly state: RatingState;
  readonly now: number;
}): boolean {
  const { state, now } = input;
  if (!input.enabled || !input.goodMoment || state.done) return false;
  if (state.asked >= ratingRules.maxAsks) return false;
  if (input.tasksCompleted < ratingRules.minTasks || input.activeDays < ratingRules.minActiveDays) return false;
  if (now - input.firstUse < ratingRules.minAgeDays * day) return false;
  if (state.lastAsked !== undefined && now - state.lastAsked < ratingRules.pauseDays * day) return false;
  return true;
}

/** Where to rate: the Visual Studio Marketplace in VS Code, Open VSX in VSCodium and other editors. */
export function ratingTarget(appName: string): { readonly store: string; readonly url: string } {
  return /visual studio code/i.test(appName)
    ? {
        store: "the Visual Studio Marketplace",
        url: "https://marketplace.visualstudio.com/items?itemName=alekseialeinikov.phew&ssr=false#review-details",
      }
    : { store: "Open VSX", url: "https://open-vsx.org/extension/alekseialeinikov/phew/reviews" };
}

/** Feedback goes to the issues of the repository, with a label. */
export const feedbackUrl = "https://github.com/LF3551/phew/issues/new?labels=feedback&title=Feedback%3A%20";

/** The state after the card was shown, and after each answer. */
export function afterRating(
  state: RatingState,
  event: "shown" | "rate" | "feedback" | "later" | "never",
  now: number,
): RatingState {
  switch (event) {
    case "shown":
      return { ...state, asked: state.asked + 1, lastAsked: now };
    case "rate":
      return { ...state, done: "rated" };
    case "never":
      return { ...state, done: "never" };
    default:
      // Feedback and Not now: ask again only after the pause.
      return { ...state, lastAsked: now };
  }
}
