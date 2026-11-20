// Checks the built website in _site/ the way a search engine and a careful reviewer would: each page has a good
// title and description, one h1, a canonical URL, social tags, valid JSON-LD, working internal links and anchors,
// pictures with alt text and sizes, and a place in the sitemap. It fails with a list of what is wrong.
// Usage: node scripts/site.mjs && node scripts/site-check.mjs [--url https://lf3551.github.io/phew/]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const urlArgument = process.argv.indexOf("--url");
const rawUrl = urlArgument > 0 ? process.argv[urlArgument + 1] : "https://lf3551.github.io/phew/";
const site = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
const base = new URL(site).pathname;
const problems = [];
const fail = (page, text) => problems.push(`${page}: ${text}`);

const pages = [];
const walk = (folder) => {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".html")) pages.push(relative(out, path));
  }
};
walk(out);

const urlOf = (page) => `${site}${page.replace(/index\.html$/, "")}`;
const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const meta = (html, key) => {
  const tag = [...html.matchAll(/<meta\s[^>]*>/g)]
    .map((match) => match[0])
    .find((item) => {
      return attribute(item, "name") === key || attribute(item, "property") === key;
    });
  return tag ? attribute(tag, "content") : undefined;
};
const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

/** The file in _site for an internal address, or undefined for an outside one. */
function target(from, href) {
  if (/^(https?:|mailto:|vscode:|data:)/.test(href)) {
    if (!href.startsWith(site)) return undefined;
    href = base + href.slice(site.length);
  }
  const [pathPart, fragment] = href.split("#");
  const path = pathPart.split("?")[0];
  let file;
  if (path === "") file = from;
  else if (path.startsWith("/")) {
    if (!path.startsWith(base)) return { missing: true };
    file = path.slice(base.length);
  } else file = join(dirname(from), path);
  if (file === "" || file.endsWith("/")) file = `${file}index.html`;
  return { file, fragment };
}

const titles = new Map();
const descriptions = new Map();
const indexable = [];
let firstLoad = 0;

for (const page of pages) {
  const html = readFileSync(join(out, page), "utf8");
  const noindex = /<meta name="robots" content="noindex/.test(html);
  if (!noindex) indexable.push(urlOf(page));
  if (/\{\{\w+\}\}/.test(html)) fail(page, "a {{placeholder}} is left");
  if (!/<html lang="en">/.test(html)) fail(page, "no lang on <html>");

  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  if (!title) fail(page, "no title");
  if (!noindex && (title.length < 25 || title.length > 65))
    fail(page, `the title has ${title.length} characters, not 25 to 65`);
  if (!noindex) {
    if (titles.has(title)) fail(page, `the same title as ${titles.get(title)}`);
    titles.set(title, page);
  }
  const description = meta(html, "description") ?? "";
  if (!noindex && (description.length < 110 || description.length > 165))
    fail(page, `the description has ${description.length} characters, not 110 to 165`);
  if (!noindex) {
    if (descriptions.has(description)) fail(page, `the same description as ${descriptions.get(description)}`);
    descriptions.set(description, page);
  }

  const h1 = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1 !== 1) fail(page, `${h1} h1 headings instead of one`);
  if (!noindex) {
    const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];
    if (canonical !== urlOf(page)) fail(page, `the canonical URL is ${canonical}, not ${urlOf(page)}`);
    for (const key of ["og:title", "og:description", "og:image", "og:url", "og:site_name", "twitter:card"])
      if (!meta(html, key)) fail(page, `no ${key}`);
    if (meta(html, "og:url") !== urlOf(page)) fail(page, "og:url is not the URL of the page");
  }

  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(match[1]);
      if (!data["@context"] || !data["@type"]) fail(page, "JSON-LD without @context or @type");
    } catch (error) {
      fail(page, `JSON-LD does not parse: ${error.message}`);
    }
  }
  if (!noindex && !html.includes("application/ld+json")) fail(page, "no JSON-LD");

  // Links, anchors, scripts, styles, and pictures inside the site.
  const references = [
    ...[...html.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/\ssrc="([^"]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/\s(?:data-)?srcset="([^"]+)"/g)].flatMap((match) =>
      match[1].split(",").map((item) => item.trim().split(/\s+/)[0]),
    ),
    ...[...html.matchAll(/\sdata-image="([^"]+)"/g)].map((match) => match[1]),
  ];
  for (const href of references) {
    const found = target(page, href.replaceAll("&amp;", "&"));
    if (!found) continue;
    if (found.missing || !existsSync(join(out, found.file))) {
      fail(page, `the link ${href} goes nowhere`);
      continue;
    }
    if (found.fragment && found.file.endsWith(".html")) {
      const ids = idsOf(readFileSync(join(out, found.file), "utf8"));
      if (!ids.has(found.fragment)) fail(page, `the anchor #${found.fragment} does not exist in ${found.file}`);
    }
  }
  for (const match of html.matchAll(/<img\s[^>]*>/g)) {
    const tag = match[0];
    if (attribute(tag, "alt") === undefined) fail(page, `a picture without alt: ${tag.slice(0, 80)}`);
    if (!attribute(tag, "width") || !attribute(tag, "height"))
      fail(page, `a picture without its size: ${tag.slice(0, 80)}`);
  }

  if (page === "index.html") {
    const size = (file) => statSync(join(out, file)).size;
    firstLoad = size("index.html") + size("style.css") + size("main.js") + size("fonts/recursive.woff2");
  }
}

const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
for (const url of indexable) if (!listed.includes(url)) fail("sitemap.xml", `${url} is missing`);
for (const url of listed) if (!indexable.includes(url)) fail("sitemap.xml", `${url} is not an indexable page`);
if (!readFileSync(join(out, "robots.txt"), "utf8").includes(`Sitemap: ${site}sitemap.xml`))
  fail("robots.txt", "no Sitemap line");
if (firstLoad > 300_000) fail("index.html", `the first load is ${Math.round(firstLoad / 1024)} KB, over 300 KB`);

if (problems.length > 0) {
  console.error(`The website has ${problems.length} problems:\n${problems.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `The website is fine: ${pages.length} pages, ${indexable.length} in the sitemap, first load ${Math.round(firstLoad / 1024)} KB without pictures.`,
);
