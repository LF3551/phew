# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Chat view with Ask, Plan, and Code modes.
- Agent with file, search, problem, edit, and command tools for any OpenAI-compatible model, including local models.
- "Phew it!" quick fix on problems, a fix for failed terminal commands, and **Make Checks Pass**.
- Check loop that runs a configurable command and keeps fixing until it passes.
- Review of every change as hunks, partial apply, and the native diff editor.
- Checkpoints that restore all file changes after a request.
- Dangerous command detection, auto-approve and deny lists, sensitive file protection, and secret redaction.
- Token and cost display with budget limits.
- Project rules from `AGENTS.md`, `.phew/rules/`, and the rule files of other agents.
- MCP servers over stdio.
- Local statistics and the **Phew! Done.** animation.

### Changed

- Model profiles: several models, quick switch, a guided setup that loads the model list and tests the connection, API keys in the secret storage or from environment variables, and custom auth, headers, query parameters, and request fields.
- Native Anthropic Messages and Google Gemini clients, VS Code language models such as GitHub Copilot, and presets for Azure OpenAI, Mistral, xAI, DeepSeek, Groq, Cerebras, Together AI, Fireworks AI, OpenRouter, LiteLLM, Ollama, LM Studio, and vLLM.
- Fix tasks remind the model to apply the change with the tools when it only shows code.

- TypeScript 7 and GitHub Actions `checkout` and `setup-node` v7.
- Dependabot keeps `@types/vscode` aligned with the minimum VS Code version and `@types/node` on the VS Code Node.js major version.
