# Architecture

Phew has three layers.
Each layer depends only on the layers below it.

```mermaid
flowchart TD
  UI["src/webview: chat view (browser)"] -- messages --> Host
  Host["src/host: VS Code integration"] --> Core
  Host --> Providers["src/providers: model clients"]
  Providers --> Core["src/core: pure logic"]
```

## `src/core`

Pure TypeScript without the `vscode` module, so unit tests run in Node.js.

| File | Purpose |
| --- | --- |
| `agent.ts` | The agent loop: model call, tool calls, step and budget limits, the check loop that fixes until green, and reminders to apply fixes. |
| `attachments.ts` | Attachments, `@` mentions, and the context format. |
| `codeIndex.ts` | BM25 code index with identifier-aware tokens and optional embeddings. |
| `commit.ts` | Commit message prompts, trailers, identity, signing, and flags for agent commits. |
| `completion.ts` | Inline completion and next edit prompts and parsing. |
| `export.ts` | Markdown export and chat titles. |
| `review.ts` | Keep and undo of single hunks for the review in the editor. |
| `worktree.ts` | Branch names, worktree folders, and `git worktree list` parsing. |
| `compaction.ts` | Context estimates and the summary of older messages. |
| `journal.ts`, `handoff.ts` | The session journal (facts) and handoff notes: the request to the model, rendering, freshness checks, and the `AGENTS.md` section. See [HANDOFF.md](HANDOFF.md). |
| `persona.ts`, `achievements.ts`, `appearance.ts` | The assistant persona, local achievements and Wrapped, and the chat appearance. |
| `skills.ts` | `SKILL.md` parsing and the skills prompt. |
| `plan.ts` | The checklist and the questions of the agent. |
| `roots.ts` | Paths across the folders of a multi-root workspace. |
| `mcpConfig.ts`, `mcpHttp.ts`, `oauth.ts` | MCP configuration files and variables, the Streamable HTTP transport, and OAuth with PKCE. |
| `chat.ts` | Message types, argument parsing, and history trimming. |
| `tools.ts` | Tool definitions in JSON Schema and the tools of each mode. |
| `modes.ts` | Built-in and custom modes and their tool groups. |
| `prompts.ts` | The system prompt and the requests of the "Phew it!" workflows. |
| `diff.ts` | Line diff (Myers algorithm), hunks, and partial apply. |
| `checkpoints.ts` | Original file content per request and restore planning. |
| `commandPolicy.ts` | Dangerous command detection and auto-approve and deny lists. |
| `secrets.ts` | Sensitive file detection and secret redaction. |
| `cost.ts` | Token and cost tracking and budget limits, with a new price after a switch to a fallback model. |
| `fallback.ts` | Failure kinds of providers, the fallback chain of a model, and the client that moves to the fallback when the quota ends or a rate limit lasts. |
| `chatStatus.ts` | The state of a chat in the list (needs input, model quiet, on a fallback, running, failed, done) and when a model counts as quiet. |
| `modelChoice.ts` | Which model answers in a chat: the model of the mode, of the chat, or the default. |
| `rules.ts` | Rules: the files and folders of Phew and other agents, their front matter (`applyTo`, `paths`, `globs`, `alwaysApply`, `trigger`, `inclusion`), path patterns, and how each rule reaches the agent (always, with a matching file, by description, or only when attached). |
| `projectBrief.ts` | The project overview for the start of each chat (stack, commands, layout, README, branch) and the request of `/init`. |
| `memory.ts` | Memory notes with their source and day, personal and project scope, corrections, the memory part of the prompt, and the request of `/learn`. |
| `mcp.ts` | Minimal Model Context Protocol client over newline-delimited JSON-RPC. |
| `sse.ts` | Server-Sent Events parser for streamed model responses. |
| `stats.ts` | Local statistics. |
| `rating.ts` | When to ask for a rating (a task that went well, a regular user, rarely), the store of the editor, and the answers. |
| `whatsNew.ts` | The "New in Phew" card after an update to a new minor version. |
| `setupOptions.ts` | The options of the first-run card: ready, free to start, and private. |
| `modelLabels.ts` | Model names without repeats, context sizes, and the maker badge of a model. |
| `paths.ts` | Workspace path containment. |

## `src/providers`

`openaiCompatible.ts` streams chat completions with tool calls from any OpenAI-compatible API.
`presets.ts` lists common providers and validates base URLs.
`keyCommand.ts` gets short-lived keys from a command (`apiKeyCommand`): it parses a plain key or JSON with an expiry, keeps the key until shortly before it expires, and wraps `fetch` so that each request carries the current key and a 401 renews it once. The host runs the command in `host/keyCommandRunner.ts`.

## `src/host`

