import { expect, test } from "vitest";
import { buildProjectBrief, initRequest } from "../src/core/projectBrief";

const dir = (name: string) => ({ name, directory: true });
const file = (name: string) => ({ name, directory: false });

test("a Node project: stack, package manager, the scripts that matter, and the layout", () => {
  const brief = buildProjectBrief({
    entries: [
      dir("src"),
      dir("test"),
      dir("node_modules"),
      dir(".github"),
      file("package.json"),
      file("pnpm-lock.yaml"),
      file("tsconfig.json"),
      file("README.md"),
      file("AGENTS.md"),
    ],
    files: {
      "package.json": JSON.stringify({
        scripts: { build: "tsc", test: "vitest run", lint: "biome check .", postinstall: "x" },
      }),
      "README.md":
        "# Acme API\n\n[![ci](x)](y)\n\nAcme API serves orders and payments for the shop. It runs on Node.\n",
    },
    branch: "feature/login",
  });
  expect(brief).toContain("About: Acme API: Acme API serves orders and payments for the shop.");
  expect(brief).toContain("Stack: TypeScript (Node.js, pnpm)");
  expect(brief).toContain("`pnpm test` → vitest run");
  expect(brief).toContain("`pnpm lint` → biome check .");
  expect(brief).toContain("`pnpm build` → tsc");
  expect(brief).not.toContain("postinstall");
  expect(brief).toContain("src/ (source code)");
  expect(brief).toContain("test/ (tests)");
  expect(brief).not.toContain("node_modules");
  expect(brief).toContain(".github/ (CI and GitHub settings)");
  expect(brief).toContain("Read for more: AGENTS.md");
  expect(brief).toContain("Git branch: feature/login");
});

test("npm runs test without run, other scripts with run", () => {
  const brief = buildProjectBrief({
    entries: [file("package.json"), file("package-lock.json")],
    files: { "package.json": JSON.stringify({ scripts: { test: "jest", check: "tsc --noEmit" } }) },
  });
  expect(brief).toContain("`npm run check` → tsc --noEmit");
  expect(brief).toContain("`npm test` → jest");
  expect(brief.indexOf("npm run check")).toBeLessThan(brief.indexOf("npm test"));
});

test("Python, Go, Rust, and Make projects", () => {
  expect(
    buildProjectBrief({
      entries: [file("pyproject.toml"), dir("tests"), file("uv.lock")],
      files: { "pyproject.toml": "[project]\nname='x'\n[tool.ruff]\n[tool.pytest.ini_options]\n" },
    }),
  ).toMatch(/Python \(uv\)[\s\S]*`pytest` → tests; `ruff check \.` → lint/);
  expect(buildProjectBrief({ entries: [file("go.mod"), dir("cmd"), dir("internal")], files: {} })).toMatch(
    /Stack: Go[\s\S]*go test \.\/\.\.\.[\s\S]*cmd\/ \(Go entry points\)/,
  );
  expect(buildProjectBrief({ entries: [file("Cargo.toml")], files: {} })).toContain("`cargo test` → tests");
  expect(
    buildProjectBrief({
      entries: [file("Makefile")],
      files: { Makefile: ".PHONY: test\ntest:\n\tgo test\nbuild: deps\n\tgo build\nVAR := 1\n" },
    }),
  ).toContain("`make test`; `make build`");
});

test("an empty or unknown folder gives no brief", () => {
  expect(buildProjectBrief({ entries: [], files: {} })).toBe("");
  expect(buildProjectBrief({ entries: [file("notes.txt")], files: {} })).toBe("");
});

test("/init asks for a short AGENTS.md from facts, and keeps the handoff block of an existing file", () => {
  expect(initRequest(false)).toContain("Write an AGENTS.md");
  expect(initRequest(false)).not.toContain("phew:handoff");
  expect(initRequest(true)).toContain("Improve the AGENTS.md");
  expect(initRequest(true)).toContain("<!-- phew:handoff:begin -->");
  expect(initRequest(true)).toContain("Do not invent rules");
});
