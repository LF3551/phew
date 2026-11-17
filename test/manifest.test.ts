import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const sources = readdirSync("src", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => readFileSync(`${entry.parentPath}/${entry.name}`, "utf8"))
  .join("\n");

test("the extension identity is Phew", () => {
  expect(`${manifest.publisher}.${manifest.name}`).toBe("alekseialeinikov.phew");
  expect(manifest.license).toBe("Apache-2.0");
  expect(manifest.main).toBe("./dist/extension.js");
});

test("every contributed command is registered and every registered command is contributed", () => {
  const contributed = manifest.contributes.commands.map((command: { command: string }) => command.command).sort();
  const registered = [...sources.matchAll(/registerCommand\(\s*"(phew\.[A-Za-z]+)"/g)].map((match) => match[1]);
  registered.push("phew.fixProblem");
  expect([...new Set(registered)].sort()).toEqual(contributed);
  for (const command of manifest.contributes.commands) expect(command.category).toBe("Phew");
});

test("every setting is read in the code", () => {
  const settings = readFileSync("src/host/settings.ts", "utf8");
  for (const key of Object.keys(manifest.contributes.configuration.properties)) {
    expect(key).toMatch(/^phew\./);
    expect(settings, key).toContain(`"${key.slice("phew.".length)}"`);
  }
});

test("packaged files exist", () => {
  for (const path of [
    "resources/icon.png",
    "resources/phew.svg",
    "resources/phew-dark.svg",
    "media/chat.css",
    "LICENSE",
  ]) {
    expect(existsSync(path), path).toBe(true);
  }
});

test("the VS Code API types match the minimum VS Code version", () => {
  const minimum = String(manifest.engines.vscode).replace(/^\^/, "");
  expect(manifest.devDependencies["@types/vscode"]).toBe(minimum);
});
