/** The goal and the checklist of a chat. The agent updates the checklist with the update_plan tool. */

export type PlanStatus = "pending" | "in_progress" | "done";

export interface PlanItem {
  readonly text: string;
  readonly status: PlanStatus;
}

export interface Plan {
  readonly goal?: string;
  readonly items: readonly PlanItem[];
}

export const emptyPlan: Plan = { items: [] };

/** Validates the arguments of update_plan. */
export function parsePlanUpdate(args: Record<string, unknown>, current: Plan): Plan {
  const items: PlanItem[] = [];
  if (!Array.isArray(args.items)) throw new Error('update_plan needs "items": a list of { text, status }.');
  for (const raw of args.items.slice(0, 50)) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim().slice(0, 300) : "";
    if (!text) continue;
    const status: PlanStatus = item.status === "done" || item.status === "in_progress" ? item.status : "pending";
    items.push({ text, status });
  }
  const goal = typeof args.goal === "string" && args.goal.trim() ? args.goal.trim().slice(0, 500) : current.goal;
  return { goal, items };
}

export function planProgress(plan: Plan): { done: number; total: number } {
  return { done: plan.items.filter((item) => item.status === "done").length, total: plan.items.length };
}

/** The plan section of the system prompt. */
export function planPrompt(plan: Plan): string {
  if (!plan.goal && plan.items.length === 0) return "";
  const marks: Record<PlanStatus, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" };
  return [
    plan.goal ? `Goal of this chat: ${plan.goal}` : "",
    plan.items.length > 0
      ? `Current checklist:\n${plan.items.map((item) => `${marks[item.status]} ${item.text}`).join("\n")}`
      : "",
    "Keep the checklist up to date with update_plan when you finish or start a step.",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface Question {
  readonly question: string;
  readonly options: readonly string[];
  readonly allowText: boolean;
}

/** Validates the arguments of ask_user. */
export function parseQuestion(args: Record<string, unknown>): Question {
  const question = typeof args.question === "string" ? args.question.trim().slice(0, 2000) : "";
  if (!question) throw new Error('ask_user needs a "question".');
  const options = Array.isArray(args.options)
    ? [
        ...new Set(
          args.options
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim().slice(0, 200)),
        ),
      ]
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return { question, options, allowText: args.allow_text !== false || options.length === 0 };
}
