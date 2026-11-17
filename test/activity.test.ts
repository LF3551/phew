import { expect, test } from "vitest";
import { activityBadge } from "../src/core/activity";

test("shows no badge when nothing waits", () => {
  expect(activityBadge({ waiting: 0, unseen: 0 })).toBeUndefined();
});

test("shows waiting chats before finished chats", () => {
  expect(activityBadge({ waiting: 1, unseen: 2 }, "Drop")).toEqual({
    value: 1,
    tooltip: "Drop needs your answer in 1 chat",
  });
  expect(activityBadge({ waiting: 0, unseen: 2 })).toEqual({ value: 2, tooltip: "Phew finished 2 chats" });
});
