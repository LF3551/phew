import type { ToolDefinition } from "./chat";
import { readTools, skillTools } from "./tools";

/**
 * Subagents: the agent of a chat gives a self-contained task to a helper that works with read-only tools,
 * possibly with another model, and returns what it found. Several subagents run in parallel. They cannot change
 * files, run commands, use MCP tools, ask the user, or start subagents of their own.
 */

export const delegateToolName = "delegate";

/** The tools of a subagent: reading and searching only, and the skills of the project. */
export const subagentToolNames: ReadonlySet<string> = new Set([
  ...readTools.map((tool) => tool.name),
  ...skillTools.map((tool) => tool.name),
]);

export interface SubagentModel {
  readonly id: string;
  readonly name: string;
}

export interface SubagentLimits {
  /** Subagents that run at the same time; more wait for a free place. */
  readonly maxParallel: number;
  /** Model requests of one subagent. */
  readonly maxSteps: number;
}

/** The delegate tool for the agent of a chat, with the models it may choose from. */
export function delegateTool(models: readonly SubagentModel[], limits: SubagentLimits): ToolDefinition {
  const properties: Record<string, unknown> = {
    title: {
      type: "string",
      description: "A short label for the user, 2 to 6 words, for example 'Find the callers of parse'.",
    },
    task: {
      type: "string",
      description:
        "The complete task. The subagent does not see this chat: name the files, symbols, and questions, and say what to report.",
    },
  };
  if (models.length > 1)
    properties.model = {
      type: "string",
      enum: models.map((model) => model.id),
      description: `Optional. The model of the subagent; leave it out for the default. ${models
        .map((model) => `${model.id}: ${model.name}`)
        .join("; ")}.`,
    };
  return {
    name: delegateToolName,
    description: [
      "Gives a self-contained research task to a subagent that reads and searches the workspace and reports what it found.",
      "Use it for independent questions that need many reads, for example to find every caller of a function, to map how a feature works, or to collect the facts for a plan.",
      `Call it several times in one step to run subagents in parallel (up to ${limits.maxParallel} at once).`,
      `A subagent has read-only tools and up to ${limits.maxSteps} steps; it cannot change files, run commands, or ask the user. Check what matters before you rely on it.`,
    ].join(" "),
    parameters: { type: "object", properties, required: ["title", "task"], additionalProperties: false },
  };
}

export interface DelegateRequest {
  readonly title: string;
  readonly task: string;
  /** The model id, or undefined for the default model of subagents. */
  readonly model?: string;
}

const maximumTask = 20_000;

/** Reads the arguments of a delegate call, or says what is wrong in words the model can fix. */
export function parseDelegate(
  args: Record<string, unknown>,
  models: readonly SubagentModel[],
): DelegateRequest | string {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return "Give the subagent a task.";
  if (task.length > maximumTask) return `The task is too long. Keep it under ${maximumTask} characters.`;
  const rawTitle = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim() : "";
  const title = (rawTitle || task.split("\n")[0] || "Subagent").slice(0, 80);
  if (args.model === undefined || args.model === null || args.model === "") return { title, task };
  if (typeof args.model !== "string") return "The model must be one of the listed ids.";
  const wanted = args.model.trim();
  const model =
    models.find((item) => item.id === wanted) ??
    models.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
  if (!model) return `There is no model "${wanted}". Use one of: ${models.map((item) => item.id).join(", ")}.`;
  return { title, task, model: model.id };
}

/** The system prompt of a subagent. */
export function subagentPrompt(context: {
  readonly workspace: string;
  readonly platform: string;
  readonly date: string;
  readonly rules?: string;
}): string {
  return [
    "You are a subagent of Phew, a coding agent in VS Code. Another agent gave you one task.",
    "Work only with the read-only tools: list, read, and search files, look at the Git diff and the problems.",
    "You cannot change files, run commands, or ask anyone; nobody answers questions. If something is unclear, say what you assumed.",
    "Be efficient: search first, then read the parts that matter. Stop as soon as you can answer.",
    "Your final answer goes back to the other agent, not to a person. Report the facts it needs: file paths with line numbers, names, and short quotes of code. Say what you did not find or could not check. No greetings, no filler.",
    `Workspace: ${context.workspace}. Platform: ${context.platform}. Date: ${context.date}.`,
    context.rules ? `Rules of the project:\n${context.rules}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface SubagentOutcome {
  readonly model: string;
  readonly status: "done" | "failed" | "stopped";
  readonly answer?: string;
  readonly error?: string;
  readonly steps: number;
  readonly seconds: number;
  /** The fallback model that finished the work, if the model of the subagent ran out of quota. */
  readonly fallback?: string;
}

const maximumAnswer = 16_000;

/** The tool result that the agent of the chat gets back. */
export function subagentResult(outcome: SubagentOutcome): string {
  const who = outcome.fallback ? `${outcome.fallback} (fallback for ${outcome.model})` : outcome.model;
  const facts = `${outcome.steps} step${outcome.steps === 1 ? "" : "s"}, ${Math.round(outcome.seconds)} s`;
  if (outcome.status === "stopped") return `The user stopped the subagent (${who}) before it finished.`;
  if (outcome.status === "failed")
    return [
      `The subagent (${who}) failed after ${facts}: ${outcome.error ?? "no reason given"}.`,
      outcome.answer ? `What it had so far:\n${clip(outcome.answer)}` : "",
      "Do the work yourself, or delegate it again with another model.",
    ]
      .filter(Boolean)
      .join("\n\n");
  const answer = outcome.answer?.trim();
  return answer
    ? `The subagent (${who}) finished in ${facts}. Its report:\n\n${clip(answer)}`
    : `The subagent (${who}) finished in ${facts} without a report.`;
}

function clip(text: string): string {
  if (text.length <= maximumAnswer) return text;
  return `${text.slice(0, maximumAnswer)}\n\n[The report was cut at ${maximumAnswer} characters.]`;
}

/** Runs tasks with at most `size` at the same time, in the order they came. */
export class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly size: number) {}

  get active(): number {
    return this.running;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= Math.max(1, this.size)) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
