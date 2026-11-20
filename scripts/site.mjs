// Builds the website for GitHub Pages into _site/: the home page, the guides, the 404 page, robots.txt, and
// sitemap.xml, with the head of each page (title, description, canonical, Open Graph, and JSON-LD) made here.
// The pictures are WebP files in site/images (scripts/site-images.py); the version comes from package.json.
// Usage: node scripts/site.mjs [--url https://lf3551.github.io/phew/]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "site");
const out = join(root, "_site");
const urlArgument = process.argv.indexOf("--url");
const rawUrl = urlArgument > 0 ? process.argv[urlArgument + 1] : "https://lf3551.github.io/phew/";
const site = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
const base = new URL(site).pathname;
const today = new Date().toISOString().slice(0, 10);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const engine = pkg.engines.vscode.replace(/^[^\d]*/, "").replace(/\.0$/, "");
const marketplace = "https://marketplace.visualstudio.com/items?itemName=alekseialeinikov.phew";
const openVsx = "https://open-vsx.org/extension/alekseialeinikov/phew";
const github = "https://github.com/LF3551/phew";
const author = {
  "@type": "Person",
  name: "Aleksei Aleinikov",
  url: "https://www.alekseialeinikov.com",
  sameAs: ["https://github.com/LF3551", "https://www.linkedin.com/in/a-aleinikov", "https://x.com/Aleksei_gr1"],
};

const escapeHtml = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const read = (path) => readFileSync(join(source, path), "utf8");
const fill = (text, values) => text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? values[key] : match));

/** The guides: an HTML comment with JSON on top of each file, then the article. */
const guides = readdirSync(join(source, "guides"))
  .filter((file) => file.endsWith(".html"))
  .map((file) => {
    const text = read(`guides/${file}`);
    const match = /^<!--([\s\S]*?)-->\s*/.exec(text);
    if (!match) throw new Error(`guides/${file} needs its JSON comment on top.`);
    const meta = JSON.parse(match[1]);
    return { ...meta, slug: file.replace(/\.html$/, ""), body: text.slice(match[0].length) };
  })
  .sort((a, b) => a.order - b.order);

function head(page) {
  const url = `${site}${page.path}`;
  const image = `${site}social-preview.png`;
  const data = page.data.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`);
  return [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}">`,
    `<meta name="author" content="Aleksei Aleinikov">`,
    // Ownership for Google Search Console and Bing Webmaster Tools, from repository variables.
    page.path === "" && process.env.GOOGLE_SITE_VERIFICATION
      ? `<meta name="google-site-verification" content="${escapeHtml(process.env.GOOGLE_SITE_VERIFICATION)}">`
      : "",
    page.path === "" && process.env.BING_SITE_VERIFICATION
      ? `<meta name="msvalidate.01" content="${escapeHtml(process.env.BING_SITE_VERIFICATION)}">`
      : "",
    `<meta name="robots" content="${page.robots ?? "index, follow, max-image-preview:large"}">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="#1e2127" media="(prefers-color-scheme: dark)">`,
    page.robots ? "" : `<link rel="canonical" href="${url}">`,
    `<link rel="icon" href="${base}icon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="${base}icon-512.png">`,
    `<link rel="sitemap" type="application/xml" href="${base}sitemap.xml">`,
    `<meta property="og:type" content="${page.type === "article" ? "article" : "website"}">`,
    `<meta property="og:site_name" content="Phew">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta property="og:title" content="${escapeHtml(page.socialTitle ?? page.title)}">`,
    `<meta property="og:description" content="${escapeHtml(page.description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="1280">`,
    `<meta property="og:image:height" content="640">`,
    `<meta property="og:image:alt" content="Phew, the open-source AI coding agent for VS Code">`,
    page.updated ? `<meta property="article:modified_time" content="${page.updated}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:site" content="@Aleksei_gr1">`,
    `<meta name="twitter:title" content="${escapeHtml(page.socialTitle ?? page.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    `<link rel="preload" href="${base}fonts/recursive.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="${base}style.css">`,
    page.script ? `<script src="${base}main.js" defer></script>` : "",
    ...data,
  ]
    .filter(Boolean)
    .map((line) => `  ${line}`)
    .join("\n");
}

function render(page, body) {
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    head(page),
    "</head>",
    `<body class="${page.bodyClass ?? ""}">`,
    fill(read("partials/header.html"), { base }),
    body,
    fill(read("partials/footer.html"), { base, year: today.slice(0, 4) }),
    "</body>",
    "</html>",
    "",
  ].join("\n");
  const filled = fill(html, { version: pkg.version, engine, base, url: site, marketplace, openVsx, github });
  const left = filled.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`Unknown placeholder in ${page.path || "index"}: ${left[0]}`);
  const target = join(out, page.path, page.path.endsWith(".html") ? "" : "index.html");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, filled);
}

const breadcrumbs = (items) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, path], index) => ({
    "@type": "ListItem",
    position: index + 1,
    name,
    item: `${site}${path}`,
  })),
});

/** The questions of the home page for Google, from the same HTML that people read. */
function faqData(html) {
  const plain = (text) =>
    text
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\{\{engine\}\}/g, engine)
      .replace(/\s+/g, " ")
      .trim();
  const questions = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)].map((match) => ({
    "@type": "Question",
    name: plain(match[1]),
    acceptedAnswer: { "@type": "Answer", text: plain(match[2]) },
  }));
  if (questions.length < 3) throw new Error("The questions of the home page are missing.");
  return { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: questions };
}

