# Repository guidance

These rules apply to human contributors and to AI coding agents.

## Project

- Phew is an open-source AI coding agent for VS Code by Aleksei Aleinikov, licensed under Apache 2.0.
- The extension ID is `alekseialeinikov.phew`.
  Commands, settings, views, and context keys use the `phew.` prefix.
- Read `docs/ARCHITECTURE.md` before you change the structure.
- Do not copy code from other projects.
  Add a third-party dependency only when its license is compatible with Apache 2.0, and list it in `NOTICE` when its license requires it.

## Code

- TypeScript 5.9, strict mode, bundled with esbuild.
- Keep `src/core` free of the `vscode` module so that it stays unit-testable.
- Keep browser code in `src/webview` and shared message types in `src/shared`.
- Validate every message from the webview and every tool argument from the model.
- Follow `biome.json`: two-space indentation, 120-column lines, double quotes, and semicolons.
- Use stable VS Code APIs that the minimum version in `package.json` supports.

## Commands

- `npm ci` installs the locked dependencies.
- `npm run check` runs the type check, the linter, and the unit tests. Run it before each commit.
- `npm run test:integration` runs the extension in VS Code. On headless Linux, start a display server first, for example `Xvfb :99 &` and `DISPLAY=:99`.
- `npm run package` creates `phew.vsix`.
- `npm run ui:audit` checks the chat in three themes and three widths (it needs Playwright: `PLAYWRIGHT=/path/to/playwright`). Run it for changes in `src/webview` or `media`.

## Tests

- Add unit tests in `test/*.test.ts` for every change in `src/core`, `src/providers`, and `src/shared`.
- Add integration checks in `test/integration/suite.cjs` for new commands and workflows.
- Do not claim checks that were not run.

## Security

- Keep every file change of the agent reviewable: Keep and Undo in the editor, or Ask first (`phew.review.mode`), and a checkpoint for each request.
- Always ask before dangerous commands, even when a prefix is auto-approved; a chain runs without asking only when every part of it only reads (`phew.commands.approval`).
- Never read sensitive files, and redact secrets from tool output.
- Do not add telemetry.
- Keep the webview Content Security Policy strict, keep assets local, and never render model output as HTML.
- Do not commit secrets, tokens, or personal data.

## Language and commits

- Write code, comments, commit messages, and documentation in English.
- Use short, simple sentences, one sentence per line in Markdown.
- Use Conventional Commits and sign off each commit with `git commit -s`.
- Update `CHANGELOG.md` under `Unreleased` for each user-visible change.
- Ask the maintainer before you publish a release or change Marketplace data.
