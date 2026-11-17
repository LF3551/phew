import { expect, test } from "vitest";
import { CheckpointStore } from "../src/core/checkpoints";

test("restores the earliest original content of every file after the checkpoint", () => {
  const store = new CheckpointStore();
  store.begin("one", "first");
  store.record("a.ts", "a0");
  store.record("a.ts", "a1");
  store.begin("two", "second");
  store.record("a.ts", "a1");
  store.record("b.ts", null);
  expect(store.changedSince("one")).toEqual(["a.ts", "b.ts"]);
  expect(store.restore("one")).toEqual([
    { path: "a.ts", content: "a0" },
    { path: "b.ts", content: null },
  ]);
  expect(store.list()).toHaveLength(0);
});

test("restores only the later checkpoint", () => {
  const store = new CheckpointStore();
  store.begin("one", "first");
  store.record("a.ts", "a0");
  store.begin("two", "second");
  store.record("a.ts", "a1");
  expect(store.restore("two")).toEqual([{ path: "a.ts", content: "a1" }]);
  expect(store.has("one")).toBe(true);
});

test("rejects unknown checkpoints and records without a checkpoint", () => {
  const store = new CheckpointStore();
  expect(() => store.record("a", "x")).toThrow();
  expect(() => store.restore("missing")).toThrow();
});
