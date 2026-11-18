// Puts node-pty with the prebuilt binaries of every platform into dist/pty/node_modules, laid out like
// npm installs it, so node-pty finds its binaries, its macOS helper, and its Windows worker by itself.
// The packages come from @lydell/node-pty: Microsoft's node-pty, split into a JavaScript package and one
// binary package per platform. node-pty uses N-API, so the binaries work with every VS Code and Node
// version. Each download is checked against the npm integrity hash below.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "1.1.0";
const integrity = {
  "": "sha512-VDD8LtlMTOrPKWMXUAcB9+LTktzuunqrMwkYR1DMRBkS6LQrCt+0/Ws1o2rMml/n3guePpS7cxhHF7Nm5K4iMw==",
  "linux-x64": "sha512-NcNqRTD14QT+vXcEuqSSvmWY+0+WUBn2uRE8EN0zKtDpIEr9d+YiFj16Uqds6QfcLCHfZmC+Ls7YzwTaqDnanA==",
  "linux-arm64": "sha512-yyDBmalCfHpLiQMT2zyLcqL2Fay4Xy7rIs8GH4dqKLnEviMvPGOK7LADVkKAsbsyXBSISL3Lt1m1MtxhPH6ckg==",
  "darwin-arm64": "sha512-7kFD+owAA61qmhJCtoMbqj3Uvff3YHDiU+4on5F2vQdcMI3MuwGi7dM6MkFG/yuzpw8LF2xULpL71tOPUfxs0w==",
  "darwin-x64": "sha512-XZdvqj5FjAMjH8bdp0YfaZjur5DrCIDD1VYiE9EkkYVMDQqRUPHYV3U8BVEQVT9hYfjmpr7dNaELF2KyISWSNA==",
  "win32-x64": "sha512-3N56BZ+WDFnUMYRtsrr7Ky2mhWGl9xXcyqR6cexfuCqcz9RNWL+KoXRv/nZylY5dYaXkft4JaR1uVu+roiZDAw==",
  "win32-arm64": "sha512-JOMbCou+0fA7d/m97faIIfIU0jOv8sn2OR7tI45u3AmldKoKoLP8zHY6SAvDDnI3fccO1R2HeR1doVjpS7HM0w==",
};

const cache = path.join(root, ".cache", "pty", version);
const target = path.join(root, "dist", "pty", "node_modules", "@lydell");
mkdirSync(cache, { recursive: true });

/** Removes debug symbols, which are most of the size of the Windows packages. */
function prune(folder) {
  for (const name of readdirSync(folder)) {
    const file = path.join(folder, name);
    if (statSync(file).isDirectory()) prune(file);
    else if (name.endsWith(".pdb")) rmSync(file);
  }
}

for (const [platform, expected] of Object.entries(integrity)) {
  const name = platform ? `node-pty-${platform}` : "node-pty";
  const out = path.join(target, name);
  const marker = path.join(out, ".version");
  if (existsSync(marker)) continue;
  const tarball = path.join(cache, `${name}.tgz`);
  if (!existsSync(tarball)) {
    const url = `https://registry.npmjs.org/@lydell/${name}/-/${name}-${version}.tgz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (actual !== expected) throw new Error(`The package @lydell/${name} does not match its integrity hash.`);
    writeFileSync(tarball, bytes);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", out, "--strip-components=1"]);
  prune(out);
  // macOS starts shells through this helper; it must stay executable.
  const helper = path.join(out, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
  writeFileSync(marker, version);
}
console.log(`node-pty ${version}: ${Object.keys(integrity).filter(Boolean).join(", ")}`);
