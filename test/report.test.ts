import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReport, formFields, issueUrl, type ReportFacts, sanitize } from "../src/core/report";

const facts = (overrides: Partial<ReportFacts> = {}): ReportFacts => ({
  phew: "1.1.3",
  editor: { name: "Visual Studio Code", version: "1.146.0" },
  os: { platform: "darwin", release: "24.1.0", arch: "arm64" },
  language: "en",
  shell: { path: "/bin/zsh", terminal: "open", startupFiles: true, healing: [] },
  model: { provider: "Anthropic", model: "claude-sonnet-4-5" },
  settings: { "commands.approval": "allowlist", "subagents.enabled": true, "agent.maxSteps": 40 },
  log: ["10:00:01 info Phew 1.1.3 activated."],
  ...overrides,
});

const mac = { home: "/Users/jane", user: "jane", workspaces: ["/Users/jane/work/secret-project"] };

describe("sanitize", () => {
  test("removes secrets, the project, the home folder, and the user name", () => {
    const text = sanitize(
      [
        "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "opened /Users/jane/work/secret-project/src/app.ts",
        "config in /Users/jane/.zshrc",
        "hello jane, by Jane",
      ].join("\n"),
      mac,
    );
    expect(text).not.toMatch(/sk-ant-api03-abc|ghp_abcdef|secret-project|\/Users\/jane|\bjane\b/i);
    expect(text).toMatch(/opened <workspace>\/src\/app\.ts/);
    expect(text).toMatch(/config in ~\/\.zshrc/);
    expect(text).toMatch(/hello <user>, by <user>/);
  });

  test("handles Windows paths in both slash styles, and several folders", () => {
    const text = sanitize("C:\\Users\\Jane\\api\\a.ts and C:/Users/Jane/web/b.ts and C:\\Users\\Jane\\x", {
      home: "C:\\Users\\Jane",
      user: "Jane",
      workspaces: ["C:\\Users\\Jane\\api", "C:\\Users\\Jane\\web"],
    });
    expect(text).toBe("<workspace 1>\\a.ts and <workspace 2>/b.ts and ~\\x");
  });

  test("a short or missing user name does not eat other words", () => {
    expect(sanitize("an ant and a jo", { user: "jo", workspaces: [] })).toBe("an ant and a jo");
    expect(sanitize("janet and jane-doe", { user: "jane", workspaces: [] })).toBe("janet and jane-doe");
  });
});

describe("buildReport", () => {
  test("has what a maintainer needs", () => {
    const report = buildReport(facts(), "The terminal hangs after npm install.", mac);
    expect(report).toMatch(/## What happened\n\nThe terminal hangs after npm install\./);
    expect(report).toMatch(/- Phew 1\.1\.3/);
    expect(report).toMatch(/- Visual Studio Code 1\.146\.0/);
    expect(report).toMatch(/- darwin 24\.1\.0 \(arm64\), language en/);
    expect(report).toMatch(/- Shell: `\/bin\/zsh`, terminal: open, startup files: on/);
    expect(report).toMatch(/- Model: Anthropic, `claude-sonnet-4-5`/);
    expect(report).toMatch(/\| `commands\.approval` \| allowlist \|/);
    expect(report).toMatch(/```text\n10:00:01 info Phew 1\.1\.3 activated\.\n```/);
  });

  test("shows self-healing, a terminal library problem, a remote, and no model", () => {
    const report = buildReport(
      facts({
        editor: { name: "Cursor", version: "1.99.0", remote: "ssh-remote" },
        shell: {
          path: "/bin/bash",
          terminal: "open",
          startupFiles: false,
          healing: ["bash: without startup files"],
          ptyError: "no prebuilt binary for linux-musl",
        },
        model: undefined,
        log: [],
      }),
      "",
      mac,
    );
    expect(report).toMatch(/Cursor 1\.99\.0 \(remote: ssh-remote\)/);
    expect(report).toMatch(/startup files: off/);
    expect(report).toMatch(/- Self-healing: bash: without startup files/);
    expect(report).toMatch(/- Terminal library: no prebuilt binary for linux-musl/);
    expect(report).toMatch(/- Model: none connected/);
    expect(report).toMatch(/_Describe what you did/);
    expect(report).toMatch(/\(empty\)/);
  });

  test("never leaks a secret or a path from the log or the description", () => {
    const report = buildReport(
      facts({
        log: [
          "10:00:02 warn request failed with key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
          "10:00:03 info opened /Users/jane/work/secret-project/.env",
        ],
      }),
      "My project /Users/jane/work/secret-project breaks, my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      mac,
    );
    expect(report).not.toMatch(/sk-proj-abc|ghp_abcdef|secret-project|\/Users\/jane/);
    expect(report).toMatch(/opened <workspace>\/\.env/);
  });
});

describe("the bug report form", () => {
  const fields = formFields(facts(), "It hangs in /Users/jane/work/secret-project.", mac);

  test("fills the short fields, without private paths", () => {
    expect(fields).toEqual({
      what: "It hangs in <workspace>.",
      phew: "1.1.3",
      vscode: "Visual Studio Code 1.146.0",
      model: "Anthropic claude-sonnet-4-5",
      os: "darwin 24.1.0 (arm64)",
    });
  });

  test("every field that Phew fills exists in the form of the repository", () => {
    const form = readFileSync(join(__dirname, "../.github/ISSUE_TEMPLATE/bug_report.yml"), "utf8");
    const ids = [...form.matchAll(/^\s+id: (\w+)$/gm)].map((match) => match[1]);
    for (const id of [...Object.keys(fields), "logs"]) expect(ids, id).toContain(id);
  });

  test("a short report goes into the form, the whole report into the logs field", () => {
    const link = issueUrl("LF3551/phew", "Bug: it hangs", fields, "## What happened\n\nIt hangs.");
    expect(link.complete).toBe(true);
    const url = new URL(link.url);
    expect(url.origin + url.pathname).toBe("https://github.com/LF3551/phew/issues/new");
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("title")).toBe("Bug: it hangs");
    expect(url.searchParams.get("what")).toBe("It hangs in <workspace>.");
    expect(url.searchParams.get("phew")).toBe("1.1.3");
    expect(url.searchParams.get("logs")).toBe("## What happened\n\nIt hangs.");
  });

  test("a long report stays out of the address and asks to paste it", () => {
    const body = buildReport(
      facts({ log: Array.from({ length: 80 }, (_, index) => `10:00:${index} info ${"x".repeat(120)}`) }),
      "It hangs.",
      mac,
    );
    const link = issueUrl("LF3551/phew", "Bug: it hangs", fields, body);
    expect(link.complete).toBe(false);
    expect(link.url.length).toBeLessThan(7000);
    const url = new URL(link.url);
    expect(url.searchParams.get("logs")).toMatch(/paste it here/);
    expect(url.searchParams.get("phew")).toBe("1.1.3");
  });

  test("a very long description is shortened to fit", () => {
    const long = { ...fields, what: "word ".repeat(5000) };
    const link = issueUrl("LF3551/phew", "Bug", long, "x".repeat(10_000));
    expect(link.url.length).toBeLessThan(7000);
  });
});
