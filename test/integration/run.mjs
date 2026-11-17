import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = mkdtempSync(path.join(tmpdir(), "phew-it-"));
mkdirSync(path.join(workspace, ".vscode"));
writeFileSync(path.join(workspace, "math.js"), "exports.add = (a, b) => a - b;\n");
writeFileSync(
  path.join(workspace, "check.js"),
  'const { add } = require("./math");\nif (add(2, 3) !== 5) { console.error("add(2, 3) should be 5"); process.exit(1); }\nconsole.log("ok");\n',
);
writeFileSync(
  path.join(workspace, ".vscode", "settings.json"),
  JSON.stringify({ "phew.verify.command": "node check.js", "phew.edits.requireApproval": false }, null, 2),
);

await runTests({
  version: process.env.VSCODE_VERSION ?? "stable",
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "test/integration/suite.cjs"),
  launchArgs: [
    workspace,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    // Containers often have no user namespaces and a small /dev/shm.
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] : []),
  ],
});
