import type { ChatMessage, ModelClient, RetryInfo, ToolCall, ToolDefinition } from "./chat";
import { truncateMiddle } from "./chat";
import type { CostMeter } from "./cost";

export interface ToolResult {
  readonly content: string;
  /** True when the tool changed a file in the workspace. */
  readonly changed?: boolean;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly output: string;
}

export interface AgentEvents {
  onText?(delta: string): void;
  onReasoning?(delta: string): void;
  onRetry?(info: RetryInfo): void;
  onAssistant?(content: string, toolCalls: readonly ToolCall[]): void;
  onToolStart?(call: ToolCall): void;
  onToolEnd?(call: ToolCall, result: ToolResult): void;
  onUsage?(meter: CostMeter): void;
  onVerify?(attempt: number, result: VerificationResult): void;
}

export interface AgentOptions {
  readonly client: ModelClient;
  readonly systemPrompt: string;
  /** Conversation without the system prompt. The agent appends new messages to it. */
  readonly history: ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly executeTool: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
  /** Runs the check command, for example the tests, after the agent says that it is done. */
  readonly verify?: () => Promise<VerificationResult>;
  readonly maxVerifyAttempts?: number;
  /**
   * The task must change files, for example a fix. When the model stops without a change,
   * the agent reminds it to use the edit tools, at most `maxNudges` times.
   */
  readonly requireChanges?: boolean;
  readonly maxNudges?: number;
  readonly maxSteps: number;
  /**
   * Runs before each model call, for example to compact the history or to add messages
   * that the user queued while the agent was working.
   */
  readonly beforeStep?: () => Promise<void>;
  readonly meter: CostMeter;
  readonly signal: AbortSignal;
  readonly events?: AgentEvents;
}

export type AgentStatus = "done" | "aborted" | "max-steps" | "budget" | "verify-failed";

export interface AgentResult {
  readonly status: AgentStatus;
  readonly message?: string;
  /** True when the check command passed at the end of the task. */
  readonly verified: boolean;
  readonly filesChanged: boolean;
  readonly steps: number;
}

const maximumVerifyOutput = 12_000;

/** Runs `beforeStep` and reports whether it added a user message. */
async function hasQueuedInput(options: AgentOptions): Promise<boolean> {
  const length = options.history.length;
  await options.beforeStep?.();
  return options.history.length > length && options.history.at(-1)?.role === "user";
}

/** Runs the model and its tool calls until the task is complete or a limit is reached. */
export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { client, history, events, meter, signal } = options;
  const maxVerifyAttempts = options.maxVerifyAttempts ?? 3;
  const maxNudges = options.maxNudges ?? 2;
  let verifyAttempts = 0;
  let nudges = 0;
  let filesChanged = false;
  let steps = 0;

  const finish = (status: AgentStatus, message?: string, verified = false): AgentResult => ({
    status,
    message,
    verified,
    filesChanged,
    steps,
  });

  while (steps < options.maxSteps) {
    if (signal.aborted) return finish("aborted");
    const overBudget = meter.exceeded();
    if (overBudget) return finish("budget", overBudget);
    steps++;
    if (options.beforeStep) await options.beforeStep();
    if (signal.aborted) return finish("aborted");

    const result = await client.complete(
      {
        messages: [{ role: "system", content: options.systemPrompt }, ...history],
        tools: options.tools,
        signal,
        onReasoning: (delta) => events?.onReasoning?.(delta),
        onRetry: (info) => events?.onRetry?.(info),
      },
      (delta) => events?.onText?.(delta),
    );
    if (result.usage) meter.add(result.usage);
    events?.onUsage?.(meter);
    history.push({
      role: "assistant",
      content: result.content,
      ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    });
    events?.onAssistant?.(result.content, result.toolCalls);

    if (result.toolCalls.length === 0) {
      // Messages that the user queued during this step continue the task.
      if (options.beforeStep && history.at(-1)?.role === "assistant" && (await hasQueuedInput(options))) continue;
      if (options.requireChanges && !filesChanged && nudges < maxNudges) {
        nudges++;
        history.push({
          role: "user",
          content: [
            "You did not change any file yet.",
            "Do not only show code in the answer.",
            "Read the file with read_file, apply the fix with edit_file or write_file, and then stop.",
            "If no change is needed, explain why in one sentence.",
          ].join(" "),
        });
        continue;
      }
      if (!options.verify || !filesChanged) return finish("done");
      if (signal.aborted) return finish("aborted");
      const verification = await options.verify();
      verifyAttempts++;
      events?.onVerify?.(verifyAttempts, verification);
      if (verification.passed) return finish("done", undefined, true);
      if (verifyAttempts >= maxVerifyAttempts) {
        return finish("verify-failed", `The check still fails after ${verifyAttempts} attempts.`);
      }
      history.push({
        role: "user",
        content: [
          `The check failed (attempt ${verifyAttempts} of ${maxVerifyAttempts}).`,
          "Find the cause, fix it, and stop when you expect the check to pass.",
          "Output:",
          "```",
          truncateMiddle(verification.output, maximumVerifyOutput),
          "```",
        ].join("\n"),
      });
      continue;
    }

    for (const call of result.toolCalls) {
      if (signal.aborted) {
        history.push({ role: "tool", toolCallId: call.id, content: "Cancelled by the user." });
        continue;
      }
      events?.onToolStart?.(call);
      let toolResult: ToolResult;
      try {
        toolResult = await options.executeTool(call, signal);
      } catch (error) {
        toolResult = { content: `Error: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (toolResult.changed) filesChanged = true;
      history.push({ role: "tool", toolCallId: call.id, content: toolResult.content });
      events?.onToolEnd?.(call, toolResult);
    }
  }
  return finish("max-steps", `The task stopped after ${options.maxSteps} steps.`);
}
