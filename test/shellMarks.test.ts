import { expect, test } from "vitest";
import { describeShellResult, parseCommandResult } from "../src/core/commandResult";
import { lastLine, looksLikePrompt, plainTerminalText, ShellMarkParser } from "../src/core/shellMarks";

test("the parser finds marks between text, also when a mark arrives in two chunks", () => {
  const parser = new ShellMarkParser();
  const pieces = [
    ...parser.push("$ ls\r\n\u001b]6973;C\u0007a.txt\r\n\u001b]69"),
    ...parser.push("73;P;2;/home/me/my;dir\u0007$ "),
  ];
  expect(pieces).toEqual([
    { text: "$ ls\r\n" },
    { mark: { kind: "start" } },
    { text: "a.txt\r\n" },
    { mark: { kind: "prompt", exitCode: 2, cwd: "/home/me/my;dir" } },
    { text: "$ " },
  ]);
});

test("other escape sequences pass through untouched", () => {
  const parser = new ShellMarkParser();
  expect(parser.push("\u001b]0;title\u0007\u001b[32mok\u001b[0m")).toEqual([
    { text: "\u001b]0;title\u0007\u001b[32mok\u001b[0m" },
  ]);
});

test("plain text drops colors, titles, and lines that a carriage return redrew", () => {
  expect(plainTerminalText("\u001b]0;t\u0007\u001b[1;32mok\u001b[0m\r\n10%\r100%\r\n")).toBe("ok\n100%\n");
});

test("a quiet program with a prompt or a question waits for input", () => {
  expect(looksLikePrompt("Connecting...\r\nuser@jump-host:~$ ")).toBe(true);
  expect(looksLikePrompt("Password: ")).toBe(true);
  expect(looksLikePrompt("Continue? [y/N]")).toBe(true);
  expect(looksLikePrompt(">>> ")).toBe(true);
  expect(looksLikePrompt("Compiling 120 files\r\n")).toBe(false);
  expect(lastLine("a\r\nname? \r\n\r\n")).toBe("name?");
});

test("the model learns what to do with a program that waits", () => {
  const text = describeShellResult(
    "gcloud compute ssh jump-host",
    { state: "waiting", output: "Welcome\nuser@jump-host:~$", prompt: "user@jump-host:~$" },
    120,
  );
  expect(text).toMatch(/^\$ gcloud compute ssh jump-host\n\[waiting for input\]\nWelcome/);
  expect(text).toMatch(/next run_command types into it/);
  expect(text).toMatch(/Do not type passwords/);
  const parsed = parseCommandResult(text);
  expect(parsed.status).toBe("waiting for input");
  expect(parsed.output).toBe("Welcome\nuser@jump-host:~$");
  expect(describeShellResult("npm test", { state: "done", output: "", exitCode: 1 }, 120)).toBe(
    "$ npm test\n[exit code 1]\n(no output)",
  );
});
