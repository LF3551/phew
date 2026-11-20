import { describe, expect, test } from "vitest";
import { healNote, healNotice, nextHealStep, startupFilesOf } from "../src/core/shellHealth";

describe("nextHealStep", () => {
  test("a shell with marks works as it is", () => {
    expect(nextHealStep({ integrated: true, markSeen: true, startupFiles: true })).toBe("ok");
    expect(nextHealStep({ integrated: true, markSeen: true, startupFiles: false })).toBe("ok");
  });

  test("no marks with startup files: try again without them", () => {
    expect(nextHealStep({ integrated: true, markSeen: false, startupFiles: true })).toBe("retry-without-startup");
  });

  test("no marks even without startup files: run in processes", () => {
    expect(nextHealStep({ integrated: true, markSeen: false, startupFiles: false })).toBe("fallback");
  });

  test("a shell that never has marks stays as it was", () => {
    expect(nextHealStep({ integrated: false, markSeen: false, startupFiles: true })).toBe("plain");
    expect(nextHealStep({ integrated: false, markSeen: false, startupFiles: false })).toBe("plain");
  });
});

describe("the words of self-healing", () => {
  test.each([
    ["/bin/zsh", ".zshrc"],
    ["/usr/local/bin/bash", ".bashrc"],
    ["/opt/homebrew/bin/fish", "config.fish"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "your PowerShell profile"],
    ["powershell.exe", "your PowerShell profile"],
    ["/bin/ksh", "your startup files"],
  ])("%s uses %s", (shell, files) => {
    expect(startupFilesOf(shell)).toBe(files);
  });

  test("the chat says what happened, what is missing, and what to do", () => {
    const text = healNotice("without-startup", "/bin/zsh");
    expect(text).toMatch(/started without \.zshrc/);
    expect(text).toMatch(/Aliases and tools from \.zshrc are missing/);
    expect(text).toMatch(/prompt theme/);
    expect(healNotice("processes", "/bin/zsh")).toMatch(/run in processes: the output and the exit code stay exact/);
    expect(healNotice("processes", "/bin/zsh")).toMatch(/phew\.commands\.shell/);
  });

  test("the model learns what it cannot rely on", () => {
    expect(healNote("without-startup", "/bin/bash")).toMatch(
      /without \.bashrc, so aliases, functions, and PATH changes/,
    );
    expect(healNote("processes", "/bin/bash")).toMatch(/cd and variables do not carry over/);
  });
});
