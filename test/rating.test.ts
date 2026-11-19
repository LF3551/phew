import { expect, test } from "vitest";
import { afterRating, parseRatingState, ratingTarget, shouldAskForRating } from "../src/core/rating";
import { parseWebviewMessage } from "../src/shared/protocol";

const day = 86_400_000;
const now = Date.UTC(2026, 10, 20);
const regular = {
  enabled: true,
  goodMoment: true,
  tasksCompleted: 6,
  activeDays: 3,
  firstUse: now - 10 * day,
  state: { asked: 0 },
  now,
};

test("asks a regular user after a task that went well", () => {
  expect(shouldAskForRating(regular)).toBe(true);
});

test("never asks too early, at a bad moment, or when turned off", () => {
  expect(shouldAskForRating({ ...regular, goodMoment: false })).toBe(false);
  expect(shouldAskForRating({ ...regular, enabled: false })).toBe(false);
  expect(shouldAskForRating({ ...regular, tasksCompleted: 4 })).toBe(false);
  expect(shouldAskForRating({ ...regular, activeDays: 2 })).toBe(false);
  expect(shouldAskForRating({ ...regular, firstUse: now - 2 * day })).toBe(false);
});

test("asks rarely: a month apart, three times at most, and never after an answer", () => {
  const shown = afterRating({ asked: 0 }, "shown", now);
  expect(shown).toEqual({ asked: 1, lastAsked: now });
  expect(shouldAskForRating({ ...regular, state: shown, now: now + 29 * day })).toBe(false);
  expect(shouldAskForRating({ ...regular, state: shown, now: now + 31 * day })).toBe(true);
  expect(shouldAskForRating({ ...regular, state: { asked: 3, lastAsked: now - 90 * day } })).toBe(false);
  expect(shouldAskForRating({ ...regular, state: afterRating(shown, "rate", now) })).toBe(false);
  expect(shouldAskForRating({ ...regular, state: afterRating(shown, "never", now) })).toBe(false);
  // Feedback or Not now: again only after the pause.
  const later = afterRating(shown, "later", now + 5 * day);
  expect(shouldAskForRating({ ...regular, state: later, now: now + 20 * day })).toBe(false);
  expect(shouldAskForRating({ ...regular, state: later, now: now + 40 * day })).toBe(true);
});

test("rates in the store of the editor", () => {
  expect(ratingTarget("Visual Studio Code").url).toContain("marketplace.visualstudio.com");
  expect(ratingTarget("Visual Studio Code - Insiders").url).toContain("marketplace.visualstudio.com");
  expect(ratingTarget("VSCodium").url).toContain("open-vsx.org");
  expect(ratingTarget("Cursor").store).toBe("Open VSX");
});

test("reads a broken saved state safely, and checks the answers from the chat", () => {
  expect(parseRatingState(undefined)).toEqual({ asked: 0 });
  expect(parseRatingState({ asked: -2, done: "maybe" })).toEqual({ asked: 0 });
  expect(parseRatingState({ asked: 2, lastAsked: 5, done: "rated" })).toEqual({
    asked: 2,
    lastAsked: 5,
    done: "rated",
  });
  expect(parseWebviewMessage({ type: "ratingAnswer", answer: "rate" })).toEqual({
    type: "ratingAnswer",
    answer: "rate",
  });
  expect(parseWebviewMessage({ type: "ratingAnswer", answer: "spam" })).toBeUndefined();
});
