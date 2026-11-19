import type { HostMessage } from "../shared/protocol";
import { toolLabel } from "./toolLabels";

/** The words of a subagent card, without the DOM, so tests can check them. */

export type SubagentMessage = Extract<HostMessage, { type: "subagent" }>;

/** The label of one step: "Read src/app.ts", or the switch to a fallback model. */
export function stepLabel(step: { readonly name: string; readonly summary: string }, running: boolean): string {
  return step.name === "fallback" ? step.summary : toolLabel(step.name, step.summary, running);
}

/** The state at the end of the line: the current step while it runs, and the facts when it is over. */
export function subagentState(message: SubagentMessage): string {
  const steps = `${message.stepCount} step${message.stepCount === 1 ? "" : "s"}`;
  const time = message.seconds !== undefined ? ` · ${Math.max(1, Math.round(message.seconds))} s` : "";
  switch (message.status) {
    case "running": {
      const last = message.steps.at(-1);
      return last ? `${stepLabel(last, true)}…` : "Starting…";
    }
    case "done":
      return `Done · ${steps}${time}`;
    case "failed":
      return `Failed · ${steps}${time}`;
    case "stopped":
      return "Stopped";
  }
}

/** The model line: the model, or the fallback that took over. */
export function subagentModel(message: SubagentMessage): string {
  return message.fallback ? `${message.fallback} (fallback)` : message.model;
}
