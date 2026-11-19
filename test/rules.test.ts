import { expect, test } from "vitest";
import { matchesGlob, nestedRule, parseFrontMatter, ruleFrom, rulesForFile, rulesIndex } from "../src/core/rules";

test("reads YAML front matter: strings, quotes, booleans, inline and block lists", () => {
  const { data, body } = parseFrontMatter(
    '---\ndescription: \'Use for tests\'\nalwaysApply: false\nglobs: ["*.ts", src/**]\npaths:\n  - "src/api/**/*.ts"\n  - lib/**\n---\n# Body\n',
  );
  expect(data).toEqual({
    description: "Use for tests",
    alwaysApply: false,
    globs: ["*.ts", "src/**"],
    paths: ["src/api/**/*.ts", "lib/**"],
  });
  expect(body).toBe("# Body\n");
  expect(parseFrontMatter("# No front matter").data).toEqual({});
});

test("understands the rule formats of other agents", () => {
  // Copilot: applyTo; without it only when attached.
  expect(ruleFrom("a.instructions.md", "---\napplyTo: '**/*.py'\n---\nPython rules", "manual")).toMatchObject({
    mode: "scoped",
    globs: ["**/*.py"],
    body: "Python rules",
  });
  expect(ruleFrom("b.instructions.md", "---\napplyTo: '**'\n---\nx", "manual").mode).toBe("always");
  expect(ruleFrom("c.instructions.md", "---\ndescription: Database work\n---\nx", "manual").mode).toBe("described");
  expect(ruleFrom("d.instructions.md", "Plain text", "manual").mode).toBe("manual");
  // Claude: paths; without paths always.
  expect(ruleFrom(".claude/rules/api.md", "---\npaths:\n  - src/api/**\n---\nx").mode).toBe("scoped");
  expect(ruleFrom(".claude/rules/style.md", "Use tabs.").mode).toBe("always");
  // Cursor: alwaysApply, globs, description.
  expect(ruleFrom("x.mdc", "---\nalwaysApply: true\n---\nx").mode).toBe("always");
  expect(ruleFrom("x.mdc", '---\nglobs: "*.tsx, *.ts"\nalwaysApply: false\n---\nx')).toMatchObject({
    mode: "scoped",
    globs: ["*.tsx", "*.ts"],
  });
  expect(ruleFrom("x.mdc", "---\ndescription: Migrations\nalwaysApply: false\n---\nx").mode).toBe("described");
  expect(ruleFrom("x.mdc", "---\nalwaysApply: false\n---\nx").mode).toBe("manual");
  // Antigravity and Windsurf: trigger.
  expect(ruleFrom("r.md", "---\ntrigger: model_decision\ndescription: SQL\n---\nx").mode).toBe("described");
  expect(ruleFrom("r.md", '---\ntrigger: glob\nglobs: "*.py"\n---\nx').mode).toBe("scoped");
  expect(ruleFrom("r.md", "---\ntrigger: manual\n---\nx").mode).toBe("manual");
  expect(ruleFrom("r.md", "---\ntrigger: always_on\n---\nx").mode).toBe("always");
  // Kiro: inclusion and fileMatchPattern.
  expect(ruleFrom("k.md", '---\ninclusion: fileMatch\nfileMatchPattern: "components/**/*.tsx"\n---\nx').mode).toBe(
    "scoped",
  );
  expect(ruleFrom("k.md", "---\ninclusion: always\n---\nx").mode).toBe("always");
});

test("a nested AGENTS.md applies to its folder", () => {
  expect(nestedRule("packages/api/AGENTS.md", "API rules")).toMatchObject({
    mode: "scoped",
    globs: ["packages/api/**"],
  });
});

test("matches paths like the tools do", () => {
  expect(matchesGlob("**/*.ts", "src/a/b.ts")).toBe(true);
  expect(matchesGlob("**/*.ts", "b.ts")).toBe(true);
  expect(matchesGlob("*.ts", "src/deep/file.ts")).toBe(true);
  expect(matchesGlob("*.ts", "src/deep/file.tsx")).toBe(false);
  expect(matchesGlob("src/api/**/*.ts", "src/api/v1/users.ts")).toBe(true);
  expect(matchesGlob("src/api/**/*.ts", "src/web/users.ts")).toBe(false);
  expect(matchesGlob("src/*.ts", "src/a/b.ts")).toBe(false);
  expect(matchesGlob("**/*.{ts,tsx}", "ui/App.tsx")).toBe(true);
  expect(matchesGlob("src/api/", "src/api/x/y.go")).toBe(true);
  expect(matchesGlob("./docs/**", "docs/a.md")).toBe(true);
  expect(matchesGlob("test_?.py", "tests/test_a.py")).toBe(true);
});

test("a scoped rule comes once per task with the first matching file", () => {
  const rules = [
    ruleFrom("api.md", "---\npaths:\n  - src/api/**\n---\nValidate input."),
    nestedRule("web/AGENTS.md", "Use React."),
    ruleFrom("always.md", "Be nice."),
  ];
  const delivered = new Set<string>();
  expect(rulesForFile(rules, "src/api/users.ts", delivered)).toBe(
    "Rules from api.md apply to src/api/users.ts. Follow them:\nValidate input.",
  );
  expect(rulesForFile(rules, "src/api/orders.ts", delivered)).toBeUndefined();
  expect(rulesForFile(rules, "web/App.tsx", delivered)).toContain("Use React.");
  expect(rulesForFile(rules, "README.md", new Set())).toBeUndefined();
});

test("the system prompt lists rules for some files and rules to read by description", () => {
  const index = rulesIndex([
    ruleFrom("api.md", "---\npaths:\n  - src/api/**\n---\nx"),
    ruleFrom("db.mdc", "---\ndescription: Database migrations\nalwaysApply: false\n---\nx"),
    ruleFrom("always.md", "x"),
    ruleFrom("m.mdc", "---\nalwaysApply: false\n---\nx"),
  ]);
  expect(index).toContain("- api.md: src/api/**");
  expect(index).toContain("- db.mdc: Database migrations");
  expect(index).not.toContain("always.md");
  expect(index).not.toContain("m.mdc");
});