function guideCards(list) {
  return list
    .map(
      (guide) =>
        `<li><a href="${base}guides/${guide.slug}/"><strong>${escapeHtml(guide.h1)}</strong><span>${escapeHtml(guide.summary)}</span></a></li>`,
    )
    .join("\n          ");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of ["fonts", "images", "main.js", "style.css"])
  cpSync(join(source, item), join(out, item), { recursive: true });
for (const file of ["icon.svg", "icon-512.png", "social-preview.png"])
  cpSync(join(root, "resources", file), join(out, file));

// The home page.
const home = fill(read("index.html"), { guides: guideCards(guides) });
render(
  {
    path: "",
    title: "Phew: free, open-source AI coding agent for VS Code",
    socialTitle: "Phew: bug fixed. Phew.",
    description:
      "A free, open-source AI coding agent for VS Code. Use any model: Copilot, your own API key, or Ollama. Fix bugs in one click and review every change.",
    script: true,
    data: [
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "Phew",
        alternateName: "Phew AI coding agent",
        description:
          "An open-source AI coding agent for VS Code that fixes errors in one click, runs your tests, shows every change for review, and works with any model.",
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "AI coding agent",
        operatingSystem: "Windows, macOS, Linux",
        softwareVersion: pkg.version,
        softwareRequirements: `Visual Studio Code ${engine} or newer`,
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        downloadUrl: marketplace,
        installUrl: marketplace,
        url: site,
        image: `${site}icon-512.png`,
        screenshot: `${site}images/bug-fixed-1600.webp`,
        codeRepository: github,
        author,
        sameAs: [marketplace, openVsx, github],
      },
      { "@context": "https://schema.org", "@type": "WebSite", name: "Phew", url: site },
      faqData(home),
    ],
  },
  home,
);

// The guides and their list.
for (const guide of guides) {
  const others = guides.filter((other) => other.slug !== guide.slug);
  const body = fill(read("partials/guide.html"), {
    h1: escapeHtml(guide.h1),
    lead: guide.lead,
    updated: guide.updated,
    updatedText: new Date(`${guide.updated}T12:00:00Z`).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    minutes: String(Math.max(2, Math.round(guide.body.replace(/<[^>]+>/g, " ").split(/\s+/).length / 220))),
    article: guide.body,
    related: guideCards(others.slice(0, 3)),
  });
  render(
    {
      path: `guides/${guide.slug}/`,
      title: guide.title,
      description: guide.description,
      type: "article",
      updated: guide.updated,
      data: [
        {
          "@context": "https://schema.org",
          "@type": guide.steps ? "HowTo" : "TechArticle",
          ...(guide.steps
            ? { name: guide.h1, step: guide.steps.map((step) => ({ "@type": "HowToStep", name: step })) }
            : { headline: guide.h1 }),
          description: guide.description,
          ...(guide.steps ? {} : { author, dateModified: guide.updated, image: `${site}social-preview.png` }),
          mainEntityOfPage: `${site}guides/${guide.slug}/`,
        },
        breadcrumbs([
          ["Phew", ""],
          ["Guides", "guides/"],
          [guide.h1, `guides/${guide.slug}/`],
        ]),
      ],
    },
    body,
  );
}
render(
  {
    path: "guides/",
    title: "Guides: AI coding agent in VS Code with Phew",
    description:
      "Practical guides for Phew: start for free, run a local model, use your own API key, run agents in parallel, fix failing tests, and keep the agent safe.",
    data: [
      breadcrumbs([
        ["Phew", ""],
        ["Guides", "guides/"],
      ]),
    ],
  },
  fill(read("partials/guides.html"), { guides: guideCards(guides) }),
);

// The page for a wrong address, not for search engines.
render(
  {
    path: "404.html",
    title: "Page not found · Phew",
    description: "This page does not exist.",
    robots: "noindex",
    data: [],
  },
  fill(read("partials/404.html"), { guides: guideCards(guides.slice(0, 4)) }),
);

// Search engines: what to crawl, and every page with its date.
const pages = [
  ["", today, "1.0"],
  ["guides/", today, "0.8"],
  ...guides.map((guide) => [`guides/${guide.slug}/`, guide.updated, "0.7"]),
];
writeFileSync(
  join(out, "sitemap.xml"),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map(
      ([path, date, priority]) =>
        `  <url><loc>${site}${path}</loc><lastmod>${date}</lastmod><priority>${priority}</priority></url>`,
    ),
    "</urlset>",
    "",
  ].join("\n"),
);
// GitHub Pages serves robots.txt only at the root of a domain; under a project path it is a hint for checks.
writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`);
if (!base.startsWith("/phew")) writeFileSync(join(out, "CNAME"), `${new URL(site).host}\n`);
// GitHub Pages must serve the files as they are.
writeFileSync(join(out, ".nojekyll"), "");

if (!existsSync(join(out, "images/bug-fixed-1600.webp"))) throw new Error("The pictures are missing.");
console.log(`Built _site for Phew ${pkg.version} (${site}): ${pages.length} pages.`);
