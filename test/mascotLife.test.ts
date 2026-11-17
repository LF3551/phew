import { expect, test } from "vitest";
import { gazeOffset, mascotPose, nextBlink } from "../src/core/mascotLife";

test("shows what the agent does while it works", () => {
  expect(mascotPose({ mood: "working", act: "read", motion: "lively" })).toMatchObject({ face: "open", look: "scan" });
  expect(mascotPose({ mood: "working", act: "think", motion: "lively" })).toMatchObject({ look: "up" });
  expect(mascotPose({ mood: "working", act: "run", motion: "lively" })).toMatchObject({ look: "down" });
  expect(mascotPose({ mood: "working", act: "edit", motion: "lively" })).toMatchObject({
    face: "focus",
    blinks: false,
  });
});

test("sweats only while it waits for the user or works for long", () => {
  expect(mascotPose({ mood: "working", act: "wait", motion: "lively" }).sweat).toBe(true);
  expect(mascotPose({ mood: "working", act: "read", motion: "lively" }).sweat).toBe(false);
  expect(mascotPose({ mood: "working", act: "read", motion: "lively", longTask: true }).sweat).toBe(true);
});

test("follows the pointer and the typing only in the lively motion", () => {
  expect(mascotPose({ mood: "idle", motion: "lively", pointer: true }).look).toBe("follow");
  expect(mascotPose({ mood: "idle", motion: "lively", pointer: true, typing: true }).look).toBe("down");
  expect(mascotPose({ mood: "idle", motion: "calm", pointer: true })).toMatchObject({ look: "center", blinks: true });
  expect(mascotPose({ mood: "working", act: "read", motion: "calm" }).look).toBe("center");
});

test("falls asleep only in the lively motion", () => {
  expect(mascotPose({ mood: "idle", motion: "lively", asleep: true }).face).toBe("sleepy");
  expect(mascotPose({ mood: "idle", motion: "calm", asleep: true }).face).toBe("open");
});

test("keeps the classic faces without motion", () => {
  expect(mascotPose({ mood: "idle", motion: "still" })).toEqual({
    face: "relief",
    look: "center",
    blinks: false,
    sweat: false,
  });
  expect(mascotPose({ mood: "failed", motion: "lively" }).face).toBe("worry");
  expect(mascotPose({ mood: "done", motion: "lively" }).face).toBe("relief");
});

test("blinks at irregular times", () => {
  expect(nextBlink(() => 0)).toEqual({ delay: 2800, double: true });
  expect(nextBlink(() => 0.99).delay).toBeLessThanOrEqual(7200);
  expect(nextBlink(() => 0.5).double).toBe(false);
});

test("limits the gaze offset", () => {
  expect(gazeOffset(0, 0)).toEqual({ x: 0, y: 0 });
  expect(gazeOffset(1000, 0)).toEqual({ x: 18, y: 0 });
  expect(gazeOffset(120, 0).x).toBe(9);
  expect(gazeOffset(0, -1000).y).toBeCloseTo(-12.6);
});