| File | Purpose |
| --- | --- |
| `sessionManager.ts` | All chats of the window, the views that show them, the saved history, file claims between parallel chats, notifications, and worktree agents. |
| `chatView.ts` | One controller per webview: the side bar follows the active chat, and editor tabs show one pinned chat each. |
| `skillStore.ts` | Finds and reads Agent Skills. |
| `session.ts` | One conversation: the queue, `/btw`, compaction, reasoning, approvals of the chat, the plan, the transcript, checkpoints, and persistence. |
| `conversationStore.ts` | Saved chats in the workspace storage. |
| `reviewManager.ts` | Keep and Undo CodeLens and decorations in the editor. |
| `codeIndexManager.ts` | Builds, updates, saves, and searches the code index. |
| `commitAssistant.ts`, `git.ts` | Commit messages, commits, Git identity, and Git commands without a shell. |
| `completions.ts` | Inline completions and next edit prediction. |
| `memoryStore.ts`, `attachments.ts` | Project memory and attachment resolution with the `@` menu. |
| `handoffs.ts` | Writes journals and notes in `.phew/`, keeps `.phew/.gitignore`, reads Git state and file fingerprints, and asks before it changes `AGENTS.md`. |
| `models.ts`, `vscodeLmClient.ts` | Model profiles, setup, tests, the default model, and VS Code language models. |
| `fileLock.ts` | One writer at a time for shared files such as the memory: a queue in the window and a lock directory between windows. |
| `settingsPanel.ts` | The settings page, generated from the configuration schema. |
| `toolHost.ts` | Executes tools inside the workspace with path, secret, trust, and command checks. |
| `changes.ts` | Shows changes as hunks, applies the selected hunks, records checkpoints, and serves the diff editor. |
| `approvals.ts` | Sends approval requests to the view and waits for the decision. |
| `commandRunner.ts` | Runs shell commands with a timeout, an output limit, and cancellation. Keeps the folder and the exported variables of a chat between commands, and passes typed input to the command. |
| `shellSession.ts`, `shellScripts.ts` | The terminal of a chat: a real PTY (node-pty) with the user's shell, shown in the panel. The agent types its commands into it. Small startup scripts print invisible marks (`core/shellMarks.ts`) when a command starts and at each prompt, with the exit code and the folder. A quiet program with a prompt waits for input, and the next command types into it (ssh, a REPL). node-pty comes prebuilt for six platforms in `dist/pty` (`scripts/vendor-pty.mjs`). |
| `shellRegistry.ts` | The terminals of a chat: terminal 1 by default, a new one for a server, never a command into a terminal that hosts a server; the list for the chat; closing a terminal ends its whole process tree. |
| `agentTerminal.ts` | The fallback when node-pty does not load: commands run in processes, and a pseudoterminal mirrors their output. |
| `mcpManager.ts` | Reads MCP configurations, connects stdio and HTTP servers, signs in with OAuth, filters tools, and logs. |
| `phewIt.ts` | The "Phew it!" quick fix on problems. |
| `terminalWatcher.ts` | Remembers failed terminal commands through shell integration. |
| `chatView.ts` | The webview view provider and the transcript that rebuilds a hidden view. |
| `providerSetup.ts` | Provider, model, and API key setup. The key goes to SecretStorage. |
| `rulesLoader.ts`, `settings.ts`, `statsStore.ts`, `html.ts` | Rules (personal from `~/.phew`, project rules only in trusted workspaces, nested `AGENTS.md` files), settings, statistics, and the webview document. Scoped rules come with the result of `read_file`, `edit_file`, and `write_file` through `ToolHost`, once per task. |
| `projectBrief.ts`, `memoryStore.ts` | The project overview, cached for a minute (no README in untrusted workspaces), and the memory files with the check of their sources. |

## `src/webview`

The chat view runs in a sandboxed webview with a strict Content Security Policy and a script nonce.
`markdown.ts` builds DOM nodes from a safe Markdown subset and never parses HTML.
`src/shared/protocol.ts` defines the messages between the view and the host, and the host validates every message.
`terminalBlock.ts` shows each command in a terminal inside the chat (xterm.js): the same live output as the terminal in the panel, the mascot, the result, links to files, search, Your turn, and Phew it!. Keys go straight to the real shell; in the fallback without node-pty they go through `core/lineEditor.ts`. `terminalsPanel.ts` lists the terminals of the chat.
`core/outputLimit.ts` keeps huge output bounded for the model and the chat; `core/commandPolicy.ts` decides which commands run without asking.
xterm.js adds `<style>` elements; they get the nonce of the page, so the policy needs no `unsafe-inline`.
The menus under the input are separate modules: `modeMenu.ts`, `modelMenu.ts`, `attachMenu.ts`, and `approvalsPanel.ts`.
A command that arrives finished (a chat that opens again) shows its output as text without a terminal, so long chats open fast; only commands that run get xterm. Short results fold into one line.
`chatFind.ts` is Ctrl+F in the chat: matches use the CSS Custom Highlight API, so the text never changes. `setupCard.ts` is the first-run card (its options come from `core/setupOptions.ts`).
Retry of a quiet model request: `core/agent.ts` runs each request with its own abort controller and gives the host a retry function (`requestControl`); the chat drops the unfinished text with `assistantDiscard`.
Fork and Edit find a message in the history by its `checkpointId`: `AgentSession.before()` returns the history and the transcript before it.

## Tests

- `test/*.test.ts`: unit tests with Vitest.
- `test/integration`: starts VS Code with the extension and a fake model server, in a multi-root workspace, and goes through the main flows: fix and check, review, commit message, checkpoint, questions, skills, MCP over HTTP, plan, queue, `/btw`, parallel chats, approvals, "Phew it!", handoff notes, the summary card, fork and edit, the rating card, Retry of a quiet request, key commands, the project overview, rules for some files, memory, and `@` an earlier chat.
- `scripts/ui-audit.mjs` (`npm run ui:audit`): renders the chat in 26 states, 3 themes, and 3 widths, and checks console errors, overflow, accessible names, overlapping controls, and contrast.
- `scripts/readme-images.mjs` (`npm run images`): renders the pictures of the README from the real chat.
