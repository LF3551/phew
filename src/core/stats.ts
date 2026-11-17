/** Local usage statistics. Phew keeps them on this computer and sends them nowhere. */
export interface Stats {
  readonly tasksCompleted: number;
  readonly bugsFixed: number;
  readonly filesChanged: number;
  readonly tokens: number;
  readonly cost: number;
  readonly firstUse: number;
}

export const emptyStats = (now = Date.now()): Stats => ({
  tasksCompleted: 0,
  bugsFixed: 0,
  filesChanged: 0,
  tokens: 0,
  cost: 0,
  firstUse: now,
});

export interface TaskOutcome {
  readonly success: boolean;
  readonly bugFixed: boolean;
  readonly filesChanged: number;
  readonly tokens: number;
  readonly cost: number;
}

/** Reads stored statistics and replaces invalid values with defaults. */
export function normalizeStats(value: unknown, now = Date.now()): Stats {
  const defaults = emptyStats(now);
  if (typeof value !== "object" || value === null) return defaults;
  const record = value as Record<string, unknown>;
  const number = (key: keyof Stats): number => {
    const item = record[key];
    return typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : defaults[key];
  };
  return {
    tasksCompleted: number("tasksCompleted"),
    bugsFixed: number("bugsFixed"),
    filesChanged: number("filesChanged"),
    tokens: number("tokens"),
    cost: number("cost"),
    firstUse: number("firstUse"),
  };
}

export function recordOutcome(stats: Stats, outcome: TaskOutcome): Stats {
  return {
    ...stats,
    tasksCompleted: stats.tasksCompleted + (outcome.success ? 1 : 0),
    bugsFixed: stats.bugsFixed + (outcome.success && outcome.bugFixed ? 1 : 0),
    filesChanged: stats.filesChanged + outcome.filesChanged,
    tokens: stats.tokens + outcome.tokens,
    cost: stats.cost + outcome.cost,
  };
}

/** Estimated time saved. The estimate uses a configurable number of minutes per fixed bug. */
export function estimatedMinutesSaved(stats: Stats, minutesPerBug: number): number {
  return Math.round(stats.bugsFixed * Math.max(0, minutesPerBug));
}
