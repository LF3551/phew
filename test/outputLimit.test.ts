import { expect, test } from "vitest";
import { limitForChat, limitForModel, OutputKeeper } from "../src/core/outputLimit";

test("the keeper holds the start and the end of a huge output, and counts what it left out", () => {
  const keeper = new OutputKeeper(100, 1000);
  for (let line = 1; line <= 100_000; line++) keeper.push(`line ${line}\n`);
  const text = keeper.text();
  expect(text.length).toBeLessThan(2_000);
  expect(text.startsWith("line 1\nline 2\n")).toBe(true);
  expect(text.endsWith("line 100000\n")).toBe(true);
  expect(text).toMatch(/… [\d,]+ lines left out; the full output is in the terminal …/);
  expect(keeper.omitted).toBeGreaterThan(99_000);
});

test("the model gets a short start and a longer end", () => {
  const output = Array.from({ length: 50_000 }, (_, index) => `row ${index}`).join("\n");
  const limited = limitForModel(output);
  expect(limited.length).toBeLessThan(16_000);
  expect(limited).toMatch(/^row 0\n/);
  expect(limited).toMatch(/row 49999$/);
  expect(limited).toMatch(/lines left out \(in the terminal of the chat\)/);
  expect(limitForModel("short")).toBe("short");
});

test("the chat gets the newest part with a note about skipped lines", () => {
  const text = "x\r\n".repeat(100_000);
  const limited = limitForChat(text, 3_000);
  expect(limited.length).toBeLessThan(3_200);
  expect(limited).toMatch(/lines skipped here; the terminal has all of them/);
});
