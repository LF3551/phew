import { expect, test } from "vitest";
import { buildTitleMessages, cleanTitle, firstExchange } from "../src/core/chatTitle";

test("cleans the reply of the model", () => {
  expect(cleanTitle('"Fix login redirect loop."')).toBe("Fix login redirect loop");
  expect(cleanTitle("Title: Погода в песочнице")).toBe("Погода в песочнице");
  expect(cleanTitle("<think>hmm</think>\n**Миграция базы без простоя**\n")).toBe("Миграция базы без простоя");
  expect(cleanTitle("")).toBeUndefined();
  expect(cleanTitle("a ".repeat(30))).toBeUndefined();
});

test("uses the first request and the first answer", () => {
  expect(
    firstExchange([
      { role: "user", content: "тест" },
      { role: "assistant", content: "", toolCalls: [] },
      { role: "assistant", content: "Привет!" },
    ]),
  ).toEqual({ request: "тест", answer: "Привет!" });
  expect(firstExchange([{ role: "user", content: "x" }])).toBeUndefined();
});

test("limits the input", () => {
  const messages = buildTitleMessages("a".repeat(5000), "b");
  expect(messages[1]?.content.length).toBeLessThan(1600);
});
