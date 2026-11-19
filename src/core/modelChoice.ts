/**
 * Which model answers in a chat. Each chat keeps its own model, so chats in different windows can work with
 * different models and keys at the same time, and a choice in one chat never changes another.
 *
 * The order: the model that the mode always uses, then the model of the chat, then the default model (the
 * last one chosen), then the first model. A model that no longer exists is skipped.
 */
export function chooseModelId(input: {
  readonly available: readonly string[];
  readonly modeModel?: string;
  readonly chatModel?: string;
  readonly defaultModel?: string;
}): string | undefined {
  const { available } = input;
  for (const id of [input.modeModel, input.chatModel, input.defaultModel]) if (id && available.includes(id)) return id;
  return available[0];
}

/** The model that a chat pins at its first task: its own, or the default at that moment. */
export function pinnedModelId(input: {
  readonly available: readonly string[];
  readonly chatModel?: string;
  readonly defaultModel?: string;
}): string | undefined {
  if (input.chatModel && input.available.includes(input.chatModel)) return input.chatModel;
  return chooseModelId({ available: input.available, defaultModel: input.defaultModel });
}
