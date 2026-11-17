# Repository guidance

These rules apply to human contributors and to AI coding agents.

## Project

- Phew is an open-source VS Code extension that integrates the [Pi](https://pi.dev) coding agent.
- Phew is an independent project and must not claim to be an official Pi or Microsoft product.
- Write all new code from scratch.
  Do not copy code from other extensions unless the license allows it and the copyright notice is kept.

## Language

- Write code, comments, commit messages, and documentation in English.
- Use short, simple sentences and put each prose sentence on a separate source line.
- Do not describe planned features as available.
  Mark them as planned until they are released.

## Commits

- Use Conventional Commits, for example `feat:`, `fix:`, `docs:`, `test:`, and `chore:`.
- Sign off each commit with `git commit -s`.
- Update `CHANGELOG.md` under `Unreleased` for each user-visible change.

## Security

- Read `SECURITY.md` before you change process, trust, context, or edit workflows.
- Do not apply file changes without a visible diff and an explicit user action, except in a mode that the user turns on.
- Send prompts and context to Pi through stdin, not through process arguments.
- Do not add telemetry.
- Keep webview assets local, keep a strict Content Security Policy, and sanitize rendered content.
- Do not commit secrets, tokens, or personal data.

## Boundaries

- Ask the maintainer before you publish a release, change Marketplace data, or use a live model for validation.
- Do not edit generated files such as `out/`, `dist/`, or `*.vsix`.
