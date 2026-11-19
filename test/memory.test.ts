import { expect, test } from "vitest";
import { addNote, findNote, forgetNote, learnRequest, memoryPrompt, parseNotes } from "../src/core/memory";

test("reads old plain notes and new notes with a source and a day", () => {
  const notes = parseNotes(
    "# Phew project memory\n\n- Tests run with npm test\n- The API lives in services/api <!-- source: services/api/index.ts; added: 2026-11-10 -->\n",
  );
  expect(notes).toEqual([
    { text: "Tests run with npm test" },
    { text: "The API lives in services/api", source: "services/api/index.ts", added: "2026-11-10" },
  ]);
});

test("adds, confirms, replaces, and forgets notes", () => {
  let file = addNote("", "Use pnpm, not npm", { source: "package.json", added: "2026-11-19" }).content;
  expect(file).toContain("- Use pnpm, not npm <!-- source: package.json; added: 2026-11-19 -->");
  // The same fact again: confirmed with the new day, not added twice.
  const again = addNote(file, "use PNPM, not npm", { added: "2026-11-20" });
  expect(again.added).toBe(false);
  expect(parseNotes(again.content)).toEqual([{ text: "use PNPM, not npm", added: "2026-11-20" }]);
  // A correction replaces the old note.
  const fixed = addNote(file, "Use bun", { replaces: "pnpm", added: "2026-11-21" });
  expect(fixed.replaced).toBe(true);
  expect(parseNotes(fixed.content).map((note) => note.text)).toEqual(["Use bun"]);
  file = addNote(fixed.content, "Docs live in docs/").content;
  expect(forgetNote(file, "docs live")).not.toContain("Docs live");
  expect(forgetNote(file, "nothing like this")).toBeUndefined();
});

test("finds a note by its text or by words only it has", () => {
  const notes = [{ text: "Run tests with pytest -q" }, { text: "Run the app with make dev" }];
  expect(findNote(notes, "run tests with pytest -q")).toBe(0);
  expect(findNote(notes, "make dev")).toBe(1);
  expect(findNote(notes, "Run")).toBe(-1);
});

test("never keeps secrets or comment marks in a note", () => {
  const content = addNote("", "Token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 <!-- x -->").content;
  expect(content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(parseNotes(content)[0]?.text).not.toContain("<!--");
});

test("the prompt has personal preferences, project facts, and asks to check facts whose source changed", () => {
  const prompt = memoryPrompt(
    [
      { text: "Tests run with npm test", source: "package.json", added: "2026-11-01", state: "unchanged" },
      { text: "The API port is 3000", source: "src/server.ts", added: "2026-11-01", state: "changed" },
      { text: "Old helper in src/old.ts", source: "src/old.ts", state: "missing" },
    ],
    [{ text: "Answer in Russian" }],
  );
  expect(prompt).toContain("Personal preferences of the user, for every project:\n- Answer in Russian");
  expect(prompt).toContain("- Tests run with npm test (from package.json)");
  expect(prompt).toContain("src/server.ts changed after this note: check it.");
  expect(prompt).toContain("src/old.ts no longer exists: check it.");
  expect(prompt).toContain("forget");
  expect(memoryPrompt([], [])).toBe("");
});

test("/learn proposes lessons and saves only what the user chooses", () => {
  const request = learnRequest("the test flags");
  expect(request).toContain("Focus on: the test flags");
  expect(request).toContain("ask_user");
  expect(request).toContain("Do not save anything yet");
});
