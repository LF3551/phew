import type { ChatMessage } from "./chat";

const maxInput = 1500;

/** A short request that asks the model to name a chat, in the language of the user. */
export function buildTitleMessages(request: string, answer: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Name this chat for a list of chats. Reply with the name only: 2 to 6 words, in the language of the user, " +
        "sentence case, no quotes, no period, no emoji. Name the topic or the task, for example " +
        '"Fix login redirect loop" or "Миграция базы без простоя".',
    },
    {
      role: "user",
      content: `Request:\n${request.slice(0, maxInput)}\n\nAnswer:\n${answer.slice(0, maxInput)}`,
    },
  ];
}

/** Cleans the reply of the model. Returns undefined when it is not a usable name. */
export function cleanTitle(raw: string): string | undefined {
  const line =
    raw
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  const title = line
    .replace(/^(title|name|название)\s*:\s*/i, "")
    .replace(/^[\s"'`«»“”„*#_-]+|[\s"'`«»“”„*#_.。!-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length < 2 || title.length > 80) return undefined;
  if (title.split(" ").length > 10) return undefined;
  return title;
}

/** The first request of the user and the first answer, which name the chat best. */
export function firstExchange(history: readonly ChatMessage[]): { request: string; answer: string } | undefined {
  const request = history.find((message) => message.role === "user")?.content.trim();
  const answer = history.find((message) => message.role === "assistant" && message.content.trim())?.content.trim();
  return request && answer ? { request, answer } : undefined;
}
