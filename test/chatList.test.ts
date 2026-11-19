import { expect, test } from "vitest";
import type { ChatMessage } from "../src/core/chat";
import { chatGroup, chatPreview, chatTime, highlightParts, matchesChat } from "../src/core/chatList";

const at = (text: string) => new Date(text).getTime();

test("previews the last request of the user", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "fix the build" },
    { role: "assistant", content: "Done." },
    { role: "user", content: "now  add\n a **test**" },
  ];
  expect(chatPreview(history, "fix the build")).toBe("now add a test");
});

test("previews the answer when the request repeats the title", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "тест" },
    { role: "assistant", content: "Hello! How can I help?\n```ts\ncode\n```" },
  ];
  expect(chatPreview(history, "тест")).toBe("Hello! How can I help?");
  expect(chatPreview([], "x")).toBeUndefined();
});

test("clips long previews", () => {
  const preview = chatPreview([{ role: "user", content: "a".repeat(500) }], "t") ?? "";
  expect(preview.length).toBe(120);
  expect(preview.endsWith("…")).toBe(true);
});

test("groups chats by calendar day", () => {
  const now = at("2026-03-12T10:00:00");
  expect(chatGroup(at("2026-03-12T00:10:00"), now)).toBe("today");
  expect(chatGroup(at("2026-03-11T23:00:00"), now)).toBe("yesterday");
  expect(chatGroup(at("2026-03-06T09:00:00"), now)).toBe("week");
  expect(chatGroup(at("2026-03-01T09:00:00"), now)).toBe("earlier");
});

test("formats compact times", () => {
  const now = at("2026-03-12T10:00:00");
  expect(chatTime(now - 10_000, now)).toBe("now");
  expect(chatTime(now - 5 * 60_000, now)).toBe("5m");
  expect(chatTime(now - 4 * 3_600_000, now)).toBe("4h");
  expect(chatTime(at("2026-03-11T09:05:00"), now, "en-US")).toBe("9:05 AM");
  expect(chatTime(at("2026-02-01T09:00:00"), now, "en-US")).toBe("Feb 1");
});

test("matches every word in the title or the preview", () => {
  expect(matchesChat("build ci", "Fix build", "fails in CI")).toBe(true);
  expect(matchesChat("deploy", "Fix build", "fails in CI")).toBe(false);
  expect(matchesChat("", "anything")).toBe(true);
});

test("splits text for highlighting", () => {
  expect(highlightParts("Fix the build", "build")).toEqual([
    { text: "Fix the ", match: false },
    { text: "build", match: true },
  ]);
  expect(highlightParts("abc", "")).toEqual([{ text: "abc", match: false }]);
});

test("full-text search finds a chat by its messages and shows the words around the match", async () => {
  const { contentSnippet } = await import("../src/core/chatList");
  const texts = [
    "Fix the login.",
    "The login timed out because the timeout was read from the wrong option. I moved it to Options and added a retry with backoff in src/retry.ts. The tests pass.",
  ];
  const snippet = contentSnippet("wrong option", texts, 60);
  expect(snippet).toContain("wrong option");
  expect(snippet?.startsWith("…")).toBe(true);
  expect(snippet?.length).toBeLessThanOrEqual(62);
  // Every word must appear somewhere in the chat.
  expect(contentSnippet("retry banana", texts)).toBeUndefined();
  expect(contentSnippet("  ", texts)).toBeUndefined();
  // Words may be in different messages.
  expect(contentSnippet("login backoff", texts)).toBeDefined();
});
