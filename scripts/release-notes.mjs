// Prints the CHANGELOG section of one version, for the GitHub release notes.
// Usage: node scripts/release-notes.mjs 0.1.2
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const escaped = version.replaceAll(".", "\\.");
const match = new RegExp(
  `^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]: |(?![\\s\\S]))`,
  "m",
).exec(changelog);
if (!match?.[1].trim()) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
process.stdout.write(`${match[1].trim()}\n`);
