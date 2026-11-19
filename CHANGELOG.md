# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Project overview at the start of every chat.** Phew gathers the stack, the package manager, the commands that matter (check, test, lint, build) from `package.json`, `Makefile`, `pyproject.toml`, Go, Rust, Java, .NET, and C/C++ projects, the main folders with their purpose, the first sentence of the README, and the Git branch. The agent starts with this instead of exploring first. In an untrusted workspace the README is left out.
- **Rules that fit the file.** Rules for some files reach the agent with the file: when it reads or changes a matching file, the rule comes with the tool result, once per task. Phew understands `applyTo` (Copilot `.github/instructions/*.instructions.md`), `paths` (Claude `.claude/rules`), `globs`, `alwaysApply`, and `description` (Cursor `.cursor/rules/*.mdc`), `trigger` (Antigravity `.agents/rules`, Windsurf `.windsurf/rules`), and `inclusion` (Kiro `.kiro/steering`). An `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` in a subfolder applies to that folder. Rules with only a description are listed, and the agent reads them when the task fits. Your personal rules for all projects live in `~/.phew/AGENTS.md` and `~/.phew/rules/`.
- **Memory that stays true.** Project facts in `.phew/memory.md` now keep the file they come from and the day they were saved; when that file changed later, the agent sees "check it". Your personal preferences live in `~/.phew/memory.md` and apply in every project. The agent can correct a note (`remember` with `replaces`) and remove one (`forget`), and saving a known fact again confirms it. Settings show both memories.
- **`/learn`**: the agent looks back at the chat for your corrections, preferences, and hard-won facts, proposes up to five lessons with their place (project memory, personal memory, or AGENTS.md), and saves only the ones you choose.
- **`@` an earlier chat**: type `@` and pick a chat (the recent ones, or the ones whose title matches). The agent gets what was asked, answered, and changed there, so you do not have to explain it again.
- **All unfinished work**: a new chat tells the agent about up to three unfinished handoff notes of other sessions, not only the latest one.
- **`/init`** writes or improves `AGENTS.md` from what the project shows: commands, layout, conventions, testing, and gotchas. You review the file in the editor and keep or undo it; the handoff block of an existing file stays.

## [0.5.0] - 2026-11-19

### Added

- **Long pastes become a chip**: a pasted text of more than 30 lines or 3000 characters waits as "Pasted text · 120 lines" instead of filling the input. A click shows it to read or change, or puts it into the message.
- **Find in the chat** with Ctrl+F (Cmd+F on macOS): matches are highlighted, Enter and Shift+Enter move between them, and a match in a folded command or a closed group opens it. The output of a live terminal keeps its own Ctrl+F.
- **Search the messages of all chats**: the search of the chat list also finds chats by what you and the assistant wrote, and shows the words around the match.
- **Fork from here** on your messages: a new chat with the conversation before the message and the message in the input, to try another way; the original chat stays as it is.
- **Edit and resend** now really goes back: after you agree, the later messages go away and the files that changed after the message are restored, and the message waits in the input. Before, Edit only copied the text.
- **Changes to review, above the input**: how many files, the lines added and removed, **Review**, **Undo all**, and **Keep all**. A click opens the list with **Keep** and **Undo** for each file; a click on a name opens the file.
- **New in Phew**: after an update to a new minor version, the chat shows a short card with what changed and a link to all changes. A fresh install shows nothing.
- **Signed build provenance** for each release: `gh attestation verify phew-x.y.z.vsix --repo LF3551/phew` proves that this repository built the file. SECURITY.md explains how to check that you have the real Phew.
- **Retry when the model goes quiet.** When no answer comes for 30 seconds while no command runs and no question waits, the status line says so and offers **Retry**: Phew sends the same request again, removes the unfinished text, and the task goes on. **Stop** still ends the task.
- **A calmer chat.** A command reads as plain words ("Print current working directory") with its state on the right ("Failed · exit 1 · 2.3 s"), not "Ran Print…". A short result folds into one line with the output next to it (`→ /home/agent`). After a command ends, the mascot settles into a check or a cross, so only the running command moves. A long output shows its end with **Show all N lines** instead of a scroll inside the scroll.
- **The badge of the model shows its maker**: a Claude model through GitHub Copilot shows the Anthropic badge, with "via GitHub Copilot" in its tooltip.
- **Clock** in **Aa** and `phew.appearance.clock`: message times follow the language of VS Code, or always 24 or 12 hours.
- **A first-run card in the chat.** Until a model is connected, the chat shows what is ready on this computer (GitHub Copilot in VS Code, a key in the environment, a running Ollama or LM Studio), what is free to start (the free Copilot plan, a free Google AI Studio key, free OpenRouter models), and the private option, with honest limits. A click opens the setup with that provider selected. Nothing is downloaded or connected by itself.
- **GitHub Copilot with a token: choose the plan.** Phew still finds Individual, Business, or Enterprise by itself, and the setup now also lets you pick the plan or type another address, for GitHub Enterprise on GHE.com or a proxy.
- **Keys from a command** for short-lived tokens: Google Vertex AI (`gcloud auth print-access-token`), Azure with Microsoft Entra ID, and company sign-in. Phew keeps the token in memory, renews it before it expires and after a 401, and never logs it. Only the user settings can set the command.
- A website at <https://lf3551.github.io/phew/>: the task from the error to the green tests, the features with pictures, how to start, the providers, privacy, and answers to common questions.
- Phew is on Open VSX, for VSCodium and other editors that use it.

