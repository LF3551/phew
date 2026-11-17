import * as vscode from "vscode";
import type { ChatMessage, CompletionRequest, CompletionResult, ModelClient, ToolCall } from "../core/chat";
import type { ModelInfo } from "../providers/factory";
import { argumentsObject } from "../providers/http";

type UserPart = vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart;
type AssistantPart = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;

/** Converts the conversation to VS Code language model messages. The API has no system role. */
export function toVsCodeMessages(messages: readonly ChatMessage[]): vscode.LanguageModelChatMessage[] {
  const result: { role: "user" | "assistant"; parts: (UserPart | AssistantPart)[] }[] = [];
  const push = (role: "user" | "assistant", parts: (UserPart | AssistantPart)[]) => {
    if (parts.length === 0) return;
    const last = result.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else result.push({ role, parts });
  };
  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "user":
        push("user", [new vscode.LanguageModelTextPart(message.content || " ")]);
        break;
      case "tool":
        push("user", [
          new vscode.LanguageModelToolResultPart(message.toolCallId, [
            new vscode.LanguageModelTextPart(message.content || "(empty)"),
          ]),
        ]);
        break;
      case "assistant": {
        const parts: AssistantPart[] = [];
        if (message.content.trim()) parts.push(new vscode.LanguageModelTextPart(message.content));
        for (const call of message.toolCalls ?? []) {
          parts.push(new vscode.LanguageModelToolCallPart(call.id, call.name, argumentsObject(call.arguments)));
        }
        push("assistant", parts.length > 0 ? parts : [new vscode.LanguageModelTextPart("(no answer)")]);
        break;
      }
    }
  }
  return result.map((item) =>
    item.role === "user"
      ? vscode.LanguageModelChatMessage.User(item.parts as UserPart[])
      : vscode.LanguageModelChatMessage.Assistant(item.parts as AssistantPart[]),
  );
}

/** A client for the language models that VS Code provides, for example GitHub Copilot. */
export class VsCodeLanguageModelClient implements ModelClient {
  constructor(private readonly modelId: string) {}

  async complete(request: CompletionRequest, onText: (delta: string) => void): Promise<CompletionResult> {
    const [model] = await vscode.lm.selectChatModels({ id: this.modelId });
    if (!model) {
      throw new Error(
        `VS Code has no language model "${this.modelId}". Sign in to GitHub Copilot or choose another model with Phew: Manage Models.`,
      );
    }
    const source = new vscode.CancellationTokenSource();
    const onAbort = () => source.cancel();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await model.sendRequest(
        toVsCodeMessages(request.messages),
        {
          justification: "Phew uses this model to answer your request and to change code with your approval.",
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        },
        source.token,
      );
      let content = "";
      const toolCalls: ToolCall[] = [];
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          content += part.value;
          onText(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({ id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
        }
      }
      return { content, toolCalls };
    } catch (error) {
      if (error instanceof vscode.LanguageModelError) {
        throw new Error(`The VS Code language model failed (${error.code}): ${error.message}`);
      }
      throw error;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      source.dispose();
    }
  }
}

/** Lists the chat models that VS Code provides. */
export async function listVsCodeModels(): Promise<ModelInfo[]> {
  const models = await vscode.lm.selectChatModels();
  return models.map((model) => ({ id: model.id, label: `${model.name} (${model.vendor})` }));
}
