<p align="center">
  <img src="resources/icon.png" alt="Phew logo: two relieved closed eyes and a sweat drop" width="128" height="128">
</p>

<h1 align="center">Phew</h1>

<p align="center">
  <strong>Bug fixed. Phew.</strong><br>
  An open-source AI coding agent for VS Code that fixes errors in one click, shows every change, and works with any model.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-orange.svg">
</p>

> [!NOTE]
> Phew is in preview.
> There is no Marketplace release yet.
> To try it, build it from source (see [Development](#development)).

## Why Phew

- **Phew it!** One click on an error in the editor, a failed terminal command, or failing tests. Phew finds the cause, fixes it, and checks the result.
- **Fixes until green.** Phew runs your check command, for example `npm test`, and keeps fixing until it passes or reaches the attempt limit.
- **You stay in control.** Every file change shows as hunks. Apply only the hunks that you want, or open the native diff editor.
- **Undo anything.** Each request is a checkpoint. **Restore checkpoint** reverts all file changes made after it.
- **Safe by default.** Phew does not read `.env` files and keys, removes secrets from tool output, and always asks before dangerous commands such as `git push --force`, `terraform apply`, or `kubectl delete`.
- **Any model.** OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, DeepSeek, or local models with Ollama and LM Studio. Your API key stays in the VS Code secret storage.
- **Know the cost.** Tokens and cost per task, with optional budget limits.
- **Your rules.** Phew reads `AGENTS.md`, `.phew/rules/`, and the rule files of other agents, such as `.cursorrules`, `.clinerules`, `CLAUDE.md`, and `.github/copilot-instructions.md`.
- **MCP.** Connect databases, APIs, and cloud tools with Model Context Protocol servers.
- **Open source.** Apache 2.0, no telemetry.

## Modes

| Mode | What Phew does |
| --- | --- |
| **Ask** | Answers questions about your code. Reads files and changes nothing. |
| **Plan** | Explores the code and writes an implementation plan. Changes nothing. |
| **Code** | Edits files and runs commands with your approval. |

## Get started

1. Open the **Phew** view in the activity bar, or press `Ctrl+Alt+P` (`Cmd+Alt+P` on macOS).
2. Choose **Choose a model**, select a provider, enter the model name, and enter your API key.
   Local providers need no key.
3. Ask a question or describe a change.
4. Optional: set `phew.verify.command`, for example `npm test`, to let Phew check its own work.

## Commands

| Command | Description |
| --- | --- |
| `Phew: Open Chat` | Open the chat view. |
| `Phew: New Chat` | Start a new conversation. |
| `Phew: Phew it! Fix Problem at Cursor` | Fix the error or warning at the cursor. Also available as a quick fix on every problem (`Ctrl+Alt+.`). |
| `Phew: Phew it! Fix All Errors in File` | Fix all errors in the active file. |
| `Phew: Phew it! Fix Last Failed Terminal Command` | Fix the cause of the last failed command in the integrated terminal. |
| `Phew: Make Checks Pass` | Run the check command and fix the failures. |
| `Phew: Ask About Selection` | Ask a question about the selected code. |
| `Phew: Switch Mode (Ask, Plan, Code)` | Change the mode. |
| `Phew: Configure Model` | Choose the provider, the model, and the API key. |
| `Phew: Remove Saved API Key` | Delete the API key of the current provider. |
| `Phew: Show Statistics` | Show bugs fixed, estimated time saved, tokens, and cost. |
| `Phew: Stop` | Stop the current task. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `phew.model.baseUrl` | empty | OpenAI-compatible API base URL. |
| `phew.model.name` | empty | Model name. |
| `phew.agent.defaultMode` | `code` | Mode for new workspaces. |
| `phew.agent.maxSteps` | `40` | Maximum model calls per task. |
| `phew.edits.requireApproval` | `true` | Review every change as hunks before Phew applies it. |
| `phew.commands.autoApprove` | `[]` | Command prefixes that run without a confirmation, for example `npm test`. |
| `phew.commands.deny` | `[]` | Command prefixes that never run. |
| `phew.verify.command` | empty | Check command that Phew runs after changes. |
| `phew.verify.maxAttempts` | `3` | Check attempts per task. |
| `phew.budget.maxCostPerTask` | `0` | Cost limit per task in US dollars. `0` means no limit. |
| `phew.budget.maxTokensPerTask` | `0` | Token limit per task. `0` means no limit. |
| `phew.budget.pricing` | `{}` | Price per million tokens by model, for the cost display. |
| `phew.privacy.redactSecrets` | `true` | Remove secrets from tool output before it goes to the model. |
| `phew.mcp.servers` | `{}` | MCP servers to start over stdio. |
| `phew.terminal.offerFix` | `true` | Offer **Phew it!** when a terminal command fails. |
| `phew.ui.celebrate` | `true` | Show the **Phew! Done.** animation. |

## Security and privacy

- Phew sends your prompts, the files that the agent reads, and tool output to the model provider that you choose.
  Use a local model if your code must not leave your computer.
- In Restricted Mode, Phew only answers questions.
  It does not change files, run commands, start MCP servers, or read project rules.
- Every tool call is written to the **Phew** output channel (`Phew: Show Log`).
- Phew collects no telemetry. Statistics stay on your computer.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

Requirements: Node.js 22 or newer.

```sh
npm ci
npm run check            # type check, lint, and unit tests
npm run build            # build dist/ with esbuild
npm run test:integration # run the extension in VS Code with a fake model server
npm run package          # create phew.vsix
```

Press `F5` in VS Code to start an Extension Development Host.
The architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Contributions are welcome.
Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

## License

Phew is licensed under the [Apache License 2.0](LICENSE).
Copyright 2026 [Aleksei Aleinikov](https://www.alekseialeinikov.com).

If you redistribute Phew or a work based on it, you must keep the [LICENSE](LICENSE) and [NOTICE](NOTICE) files, which credit the author.
"Phew" and the Phew logo are trademarks of Aleksei Aleinikov; see [TRADEMARKS.md](TRADEMARKS.md).
"Visual Studio Code" is a trademark of Microsoft Corporation.
