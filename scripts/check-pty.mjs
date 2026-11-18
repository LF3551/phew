// Checks that the bundled node-pty starts a real shell on this system and reads its output.
// CI runs it on Linux, Windows, and macOS after the build.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "dist", "pty", "loader.js"));
const pty = require("@lydell/node-pty");

const windows = process.platform === "win32";
const shell = windows ? "powershell.exe" : process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
const args = windows ? ["-NoLogo", "-NoProfile"] : ["-i"];
const term = pty.spawn(shell, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: root, env: process.env });
let output = "";
term.onData((data) => {
  output += data;
});
const marker = `phew-pty-${17 * 3}`;
setTimeout(() => term.write(windows ? "Write-Output ('phew-pty-' + (17*3))\r" : "echo phew-pty-$((17*3))\r"), 1500);
const deadline = Date.now() + 20_000;
const timer = setInterval(() => {
  if (output.includes(marker)) {
    clearInterval(timer);
    term.kill();
    console.log(`node-pty works on ${process.platform}-${process.arch} with ${shell}`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    clearInterval(timer);
    term.kill();
    console.error(`node-pty did not answer on ${process.platform}-${process.arch}. Output:\n${output}`);
    process.exit(1);
  }
}, 200);
