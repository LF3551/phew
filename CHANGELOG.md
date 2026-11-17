# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] - 2026-11-17

The first public preview of Phew.

### Handoff

- Handoff notes: a session journal in `.phew/sessions/` (facts only, secrets removed, never committed) and a note in `.phew/handoff/` with the goal, decisions, dead ends, next steps, plan, changed files, commands, and how to verify. Notes are written after tasks that change files, when a chat is compacted, before a worktree is removed, and with `/handoff`. The format is open: see `docs/HANDOFF.md`.
- `/continue`, a **Continue** card on the welcome screen, and **Continue from Handoff Note…**: a new chat starts from a note and learns what changed in the code since then (other branch, new commits, changed files).
- With your consent, a section in `AGENTS.md` (and in `CLAUDE.md` and `GEMINI.md` when they exist) points other agents to the latest note.
- Slash command menu: type `/` in the chat.
- One-click releases in GitHub Actions with trusted publishing (OIDC) to the Visual Studio Marketplace and Open VSX.

### Agent

- Chat with Ask, Plan, Code, Debug, and Review modes, custom modes in the settings and in `.phew/modes.json`, and a model per mode.
- File, search, problem, edit, and command tools, `ask_user` questions with clickable answers, and an `update_plan` checklist.
- **Phew it!** on any problem in the editor, a fix for failed terminal commands, and **Make Checks Pass**: a check loop that runs your command and keeps fixing until it passes.
- Message queue, **Stop and send** with `Ctrl+Enter` (`Cmd+Enter` on macOS), `Esc` to stop, `/btw` side questions, `/goal`, and `/compact`.
- Context meter with automatic and manual compaction, and reasoning display for OpenAI-compatible, Anthropic, and Gemini models.
- Automatic retries after HTTP 429, overload, server, and network errors, with `Retry-After` and clear messages for a missing quota.
- Project rules from `AGENTS.md`, `.phew/rules/`, and the rule files of other agents; project memory in `.phew/memory.md`; Agent Skills (`SKILL.md`).
- Local code index with `search_code` and optional embeddings, inline autocomplete, and **Suggest Next Edit**.
- Agents in Git worktrees, parallel chats in editor tabs, and multi-root workspaces.

### Models

- Model profiles with a visual setup: provider cards, keys in the secret storage or from environment variables, the model list from the provider, and a connection test.
- OpenAI-compatible, OpenAI Responses API, Anthropic Messages, and Google Gemini clients, VS Code language models, and presets for Azure OpenAI, Mistral, xAI, DeepSeek, Groq, Cerebras, Together AI, Fireworks AI, OpenRouter, LiteLLM, Ollama, LM Studio, and vLLM.
- GitHub Copilot with a GitHub token: Phew finds the plan (Individual, Business, or Enterprise) and lists the chat models.

### Safety and review

- Review in the editor with Keep and Undo per change, checkpoints that restore all file changes, and Markdown export.
- Approval settings per chat for edits, commands, and MCP tools; dangerous command detection; auto-approve and deny lists; sensitive file protection; and secret redaction.
- Token and cost display with budget limits.
- Commit messages in the Source Control view and **Commit with Phew**, with settings for style, language, sign-off, GPG or SSH signing, author, and trailers. Phew never adds co-authors. An optional `Assisted-by: Phew` trailer is off by default.

### Context and tools

- `@` mentions for files, problems, Git changes, and terminal output; images by paste, drop, or file picker; **Add to Chat** in the editor, explorer, and terminal.
- MCP over stdio and Streamable HTTP with OAuth (discovery, dynamic client registration, PKCE), servers from `.vscode/mcp.json` and `.mcp.json`, tool selection per server, and an MCP log.

### Make it yours

- Your own assistant: a name, a look (the Phew drop, an emoji, or initials), a character (Partner, Mentor, Quiet, Strict reviewer, or your own words), how it calls you, and the language of its answers, with an introduction card on the first run.
- A living mascot that sweats while the agent works, sighs with relief when the task is done, and worries when it fails. It respects reduced motion.
- Chat appearance: Bubbles, Classic, and Compact styles, accent and bubble colors, font, text size, line height, code size, times, message actions, and avatars, with quick settings behind **Aa**.
- Notifications and a soft "phew" sound when a chat finishes or needs input.
- Phew Wrapped: a weekly or monthly card with bugs fixed, time saved, tasks, and the streak, which you can save as an image, and eight local achievements.
- A getting started walkthrough and a settings page.

[Unreleased]: https://github.com/LF3551/phew/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/LF3551/phew/releases/tag/v0.1.3
