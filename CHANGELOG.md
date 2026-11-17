# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added in the latest update

- Your own assistant: name it, pick a look (the Phew drop, an emoji, or initials), a character (Partner, Mentor, Quiet, Strict reviewer, or your own), how it calls you, and the language of its answers. A short introduction card opens on the first run.
- A living mascot: the drop sweats while the agent works, sighs with relief when the task is done, and worries when it fails. It respects reduced motion.
- A soft "phew" sound, and the choice to play sounds always or only when the chat is hidden.
- Phew Wrapped: a weekly or monthly card with bugs fixed, time saved, tasks, and the streak. Save it as an image or copy the text. Eight local achievements with a small notice when you earn one.
- An optional `Assisted-by: Phew` commit trailer. It is off by default.
- The side bar no longer shows the same buttons twice.

- Chat appearance: Bubbles, Classic, and Compact styles, accent and bubble colors, font, text size, line height, code size, times, message actions, and avatars, with quick settings behind the **Aa** button and an Appearance section in the settings.
- Interrupt: `Esc` stops the agent, and `Ctrl+Enter` (`Cmd+Enter` on macOS) stops the current step and sends the new message at once.
- Message actions as icons on hover.

- GitHub Copilot with a GitHub token (`github_pat_…`): Phew finds the plan (Individual, Business, or Enterprise), lists the chat models, and can use the token of the Pi coding agent.
- OpenAI Responses API client. Models that support only `/responses`, such as newer GPT models through GitHub Copilot, use it automatically.

- A cleaner composer: one rounded input with a toolbar for the mode, attachments, auto-approve settings, the context, the model, and a round send button; line icons instead of emoji; approvals and attachments in small menus.

- A visual model setup in **Phew: Open Settings → Models**: provider cards that show missing keys, keys found in the environment, and running local servers; one form for the key, the URL, the model list, and a connection test; and model cards with Use, Test, Change key, More, and Remove.

- Message queue: messages written while the agent works reach it at its next step. `/btw` side questions, `/goal`, and `/compact`.
- Reasoning display for OpenAI-compatible, Anthropic (signed thinking is sent back for tool use), and Gemini models.
- Context meter with automatic and manual compaction, and a context window per model profile, loaded from the provider when available.
- Automatic retries after HTTP 429, overload, server, and network errors, with `Retry-After` and rate limit headers, and clear messages for a missing quota.
- Clickable `file:line` references, chat rename, message times, and Copy for answers.
- Agent Skills (`SKILL.md`) from Phew, Agents, Claude Code, and OpenCode folders, with the `load_skill` and `read_skill_file` tools.
- Multi-root workspaces.
- MCP from `.vscode/mcp.json` and `.mcp.json`, Streamable HTTP servers with OAuth (discovery, dynamic client registration, PKCE), `${input:...}` values in the secret storage, tool selection per server, enable and disable, restart, and an MCP log.
- `ask_user` questions with clickable answers and an `update_plan` checklist in the chat.
- Notifications and an optional sound when a chat finishes or needs input, chat font size, the send key setting, and approval settings per chat.
- Parallel chats in editor tabs, with a warning before two running chats change the same file.

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

### Added in this update

- Chat history per workspace with search, several chats at the same time, restore after a restart, and Markdown export.
- `@` mentions for files, problems, Git changes, and terminal output; images by paste, drop, or file picker; **Add to Chat** in the editor, explorer, and terminal.
- Approval toggles in the chat for edits, commands, and MCP tools.
- Review in the editor with Keep and Undo per change, Keep All and Undo All, and a review banner.
- Commit messages in the Source Control view, **Commit with Phew**, and commit settings for style, language, sign-off, GPG or SSH signing, author, trailers, and model, with a clear view of the identity that commits use.
- Debug and Review modes, custom modes in the settings and in `.phew/modes.json`, and a model per mode.
- Project memory in `.phew/memory.md` with the `remember` tool.
- Inline autocomplete and **Suggest Next Edit**.
- Local code index with `search_code` and optional embeddings.
- Agents in Git worktrees with diff, merge, open, and remove actions.
- A getting started walkthrough and a settings page.
- Prompt history with the arrow keys and Copy buttons on code blocks.

### Changed

- Model profiles: several models, quick switch, a guided setup that loads the model list and tests the connection, API keys in the secret storage or from environment variables, and custom auth, headers, query parameters, and request fields.
- Native Anthropic Messages and Google Gemini clients, VS Code language models such as GitHub Copilot, and presets for Azure OpenAI, Mistral, xAI, DeepSeek, Groq, Cerebras, Together AI, Fireworks AI, OpenRouter, LiteLLM, Ollama, LM Studio, and vLLM.
- Fix tasks remind the model to apply the change with the tools when it only shows code.

- TypeScript 7 and GitHub Actions `checkout` and `setup-node` v7.
- Dependabot keeps `@types/vscode` aligned with the minimum VS Code version and `@types/node` on the VS Code Node.js major version.
