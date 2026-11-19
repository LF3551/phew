// Builds the website for GitHub Pages into _site/: the pages from site/, the pictures from
// docs/images, and the logo from resources. The version comes from package.json.
// Usage: node scripts/site.mjs [--url https://lf3551.github.io/phew/]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const urlArgument = process.argv.indexOf("--url");
const url = urlArgument > 0 ? process.argv[urlArgument + 1] : "https://lf3551.github.io/phew/";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const engine = pkg.engines.vscode.replace(/^[^\d]*/, "").replace(/\.0$/, "");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "site"), out, { recursive: true });
cpSync(join(root, "docs/images"), join(out, "images"), { recursive: true });
for (const file of ["icon.svg", "icon-512.png", "social-preview.png"]) {
  cpSync(join(root, "resources", file), join(out, file));
}

const page = join(out, "index.html");
const html = readFileSync(page, "utf8")
  .replaceAll("{{version}}", pkg.version)
  .replaceAll("{{engine}}", engine)
  .replaceAll("{{url}}", url.endsWith("/") ? url : `${url}/`);
const left = html.match(/\{\{\w+\}\}/);
if (left) throw new Error(`Unknown placeholder in site/index.html: ${left[0]}`);
writeFileSync(page, html);
// GitHub Pages must serve the files as they are.
writeFileSync(join(out, ".nojekyll"), "");

if (!existsSync(join(out, "images/bug-fixed.png"))) throw new Error("The pictures are missing.");
console.log(`Built _site for Phew ${pkg.version} (${url}).`);