### Changed

- Phew installs in VS Code 1.95 and newer (it needed 1.100), so it also runs in editors that are based on an older VS Code. The integration tests pass in VS Code 1.95.
- Better search words in the Marketplace and Open VSX.
- **Long chats open about 15 times faster** (300 turns with 150 commands: 1.9 s → 0.13 s). Commands of a reopened chat show their output as text instead of starting a terminal each, the colors of the terminal theme are read once per theme, and the chat measures its scroll position once per frame.
- In the terminal of a command, Ctrl+C copies the selected text, like the terminal of VS Code; without a selection it still stops the command.
- The **↓ New** button sits at the right edge, small, and no longer covers the output. Less space between a message and the next step.
- When the suggested model of a provider is missing, the setup chooses a chat model, not an embedding or speech model. The suggested Gemini model is `gemini-3.8-flash`.

## [0.4.0] - 2026-11-18

### Changed

- A new look for **Phew: Open Settings**: a menu in groups with icons that marks the section in view, a title and a short line for each section, settings in two columns with the control on the right, switches instead of check boxes, readable names for choices, and quiet tags. Models show as one row each, with the provider, the name, the facts, and the actions by weight; providers show as tiles.

### Fixed

- The menu of the settings marks the section that you clicked or scrolled to, also the last one, and long names no longer spill out of their row.

## [0.3.0] - 2026-11-18

### Added

- **A real terminal for the agent.** Each chat has a terminal in the panel with your own shell (bash, zsh, fish, PowerShell, or sh) and your startup files, and the agent types its commands into it. The session stays between commands: `cd`, variables, virtual environments, `ssh` into another machine, and REPLs carry over. You see every command live, in the panel and in a terminal inside the chat, and you can type at any time: answer a prompt, press Ctrl+C, or run your own command. Phew brings node-pty, prebuilt for Linux, macOS, and Windows on x64 and arm64, so it does not depend on the VS Code version.
- **Programs that wait for input.** Phew notices a prompt, a question, or a remote shell after `ssh`, and the agent types the answer or the next command; it asks you to type passwords. In the chat, **Your turn** gives an answer field, with a lock that hides a password.
- **Servers and watchers.** The agent starts them in their own terminal (`terminal: "new"`, `background`), reads their new log, and waits until they say, for example, "listening on" (`read_terminal`). A command never goes into a terminal that hosts a server.
- **Terminals** under the input: every terminal of the chat with its state, shell, process id, folder, and running command, with Ctrl+C and Close. Closing a terminal, deleting a chat, or closing VS Code ends every process that the terminal started.
- **Phew it! on a failed command**: one click starts a task that finds the cause in the output, fixes it, and runs the command again.
- Each command in the chat: the mascot of your assistant reads along, sweats while it waits for you, sighs with relief, or worries; the header says what the command does in plain words, with the time, the lines, and the errors; a thin line beats with the output. **Find in output** (Ctrl+F), **Run again**, **Copy**, and **Show in the terminal**.
- File paths in the output open in the editor at their line and column (`src/login.ts:42:7`, `src/a.ts(12,5)`), relative to the folder of the terminal; web addresses open in the browser.
- Commands get `PHEW_AGENT=1` and `PHEW_TERMINAL`, so scripts and Git hooks know that an agent runs them.
- The attach menu offers the recent output of each terminal of the chat.
- Settings: `phew.commands.terminal` (open the terminal with the first command, on request, or never), `phew.commands.shell`, and `phew.commands.shellStartupFiles`.

### Changed

- **Fewer questions about commands.** The default **Smart** mode runs commands that only read (`ls`, `pwd`, `cat`, `grep`, `find` without `-delete` or `-exec`, `git status`, `git log`, `git diff`, `--version`, and more) without asking, also in pipes and chains such as `find . 2>/dev/null | wc -l`; each part of a chain is checked, quotes are respected, and writes into `/tmp` are fine. **All** (before: Safe) runs every command except dangerous ones. A request has **Always allow `npm test`**, which adds the command to your allowlist. Each command says why it ran without asking, for example "auto: only reads". A short answer to a question of a running program, such as `y`, needs no new approval. Dangerous commands still always ask.
- Huge output stays fast: the model gets the start and the end with the number of lines left out, the chat skips lines that come faster than it can show and says so, and the terminal keeps everything.
- A long command is no longer stopped after the time limit: it keeps running, and the agent waits for it or stops it.
- **Stop** ends a program that ignores Ctrl+C: its processes end three seconds later.
- The terminals of Phew in the panel have the Phew drop as their icon and the cyan of its logo.

