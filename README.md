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
- **Fixes until green.** Phew runs your check command, for example `npm test`, and keeps fixing until it passes.
- **Review in the editor.** Each change has **Keep** and **Undo** buttons in the file, and **Keep All** and **Undo All** in the editor title. Prefer to approve first? Switch **Edits** to **Ask first** in the chat.
- **Undo anything.** Each request is a checkpoint. **Restore checkpoint** reverts all file changes made after it, even after a restart.
- **Chat history.** Chats are saved per workspace. Search them, open them again, run several at the same time, and export them as Markdown.
- **Rich context.** Type `@` to attach files, `@problems`, `@git`, or `@terminal`. Paste or drop screenshots. Use **Add to Chat** in the editor, the explorer, and the terminal.
- **Parallel agents.** **New Agent in Worktree** works on a new branch in a separate folder while you keep coding.
- **Commits your way.** Generate commit messages in the Source Control view. See the author and signing that commits use, and set Conventional Commits, `Signed-off-by`, GPG or SSH signing, a different author, and trailers. Phew never adds co-authors by itself.
- **Code index and memory.** Phew finds relevant code by meaning and remembers durable project facts in `.phew/memory.md`.
- **Autocomplete and Next Edit.** Inline completions and a predicted next edit, with any model.
- **Modes.** Ask, Plan, Code, Debug, Review, and your own modes.
- **Safe by default.** Phew does not read `.env` files and keys, removes secrets from tool output, and always asks before dangerous commands such as `git push --force`, `terraform apply`, or `kubectl delete`.
- **Any model.** GitHub Copilot without a key, OpenAI, Anthropic, Google Gemini, Azure OpenAI, Mistral, xAI, DeepSeek, Groq, Cerebras, Together AI, Fireworks AI, OpenRouter, LiteLLM, and local models with Ollama, LM Studio, or vLLM.
- **Know the cost.** Tokens and cost per task, with optional budget limits.
- **Open source.** Apache 2.0, no telemetry.

## Get started

1. Open the **Phew** view in the activity bar, or press `Ctrl+Alt+P` (`Cmd+Alt+P` on macOS).
2. Choose **Choose a model**. Phew loads the model list of the provider and tests the connection.
3. Ask a question or describe a change. Type `@` to attach context.
4. Optional: set **Checks → Verify command**, for example `npm test`, in **Phew: Open Settings**.

**Phew: Get Started** opens a short guide.

## Modes

| Mode | What Phew does |
| --- | --- |
| **Ask** | Answers questions. Changes nothing. |
| **Plan** | Explores the code and writes a plan. Changes nothing. |
| **Code** | Edits files and runs commands with your approval. |
| **Debug** | Reproduces the problem, finds the root cause, and fixes it. |
| **Review** | Reviews the current changes. Changes nothing. |
| Custom | Your own instructions, tools, and model, from the settings or `.phew/modes.json`. |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+P` | Open the chat |
| `Ctrl+Alt+L` | Add the selection or the file to the chat |
| `Ctrl+Alt+.` | Phew it! Fix the problem at the cursor |
| `Alt+]` | Suggest the next edit |
| `Ctrl+Alt+Y` / `Ctrl+Alt+Z` | Keep or undo all changes in the file |
| `↑` in the input | Reuse an earlier request |

On macOS, use `Cmd` instead of `Ctrl`.

## Settings

**Phew: Open Settings** opens a settings page with sections for models, the agent, approvals, checks, budget, commits, worktrees, the code index, autocomplete, memory and modes, MCP, privacy, and the interface.
Every setting is also available in the VS Code settings under **Phew**.

## Security and privacy

- Phew sends your prompts, the files that the agent reads, and tool output to the model provider that you choose.
  Use a local model if your code must not leave your computer.
- In Restricted Mode, Phew only answers questions.
  It does not change files, run commands, start MCP servers, or read project rules, memory, or modes.
- Model profiles come only from the user settings, so a workspace cannot send your API keys to another server.
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
