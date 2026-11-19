import { expect, test } from "vitest";
import { type ProviderFacts, setupOptions } from "../src/core/setupOptions";
import { parseWebviewMessage } from "../src/shared/protocol";

const providers: ProviderFacts[] = [
  { id: "copilot", label: "GitHub Copilot", group: "Editor", envFound: false, available: false },
  { id: "openai", label: "OpenAI", group: "Cloud", keyEnv: "OPENAI_API_KEY", envFound: false },
  { id: "gemini", label: "Google Gemini", group: "Cloud", keyEnv: "GEMINI_API_KEY", envFound: false },
  { id: "openrouter", label: "OpenRouter", group: "Gateway", keyEnv: "OPENROUTER_API_KEY", envFound: false },
  { id: "ollama", label: "Ollama", group: "Local", envFound: false, available: false, note: "Not running" },
  { id: "lmstudio", label: "LM Studio", group: "Local", envFound: false, available: false, note: "Not running" },
];

const with_ = (id: string, change: Partial<ProviderFacts>) =>
  providers.map((provider) => (provider.id === id ? { ...provider, ...change } : provider));

test("on a fresh computer, offers the free options and the private one", () => {
  const options = setupOptions(providers, true);
  expect(options.map((option) => [option.id, option.kind])).toEqual([
    ["copilot", "free"],
    ["gemini", "free"],
    ["openrouter", "free"],
    ["ollama", "private"],
  ]);
  expect(options.find((option) => option.id === "openrouter")?.detail).toContain("50 requests a day");
  expect(options.find((option) => option.id === "gemini")?.detail).toContain("may use your requests");
});

test("puts what is ready first: Copilot models, a key in the environment, and a running server", () => {
  const ready = with_("copilot", { available: true, note: "12 models" })
    .map((provider) => (provider.id === "openai" ? { ...provider, envFound: true } : provider))
    .map((provider) =>
      provider.id === "lmstudio" ? { ...provider, available: true, note: "Running · 2 models" } : provider,
    );
  const options = setupOptions(ready, true);
  expect(options.slice(0, 3).map((option) => [option.id, option.kind])).toEqual([
    ["copilot", "ready"],
    ["openai", "ready"],
    ["lmstudio", "ready"],
  ]);
  expect(options[1]?.detail).toBe("Key found in $OPENAI_API_KEY.");
  expect(options[2]?.detail).toContain("Private");
  // Copilot is ready, and a local server runs: neither shows again as free or private.
  expect(options.filter((option) => option.id === "copilot")).toHaveLength(1);
  expect(options.some((option) => option.kind === "private")).toBe(false);
});

test("does not offer GitHub Copilot in editors that are based on VS Code", () => {
  expect(setupOptions(providers, false).some((option) => option.id === "copilot")).toBe(false);
});

test("a free provider with a key in the environment shows as ready, not as free", () => {
  const options = setupOptions(with_("gemini", { envFound: true }), true);
  expect(options.filter((option) => option.id === "gemini").map((option) => option.kind)).toEqual(["ready"]);
});

test("the chat may ask for the options and connect a provider by its id", () => {
  expect(parseWebviewMessage({ type: "setupOptions" })).toEqual({ type: "setupOptions" });
  expect(parseWebviewMessage({ type: "connectProvider", id: "copilot-token" })).toEqual({
    type: "connectProvider",
    id: "copilot-token",
  });
  expect(parseWebviewMessage({ type: "connectProvider", id: "../x" })).toBeUndefined();
  expect(parseWebviewMessage({ type: "connectProvider" })).toBeUndefined();
});
