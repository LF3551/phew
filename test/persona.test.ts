import { describe, expect, test } from "vitest";
import {
  type ActivityDay,
  currentStreak,
  earnedAchievements,
  longestStreak,
  recordActivity,
  wrapped,
} from "../src/core/achievements";
import { finalizeCommitMessage } from "../src/core/commit";
import { defaultAssistant, initials, parseAssistant, personaPrompt } from "../src/core/persona";
import { emptyStats } from "../src/core/stats";
import { parseWebviewMessage } from "../src/shared/protocol";

describe("assistant persona", () => {
  test("parses and cleans the settings", () => {
    const assistant = parseAssistant({
      name: "  Max <b>\n",
      avatar: "🦊",
      persona: "mentor",
      userName: "Aleksei",
      language: "Russian",
    });
    expect(assistant).toMatchObject({
      name: "Max b",
      avatar: "🦊",
      persona: "mentor",
      userName: "Aleksei",
      language: "Russian",
    });
    expect(parseAssistant({ name: "", avatar: "<script>", persona: "evil" })).toEqual(defaultAssistant);
    expect(parseAssistant({ avatar: "MP" }).avatar).toBe("MP");
    expect(parseAssistant({ avatar: "ABC" }).avatar).toBe("");
  });

  test("builds the persona prompt", () => {
    const prompt = personaPrompt(
      parseAssistant({ name: "Max", persona: "quiet", userName: "Alex", language: "Russian" }),
    );
    expect(prompt).toContain("Your name is Max");
    expect(prompt).toContain("few words");
    expect(prompt).toContain("Call the user Alex.");
    expect(prompt).toContain("Always answer in Russian");
    const plain = personaPrompt(defaultAssistant);
    expect(plain).not.toContain("Your name is");
    expect(plain).toContain("language that the user writes in");
    const custom = personaPrompt(parseAssistant({ persona: "custom", customPersona: "Speak like a pirate." }));
    expect(custom).toContain("Speak like a pirate.");
  });

  test("initials", () => {
    expect(initials("Max Power")).toBe("MP");
    expect(initials("max")).toBe("MA");
  });
});

describe("achievements and wrapped", () => {
  const task = (date: string, extra: Partial<Parameters<typeof recordActivity>[1]> = {}) => ({
    date: new Date(date),
    success: true,
    bugFixed: true,
    verifiedFirstTry: false,
    tokens: 100,
    cost: 0.01,
    model: "gpt",
    ...extra,
  });

  test("records daily activity, streaks, and the wrapped summary", () => {
    let days: ActivityDay[] = [];
    days = recordActivity(days, task("2026-11-10T10:00:00"));
    days = recordActivity(days, task("2026-11-11T02:30:00", { model: "claude", verifiedFirstTry: true }));
    days = recordActivity(days, task("2026-11-12T10:00:00", { bugFixed: false, model: "gemini" }));
    days = recordActivity(days, task("2026-11-12T11:00:00", { success: false }));
    expect(days).toHaveLength(3);
    expect(days[2]).toMatchObject({ tasks: 1, bugs: 0 });
    expect(days[1].nightTasks).toBe(1);
    const today = new Date("2026-11-12T20:00:00");
    expect(currentStreak(days, today)).toBe(3);
    expect(currentStreak(days, new Date("2026-11-13T09:00:00"))).toBe(3);
    expect(currentStreak(days, new Date("2026-11-15T09:00:00"))).toBe(0);
    expect(longestStreak(days)).toBe(3);

    const week = wrapped(days, "week", 30, today);
    expect(week).toMatchObject({ tasks: 3, bugs: 2, minutesSaved: 60, activeDays: 3, streak: 3 });
    expect(["gpt", "claude", "gemini"]).toContain(week.topModel);

    const stats = { ...emptyStats(), bugsFixed: 2 };
    expect(earnedAchievements(stats, days, today)).toEqual([
      "first-fix",
      "green-first-try",
      "night-owl",
      "streak-3",
      "polyglot",
    ]);
  });
});

describe("persona messages", () => {
  test("validates the new webview messages", () => {
    expect(
      parseWebviewMessage({
        type: "saveAssistant",
        name: "Max",
        avatar: "",
        persona: "partner",
        customPersona: "",
        userName: "",
        language: "match",
      }),
    ).toMatchObject({ type: "saveAssistant", name: "Max" });
    expect(parseWebviewMessage({ type: "saveAssistant", name: "Max", persona: "boss" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "showWrapped", period: "month" })).toEqual({
      type: "showWrapped",
      period: "month",
    });
    expect(parseWebviewMessage({ type: "showWrapped", period: "year" })).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "saveImage", dataUrl: "data:image/png;base64,AAAA", fileName: "a.png" }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({ type: "saveImage", dataUrl: "data:image/png;base64,AAAA", fileName: "../a.png" }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "saveImage", dataUrl: "javascript:alert(1)", fileName: "a.png" }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "skipOnboarding" })).toEqual({ type: "skipOnboarding" });
  });

  test("Assisted-by appears only when the user turns it on", () => {
    const settings = {
      style: "conventional" as const,
      language: "English",
      maxSubjectLength: 72,
      includeBody: false,
      signOff: false,
      gpgSign: "git" as const,
      author: "",
      trailers: [],
      instructions: "",
    };
    expect(finalizeCommitMessage("fix: x\n\nAssisted-by: Bot", settings, {})).toBe("fix: x");
    expect(finalizeCommitMessage("fix: x", { ...settings, assistedBy: true }, {})).toBe("fix: x\n\nAssisted-by: Phew");
  });
});