### Fixed

- Test runners and bundlers in watch mode no longer hang a task: the terminal of the agent sets `CI=1`, and a watcher that still starts keeps running in its own terminal.
- Prompt themes such as powerlevel10k with its instant prompt no longer break the end of a command.
- A quiet line such as `Installing dependencies:` no longer looks like a question.
- Letters such as я or ö show correctly when the system has no UTF-8 locale.
- After VS Code reloads, the agent learns that its shell is new and that the folder and the variables of earlier commands are gone.

## [0.2.0] - 2026-11-17

### Added

- A living mascot. The Phew drop blinks at irregular times and shows with its eyes what the agent does: it looks up while it thinks, reads along a line while it reads or searches, looks down at the terminal while a command runs, and squints while it edits.
- While the agent waits for your answer, the mascot looks at the request and sweats a little. It also sweats when a task takes long.
- On the welcome screen the eyes follow the pointer, look down at the input while you type, and doze off after a few idle minutes.
- The Phew icon in the activity bar shows what happens when the side bar is closed: the progress of VS Code while a chat runs, and a number when a chat needs your answer or finished. The number goes away when you open the chat.
- **Mascot** in **Appearance** and the `phew.appearance.mascot` setting: **Lively**, **Calm** (blinks only), or **Still**. The mascot stays still when the system asks for reduced motion, and it pauses when the view is hidden.
- The Phew family: eight looks for your assistant instead of emoji: Cat, Bot, Ghost, Sprout, Nerd, Night owl, Angel, and Ninja. Each one is the same living mascot, so it blinks, looks around, and dozes off. An emoji that you chose before still works.
- The send button wears the symbol of your assistant's look: a drop, a paw, a bolt, a ghost, a sprout, glasses, a star, a halo, or a shuriken. On hover it turns into the arrow, so the meaning stays clear, and each look sends in its own way.
- A livelier assistant card: a large preview that blinks, follows the pointer and greets each new look, a face for each character, a dice for a random look and name, names that suit each look, a compact list of characters, and **More** for your name and language. Enter saves.
- The assistant card is alive: the preview mascot is larger, blinks, follows the pointer, looks at the name while you type, and hops when you pick a look. Its face shows the character: relieved for Partner, attentive for Mentor, sleepy for Quiet, squinting for Strict reviewer.
- A dice next to the name picks a random look with a name that suits it, for example Mochi the cat or Byte the bot. A look also suggests a name until you type your own.
- The card is shorter: the name of the chosen look is shown next to **Look**, the four characters sit in a compact grid with **Describe your own…** under them, and **Call me** and **Answers in** moved under **More**. Enter saves, and **Save** is active only when something changed.

### Changed

- Fewer notifications. A finished task notifies only when it took at least 30 seconds (`phew.notifications.minSeconds`), a task that you stopped yourself never notifies, and each notification has **Notify Less**, which opens the notification settings. A request for your input still always notifies.
- A new send button that follows the accent color in every state: a quiet outline while the input is empty, a solid accent when there is something to send, a soft accent with a queue icon while the agent works, and **Stop** with a turning ring and a red hover. The arrow flies up when you send, and the tooltip shows the key. The input in focus uses the accent color too.
- The model menu opens right above the model button instead of at the top of the window. Each model shows a provider badge, its name without repeats, the model id, the provider, and the context size; **Auto** says that VS Code picks the model. It has a filter for long lists, numbers 1–9, and a note when the current mode always uses its own model. The model button shows the provider badge too.
- A command that waits for your approval shows in full, wrapped instead of cut off. After you decide, the card folds into one line.
- A clearer **Auto-approve** panel. Pick **Careful**, **Balanced**, or **Autopilot** in one click, or set Edits, Commands, and MCP tools with segments that say what each choice does. The panel shows the commands of your allowlist (and warns when it is empty), notes that read-only modes change nothing, and names what differs from your defaults before **Save as default**. The shield in the input shows the level: green for Careful, amber for Autopilot. A chat setting equal to the default no longer counts as a change.
- Copying shows its result everywhere: the icon turns into a green check, icon buttons show a small **Copied** bubble, and screen readers announce it. When the chat cannot write to the clipboard, Phew copies through VS Code, and a failure shows a red cross.
- A new attach menu. One click adds the current file, the selection, the problems of the file or of the workspace, the Git changes, or the last terminal output, and each row shows what exactly it adds, for example **3 errors** or **5 files changed**. A second click removes it. The numbers 1–9 work in the menu, and the chat shows a drop zone while you drag files over it.
- A new mode switch under the input. Each mode has its own icon and color, the menu explains every mode and marks the read-only ones, and the input shows a thin line in the color of the mode. **Shift+Tab** in the input switches the mode, and the numbers 1–9 pick one in the menu. Custom modes get their own color.
- A tidier **⋯** menu of the chat: the actions on this chat first, then new work, setup, your assistant, and help. Actions on an empty chat and **Continue from Handoff Note** hide when they have nothing to do. Switch Model moved to the model button under the input.
- A clearer **Appearance** menu in three groups: the chat, the accent, and your assistant.
  Every choice of three uses the same control, and the current choice has a calm outline instead of a loud fill.
  The chat styles show small previews.
  The accent shows the name of the current color, and **+** opens the system color picker for your own color.
  The text size shows the size in pixels, and ↺ returns to the editor size.
  The assistant row shows the living mascot, the name, and the character, with **Edit** and the mascot motion next to it.
  **Reset** appears when something differs from the defaults.
