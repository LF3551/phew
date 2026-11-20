# More power

- **Terminals you can follow:** the agent names its terminals ("dev server", "tests"), shows the ports of servers, and closes what it no longer needs. **All agents** in the list of terminals shows every chat.
- **Report a Problem:** **Phew: Report a Problem…** writes a bug report without secrets or private paths, for you to read before it opens on GitHub.
- **Subagents:** the agent sends research tasks to helpers that read in parallel, each with its own model, and report back. Open a card to see the steps and the report.
- **Rules that fit the file:** Phew reads `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and the rule files of other agents. A rule for some files comes when the agent works on them. `/init` writes an `AGENTS.md` for your project.
- **Memory:** the agent remembers project facts in `.phew/memory.md`, with the file each comes from, and your preferences for every project in `~/.phew/memory.md`. `/learn` saves what a chat taught, after you choose.
- **Parallel agents:** **Phew: New Agent in Worktree** works on a new branch in a separate folder.
- **Handoff notes:** after a task, Phew writes a short note that any agent can continue from.
- **Code index:** Phew finds relevant code by meaning, not only by exact words.
- **Autocomplete and Next Edit:** turn on autocomplete in the status bar, and press `Alt+]` to predict the next edit.
- **Custom modes:** define your own modes in the settings or in `.phew/modes.json`.
