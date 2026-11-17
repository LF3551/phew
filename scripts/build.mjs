import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions[]} */
const builds = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    entryPoints: ["src/webview/settings.ts"],
    outfile: "dist/settings.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
  {
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

const contexts = await Promise.all(
  builds.map((options) =>
    esbuild.context({
      ...options,
      minify: production,
      sourcemap: !production,
      sourcesContent: false,
      legalComments: "none",
      logLevel: "info",
    }),
  ),
);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
