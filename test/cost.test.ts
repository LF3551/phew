import { expect, test } from "vitest";
import { CostMeter, findPrice, formatCost, formatTokens } from "../src/core/cost";

test("calculates cost and detects the budget limit", () => {
  const meter = new CostMeter({ input: 2, output: 8 }, { maxCostPerTask: 0.01, maxTokensPerTask: 0 });
  meter.add({ inputTokens: 1000, outputTokens: 500 });
  expect(meter.cost).toBeCloseTo(0.006);
  expect(meter.exceeded()).toBeUndefined();
  meter.add({ inputTokens: 2000, outputTokens: 0 });
  expect(meter.exceeded()).toMatch(/limit/);
});

test("limits tokens without a price", () => {
  const meter = new CostMeter(undefined, { maxCostPerTask: 1, maxTokensPerTask: 100 });
  meter.add({ inputTokens: 60, outputTokens: 40 });
  expect(meter.cost).toBeUndefined();
  expect(meter.exceeded()).toMatch(/100/);
});

test("finds exact and prefix prices and ignores invalid entries", () => {
  const table = { "gpt-4.1": { input: 2, output: 8 }, "claude-*": { input: 3, output: 15 }, bad: { input: "x" } };
  expect(findPrice("gpt-4.1", table)).toEqual({ input: 2, output: 8 });
  expect(findPrice("claude-sonnet", table)).toEqual({ input: 3, output: 15 });
  expect(findPrice("bad", table)).toBeUndefined();
  expect(findPrice("other", table)).toBeUndefined();
});

test("formats numbers for the user interface", () => {
  expect(formatCost(0.0012)).toBe("$0.0012");
  expect(formatCost(1.5)).toBe("$1.50");
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(12_300)).toBe("12.3k");
});
