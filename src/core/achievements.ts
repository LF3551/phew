import type { Stats } from "./stats";

/** Local achievements and the weekly or monthly "Phew Wrapped" summary. Nothing leaves the computer. */

export interface ActivityDay {
  /** Day in the form YYYY-MM-DD, in local time. */
  readonly day: string;
  readonly tasks: number;
  readonly bugs: number;
  readonly tokens: number;
  readonly cost: number;
  readonly verifiedFirstTry: number;
  readonly nightTasks: number;
  readonly models: Readonly<Record<string, number>>;
}

export interface Achievement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** A short glyph for the badge, for example "10" or "✓". */
  readonly icon: string;
}

export const achievementList: readonly Achievement[] = [
  { id: "first-fix", title: "First phew", description: "Fixed the first bug.", icon: "1" },
  { id: "ten-bugs", title: "Bug slayer", description: "Fixed 10 bugs.", icon: "10" },
  { id: "hundred-bugs", title: "Exterminator", description: "Fixed 100 bugs.", icon: "100" },
  {
    id: "green-first-try",
    title: "Green on the first try",
    description: "The checks passed after the first fix.",
    icon: "✓",
  },
  { id: "night-owl", title: "Night debugger", description: "Finished a task between midnight and 5 AM.", icon: "☾" },
  { id: "streak-3", title: "On a roll", description: "Used Phew three days in a row.", icon: "3d" },
  { id: "streak-7", title: "A full week", description: "Used Phew seven days in a row.", icon: "7d" },
  { id: "polyglot", title: "Polyglot", description: "Used three different models.", icon: "3M" },
];

export function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface TaskRecord {
  readonly date: Date;
  readonly success: boolean;
  readonly bugFixed: boolean;
  readonly verifiedFirstTry: boolean;
  readonly tokens: number;
  readonly cost: number;
  readonly model: string;
}

/** Adds a finished task to the daily activity. Keeps at most 400 days. */
export function recordActivity(days: readonly ActivityDay[], task: TaskRecord): ActivityDay[] {
  const key = dayKey(task.date);
  const result = days.filter((day) => day.day !== key);
  const current = days.find((day) => day.day === key) ?? {
    day: key,
    tasks: 0,
    bugs: 0,
    tokens: 0,
    cost: 0,
    verifiedFirstTry: 0,
    nightTasks: 0,
    models: {},
  };
  const hour = task.date.getHours();
  result.push({
    day: key,
    tasks: current.tasks + (task.success ? 1 : 0),
    bugs: current.bugs + (task.success && task.bugFixed ? 1 : 0),
    tokens: current.tokens + task.tokens,
    cost: current.cost + task.cost,
    verifiedFirstTry: current.verifiedFirstTry + (task.verifiedFirstTry ? 1 : 0),
    nightTasks: current.nightTasks + (task.success && hour < 5 ? 1 : 0),
    models: task.model ? { ...current.models, [task.model]: (current.models[task.model] ?? 0) + 1 } : current.models,
  });
  return result.sort((a, b) => a.day.localeCompare(b.day)).slice(-400);
}

/** The longest run of consecutive days that ends today or yesterday. */
export function currentStreak(days: readonly ActivityDay[], today = new Date()): number {
  const active = new Set(days.filter((day) => day.tasks > 0).map((day) => day.day));
  const cursor = new Date(today);
  if (!active.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** The ids of the achievements that the user has earned. */
export function earnedAchievements(stats: Stats, days: readonly ActivityDay[], today = new Date()): string[] {
  const models = new Set(days.flatMap((day) => Object.keys(day.models)));
  const streak = Math.max(currentStreak(days, today), longestStreak(days));
  const earned: string[] = [];
  if (stats.bugsFixed >= 1) earned.push("first-fix");
  if (stats.bugsFixed >= 10) earned.push("ten-bugs");
  if (stats.bugsFixed >= 100) earned.push("hundred-bugs");
  if (days.some((day) => day.verifiedFirstTry > 0)) earned.push("green-first-try");
  if (days.some((day) => day.nightTasks > 0)) earned.push("night-owl");
  if (streak >= 3) earned.push("streak-3");
  if (streak >= 7) earned.push("streak-7");
  if (models.size >= 3) earned.push("polyglot");
  return earned;
}

export function longestStreak(days: readonly ActivityDay[]): number {
  const sorted = [...days]
    .filter((day) => day.tasks > 0)
    .map((day) => day.day)
    .sort();
  let best = 0;
  let run = 0;
  let previous: Date | undefined;
  for (const day of sorted) {
    const date = new Date(`${day}T12:00:00`);
    run = previous && Math.round((date.getTime() - previous.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = date;
  }
  return best;
}

export interface Wrapped {
  readonly period: "week" | "month";
  readonly from: string;
  readonly to: string;
  readonly tasks: number;
  readonly bugs: number;
  readonly minutesSaved: number;
  readonly tokens: number;
  readonly cost: number;
  readonly topModel?: string;
  readonly activeDays: number;
  readonly busiestDay?: string;
  readonly streak: number;
}

/** Summarizes the last 7 or 30 days. */
export function wrapped(
  days: readonly ActivityDay[],
  period: "week" | "month",
  minutesPerBug: number,
  today = new Date(),
): Wrapped {
  const length = period === "week" ? 7 : 30;
  const start = new Date(today);
  start.setDate(start.getDate() - (length - 1));
  const from = dayKey(start);
  const to = dayKey(today);
  const inRange = days.filter((day) => day.day >= from && day.day <= to);
  const models: Record<string, number> = {};
  for (const day of inRange)
    for (const [model, count] of Object.entries(day.models)) models[model] = (models[model] ?? 0) + count;
  const topModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0];
  const busiest = [...inRange].sort((a, b) => b.tasks - a.tasks)[0];
  const bugs = inRange.reduce((sum, day) => sum + day.bugs, 0);
  return {
    period,
    from,
    to,
    tasks: inRange.reduce((sum, day) => sum + day.tasks, 0),
    bugs,
    minutesSaved: Math.round(bugs * minutesPerBug),
    tokens: inRange.reduce((sum, day) => sum + day.tokens, 0),
    cost: inRange.reduce((sum, day) => sum + day.cost, 0),
    topModel,
    activeDays: inRange.filter((day) => day.tasks > 0).length,
    busiestDay: busiest && busiest.tasks > 0 ? busiest.day : undefined,
    streak: currentStreak(days, today),
  };
}
