// Moves the Unreleased section of CHANGELOG.md to a new version and updates the links.
// Usage: node scripts/release-changelog.mjs <version> [YYYY-MM-DD]
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/release-changelog.mjs <version> [YYYY-MM-DD]");
  process.exit(2);
}
const file = new URL("../CHANGELOG.md", import.meta.url);
const changelog = readFileSync(file, "utf8");
const repository = "https://github.com/LF3551/phew";

if (changelog.includes(`## [${version}]`)) {
  console.error(`CHANGELOG.md already has a section for ${version}.`);
  process.exit(1);
}
const unreleased = /^## \[Unreleased\]\n([\s\S]*?)(?=^## \[|^\[[^\]]+\]: |(?![\s\S]))/m.exec(changelog);
if (!unreleased?.[1].trim()) {
  console.error("The Unreleased section of CHANGELOG.md is empty. Add the changes first.");
  process.exit(1);
}
const previous = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(changelog.slice(unreleased.index + unreleased[0].length))?.[1];

let next = changelog.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${date}\n`);
next = next.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repository}/compare/v${version}...HEAD`);
if (!/^\[Unreleased\]: /m.test(next))
  next = `${next.trimEnd()}\n\n[Unreleased]: ${repository}/compare/v${version}...HEAD\n`;
const link = previous
  ? `[${version}]: ${repository}/compare/v${previous}...v${version}`
  : `[${version}]: ${repository}/releases/tag/v${version}`;
next = next.replace(/^(\[Unreleased\]: .*)$/m, `$1\n${link}`);
writeFileSync(file, next);
console.log(`CHANGELOG.md: ${version} - ${date}`);
