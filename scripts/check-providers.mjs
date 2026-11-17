// Checks that every cloud preset reaches the real provider API with the right path and auth style.
// It sends requests with an invalid key, so a correct setup gets an authentication error, not 404.
// Usage: node scripts/check-providers.mjs [preset-id ...]
import * as esbuild from "esbuild";

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { providerPresets } from "./src/providers/presets";
      export { createHttpClient, listModels } from "./src/providers/factory";
      export { parseProfile } from "./src/providers/profile";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const module = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const only = new Set(process.argv.slice(2));
const presets = module.providerPresets.filter(
  (preset) =>
    preset.group !== "Local" &&
    preset.provider !== "vscode" &&
    !preset.askBaseUrl &&
    (only.size === 0 || only.has(preset.id)),
);

function classify(message) {
  if (/Blocked by|network policy|Approval required/i.test(message)) return "BLOCKED (sandbox network policy)";
  if (/HTTP 404/.test(message) && /model/i.test(message)) return "OK (reached the API, example model unknown)";
  if (/HTTP 404/.test(message)) return "WRONG PATH (404)";
  if (/HTTP (400|401|403)/.test(message)) return "OK (reached the API, key rejected)";
  if (/Cannot reach/.test(message)) return "UNREACHABLE";
  return "CHECK";
}

const rows = [];
for (const preset of presets) {
  const profile = module.parseProfile({
    id: preset.id,
    name: preset.label,
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    model: preset.modelHint || "test",
    auth: preset.auth,
    headers: preset.headers,
  });
  const key = "phew-invalid-test-key-0000000000000000";
  const results = {};
  for (const [name, run] of [
    ["models", () => module.listModels(profile, key, fetch, AbortSignal.timeout(20_000))],
    [
      "chat",
      () =>
        module
          .createHttpClient(profile, key)
          .complete(
            { messages: [{ role: "user", content: "hi" }], tools: [], signal: AbortSignal.timeout(20_000) },
            () => {},
          ),
    ],
  ]) {
    try {
      await run();
      results[name] = { status: name === "models" ? "OK (public model list)" : "UNEXPECTED SUCCESS", message: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results[name] = { status: classify(message), message };
    }
  }
  rows.push({ preset: preset.id, ...results });
  console.log(`\n${preset.label} (${preset.provider}, ${preset.baseUrl})`);
  for (const [name, result] of Object.entries(results))
    console.log(`  ${name.padEnd(6)} ${result.status}\n         ${result.message.slice(0, 220)}`);
}
const bad = rows.filter((row) => [row.models, row.chat].some((item) => /WRONG PATH|UNEXPECTED/.test(item.status)));
process.exitCode = bad.length > 0 ? 1 : 0;
