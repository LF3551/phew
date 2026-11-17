/** A working mode limits which tools the agent can use. */
export type Mode = "ask" | "plan" | "code";

export const modes: readonly Mode[] = ["ask", "plan", "code"];

export interface ModeInfo {
  readonly label: string;
  readonly description: string;
  /** The agent can change files and run commands only when this is true. */
  readonly canChange: boolean;
}

export const modeInfo: Readonly<Record<Mode, ModeInfo>> = {
  ask: { label: "Ask", description: "Answers questions. Reads files, changes nothing.", canChange: false },
  plan: { label: "Plan", description: "Explores the code and writes a plan. Changes nothing.", canChange: false },
  code: { label: "Code", description: "Edits files and runs commands with your approval.", canChange: true },
};

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (modes as readonly string[]).includes(value);
}