- The copy button and the time of an answer appear in a row under the answer, so they no longer cover its first line.
- A redesigned chat list. Open chats and the history are one list, grouped by Today, Yesterday, Previous 7 days, and Earlier.
- Each chat shows a line from the conversation, so chats with the same name are easy to tell apart. Chats saved by earlier versions get this line too.
- An empty new chat no longer appears in the list.
- Chats get a short name after the first answer, such as "Fix login redirect loop", in the language of the chat. Phew asks the chat model once per chat. A name that you set yourself never changes. Turn it off with `phew.chat.autoTitle`.
- **Pin to top** keeps important chats in a **Pinned** group at the top of the list.
- Right-click a chat for its menu. A middle click or Ctrl+Click (Cmd+Click) opens any chat in a new tab, also chats from the history.
- The key hints at the bottom of the list hide after you used the keys a few times.
- A dot marks the current chat, and a pulsing dot marks a chat that is running or needs your input.
- Search matches every word in the title and the preview line, and highlights the matches.
- Rename, open in a new tab, export, and delete move into a **⋯** menu on each chat. Deleting a chat shows **Undo** for a few seconds.
- **New chat** is the main action. **Chat in a new tab** and **Agent on a separate branch** are in its menu, with a short description.
- Use ↑ and ↓ to select a chat, Enter to open it, Ctrl+Enter or Cmd+Enter to open an open chat in a new tab, Shift+Delete to delete it, and Esc to close the list. A click outside also closes it.

### Fixed

- The send button no longer turns into the blue of the theme on hover.
- Your messages follow the accent color. Before, they stayed gray, or kept an old fixed color: choosing an accent or **Reset** in **Appearance** now also clears `phew.appearance.userBubbleColor`.
- The description of a Custom character no longer disappears when you save the assistant card again.
- Opening the assistant card and saving it no longer erases the description of a Custom character.

## [0.1.4] - 2026-11-17

### Changed

- A calmer chat. In the side bar, the chat title moves into the title of the view, so there is one header. Answers use the full width without an avatar or a name (turn them on in **Appearance**). The Calm palette uses the colors of your theme and one accent: Phew Drop, with darker tones in light themes and the theme border colors in high contrast.
- Steps of the agent are grouped into one line, such as "Read 2 files, edited 1 file and ran 1 command", and use plain words ("Reading src/auth.ts"). A live status line with the Phew drop shows what the agent does now and for how long.
- The chat no longer moves while you read: new text follows only when you are at the end, and a **↓ New** button jumps down.
- A comfortable reading width in editor tabs, more space between lines and messages, and a short input hint ("Ask Phew…") with the keys in its tooltip.
- The model button shows the model, such as `gpt-5.1`, and the context meter appears from 50%.
- **Chat Appearance** in the title of the view.
- New README and Marketplace pictures that show the real interface.
- Hover actions of your messages no longer take space, and the plan title has no emoji.

### Added

- A summary card at the end of each task that changed files: the time, whether the check passes, each file with lines added and removed, and **Keep all**, **Undo all**, and **Review** in one place. After you keep the changes, **Undo** restores the files from the checkpoint. The review banner appears only when the card is out of view.
- The welcome screen offers up to three real tasks from your project: fix the file with the most errors in Problems, fix the last failed terminal command, review your uncommitted changes, explain the open file, or explain the project.

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

[Unreleased]: https://github.com/LF3551/phew/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/LF3551/phew/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/LF3551/phew/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LF3551/phew/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LF3551/phew/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/LF3551/phew/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/LF3551/phew/releases/tag/v0.1.3
