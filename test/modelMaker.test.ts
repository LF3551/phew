import { expect, test } from "vitest";
import { modelMaker } from "../src/core/modelLabels";

test("the badge shows who made the model, also through another provider", () => {
  const badge = (provider: "openai" | "anthropic" | "gemini" | "vscode", model: string) =>
    modelMaker({ provider, model }).badge;
  // A Claude model through GitHub Copilot, which speaks the OpenAI protocol.
  expect(badge("openai", "claude-haiku-5.5")).toBe("A");
  expect(badge("openai", "anthropic/claude-sonnet-4.5")).toBe("A");
  expect(badge("openai", "gpt-6.1-sol")).toBe("O");
  expect(badge("openai", "o4-mini")).toBe("O");
  expect(badge("openai", "gemini-3.8-flash")).toBe("G");
  expect(badge("openai", "grok-4.7")).toBe("X");
  expect(badge("openai", "deepseek-chat")).toBe("D");
  expect(badge("openai", "codestral-latest")).toBe("M");
  expect(badge("openai", "qwen2.5-coder:14b")).toBe("Q");
  expect(badge("openai", "llama-3.3-70b-versatile")).toBe("L");
});

test("an unknown model keeps the badge of its protocol, and Auto keeps VS Code", () => {
  expect(modelMaker({ provider: "openai", model: "my-company-model" }).badge).toBe("O");
  expect(modelMaker({ provider: "anthropic", model: "custom" }).badge).toBe("A");
  expect(modelMaker({ provider: "vscode", model: "auto" }).badge).toBe("VS");
  expect(modelMaker({ provider: "vscode", model: "claude-sonnet-5.5" }).badge).toBe("A");
});
