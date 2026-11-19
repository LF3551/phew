import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = mkdtempSync(path.join(tmpdir(), "phew-it-"));
const main = path.join(base, "main");
const second = path.join(base, "second");
mkdirSync(path.join(main, ".vscode"), { recursive: true });
mkdirSync(path.join(main, ".claude", "skills", "greeting"), { recursive: true });
mkdirSync(second);
writeFileSync(path.join(main, "math.js"), "exports.add = (a, b) => a - b;\n");
// For the project brief: the scripts and the README that the agent sees at the start of each chat.
writeFileSync(
  path.join(main, "package.json"),
  JSON.stringify({ name: "it", private: true, scripts: { test: "node check.js" } }, null, 2),
);
// Project memory: a fact about math.js, saved long before the file was written, so the agent checks it.
mkdirSync(path.join(main, ".phew"), { recursive: true });
writeFileSync(
  path.join(main, ".phew", "memory.md"),
  "# Phew project memory\n\n- add() lives in math.js <!-- source: math.js; added: 2000-01-01 -->\n- Run node check.js to test\n",
);
// Rules for some files: a Copilot instructions file for math.js, a nested AGENTS.md, and a Cursor rule by description.
mkdirSync(path.join(main, ".github", "instructions"), { recursive: true });
writeFileSync(
  path.join(main, ".github", "instructions", "math.instructions.md"),
  "---\napplyTo: '**/math.js'\n---\nMATH-RULE: keep add pure.\n",
);
mkdirSync(path.join(main, "lib"), { recursive: true });
writeFileSync(path.join(main, "lib", "AGENTS.md"), "LIB-RULE: lib code has no side effects.\n");
mkdirSync(path.join(main, ".cursor", "rules"), { recursive: true });
writeFileSync(
  path.join(main, ".cursor", "rules", "release.mdc"),
  "---\ndescription: Release checklist\nalwaysApply: false\n---\nRELEASE-RULE\n",
);
writeFileSync(path.join(main, "README.md"), "# Integration workspace\n\nA tiny project where Phew fixes math.js.\n");
writeFileSync(
  path.join(main, "check.js"),
  'const { add } = require("./math");\nif (add(2, 3) !== 5) { console.error("add(2, 3) should be 5"); process.exit(1); }\nconsole.log("ok");\n',
);
writeFileSync(
  path.join(main, ".claude", "skills", "greeting", "SKILL.md"),
  "---\nname: greeting\ndescription: Greets the user in the project style.\n---\nSay HELLO-FROM-SKILL.\n",
);
writeFileSync(path.join(second, "README.md"), "# Second folder\n");
writeFileSync(
  path.join(main, ".vscode", "settings.json"),
  JSON.stringify({ "phew.verify.command": "node check.js", "phew.commit.signOff": true }, null, 2),
);
const git = (...args) => execFileSync("git", args, { cwd: main });
git("init", "-q", "-b", "main");
git("config", "user.name", "Test User");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
git("add", "-A");
git("commit", "-q", "-m", "initial");
const workspaceFile = path.join(base, "phew.code-workspace");
writeFileSync(
  workspaceFile,
  JSON.stringify({
    folders: [{ path: "main" }, { path: "second" }],
    settings: { "phew.verify.command": "node check.js", "phew.commit.signOff": true },
  }),
);

await runTests({
  version: process.env.VSCODE_VERSION ?? "stable",
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "test/integration/suite.cjs"),
  launchArgs: [
    workspaceFile,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    // Containers often have no user namespaces and a small /dev/shm.
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] : []),
  ],
});
