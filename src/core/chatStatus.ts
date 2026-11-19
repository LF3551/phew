/**
 * The state of a chat in the list of chats, so that with several agents at work you see at a glance which one
 * needs you, which one has a problem, and which one is done.
 */

export type ChatStatusKind = "waiting" | "stalled" | "fallback" | "running" | "failed" | "done" | "idle";

export interface ChatStatusInput {
  readonly busy: boolean;
  /** A question or an approval waits for the user. */
  readonly needsApproval: boolean;
  /** A model request runs, and the model has sent nothing for a while. */
  readonly stalled: boolean;
  /** The fallback model that answers in the running task, when the model of the chat ran out of quota. */
  readonly fallback?: string;
  /** How the last task ended, until the user opens the chat. */
  readonly outcome?: "done" | "failed";
}

export interface ChatStatus {
  readonly kind: ChatStatusKind;
  /** A short label for the right side of the row; empty for an idle chat, which shows its time instead. */
  readonly label: string;
  /** For screen readers and the tooltip. */
  readonly description: string;
}

/** How long a model may stay quiet in a request before the chat counts as stalled. */
export const stalledAfterMs = 60_000;

/** The most important state wins: the user first, then a problem, then work, then the result. */
export function chatStatus(input: ChatStatusInput): ChatStatus {
  if (input.needsApproval)
    return { kind: "waiting", label: "Needs input", description: "Waits for your answer or approval" };
  if (input.busy && input.stalled)
    return {
      kind: "stalled",
      label: "Model quiet",
      description: "The model has sent nothing for a minute. Open the chat to retry the request.",
    };
  if (input.busy && input.fallback)
    return {
      kind: "fallback",
      label: `On ${input.fallback}`,
      description: `Runs on the fallback model ${input.fallback}, because the model of the chat ran out of quota`,
    };
  if (input.busy) return { kind: "running", label: "Running", description: "Running" };
  if (input.outcome === "failed")
    return {
      kind: "failed",
      label: "Failed",
      description: "The last task could not finish. Open the chat to see why.",
    };
  if (input.outcome === "done") return { kind: "done", label: "Done", description: "The last task finished" };
  return { kind: "idle", label: "", description: "" };
}

/** True when a running request counts as stalled: the model is asked and has been quiet long enough. */
export function isStalled(input: {
  readonly busy: boolean;
  readonly modelRequest: boolean;
  readonly needsApproval: boolean;
  readonly lastEventAt: number;
  readonly now: number;
}): boolean {
  return input.busy && input.modelRequest && !input.needsApproval && input.now - input.lastEventAt >= stalledAfterMs;
}

/** The first line of a failure, short enough for a notification. */
export function failureLine(message: string | undefined): string {
  const line =
    (message ?? "")
      .split("\n")
      .find((item) => item.trim())
      ?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
