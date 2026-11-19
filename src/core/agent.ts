import type { ChatMessage, CompletionResult, ModelClient, RetryInfo, ToolCall, ToolDefinition } from "./chat";
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
  /** The current model request starts again (Retry): the text of the stopped attempt is void. */
  onRequestRestart?(): void;
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
  /**
   * Tool calls that may run at the same time, such as subagents. Calls next to each other that all may run
   * together start at once; their results go to the history in the order of the calls.
   */
  readonly concurrent?: (call: ToolCall) => boolean;
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
  /**
   * Lets the host send the current model request again, for example when the model stopped answering.
   * The agent puts a function here while a request runs; calling it stops only that request.
   */
  readonly requestControl?: { retry?: () => void };
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
  const { history, events, meter, signal } = options;
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

    const result = await completeStep(options, history);
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

    const runTool = async (call: ToolCall): Promise<ToolResult> => {
      events?.onToolStart?.(call);
      let toolResult: ToolResult;
      try {
        toolResult = await options.executeTool(call, signal);
      } catch (error) {
        toolResult = { content: `Error: ${error instanceof Error ? error.message : String(error)}` };
      }
      events?.onToolEnd?.(call, toolResult);
      return toolResult;
    };
    const calls = result.toolCalls;
    for (let index = 0; index < calls.length; ) {
      const call = calls[index] as ToolCall;
      if (signal.aborted) {
        history.push({ role: "tool", toolCallId: call.id, content: "Cancelled by the user." });
        index++;
        continue;
      }
      // A run of calls that may work at the same time starts together.
      let end = index + 1;
      if (options.concurrent?.(call)) while (end < calls.length && options.concurrent(calls[end] as ToolCall)) end++;
      const batch = calls.slice(index, end);
      const results = await Promise.all(batch.map(runTool));
      batch.forEach((item, position) => {
        const toolResult = results[position] as ToolResult;
        if (toolResult.changed) filesChanged = true;
        history.push({ role: "tool", toolCallId: item.id, content: toolResult.content });
      });
      index = end;
    }
  }
  return finish("max-steps", `The task stopped after ${options.maxSteps} steps.`);
}

/**
 * One model request of a step. Retry from the host stops only this request and sends it again with the same
 * messages; Stop (the task signal) still ends the task.
 */
async function completeStep(options: AgentOptions, history: readonly ChatMessage[]): Promise<CompletionResult> {
  const { client, signal, events } = options;
  for (;;) {
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    signal.addEventListener("abort", stop, { once: true });
    let restarted = false;
    if (options.requestControl)
      options.requestControl.retry = () => {
        restarted = true;
        attempt.abort();
      };
    try {
      return await client.complete(
        {
          messages: [{ role: "system", content: options.systemPrompt }, ...history],
          tools: options.tools,
          signal: attempt.signal,
          onReasoning: (delta) => events?.onReasoning?.(delta),
          onRetry: (info) => events?.onRetry?.(info),
        },
        (delta) => events?.onText?.(delta),
      );
    } catch (error) {
      if (!restarted || signal.aborted) throw error;
      events?.onRequestRestart?.();
    } finally {
      signal.removeEventListener("abort", stop);
      if (options.requestControl) options.requestControl.retry = undefined;
    }
  }
}
