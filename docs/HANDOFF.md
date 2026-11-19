# Handoff notes

A handoff note lets any coding agent, or any person, continue work that another session started.
Phew writes the notes, but the format is plain Markdown so that any tool can read and write it.

## Files

```text
.phew/
├── .gitignore                 # managed by Phew: sessions/ and, by default, handoff/
├── handoff/
│   ├── LATEST.md              # a copy of the newest note: the entry point for agents
│   └── 2026-11-17-fix-login-timeout-abc123.md
└── sessions/
    └── <session id>/journal.jsonl
```

- **Journal** (`sessions/<id>/journal.jsonl`): an append-only log with one JSON object per line: requests, edits, commands with exit codes, checks, task results. Secrets are removed before a line is written. Journals never leave the computer: they are always in `.phew/.gitignore`.
- **Note** (`handoff/*.md`): one per session; later notes of the same session replace it. With `phew.handoff.share` set to `commit`, notes can be committed so that teammates and their agents can continue the work.

## How agents find the note

With your consent, Phew adds this section to `AGENTS.md`, and to `CLAUDE.md` and `GEMINI.md` when they exist. Phew changes only the text between the markers.

```md
<!-- phew:handoff:begin -->
## Continuing earlier work

Before you start, read `.phew/handoff/LATEST.md` if it exists. ...
<!-- phew:handoff:end -->
```

## Format (`phew-handoff/1`)

A YAML header, then Markdown. Every header value is JSON, which is also valid YAML, so a parser needs only `key: <JSON>` per line.

| Key | Meaning |
|---|---|
| `schema` | Always `"phew-handoff/1"`. |
| `title`, `status` | The task, and `in-progress`, `done`, or `blocked`. |
| `session`, `created` | The session id and the ISO time of the note. |
| `branch`, `head` | The Git branch and commit when the note was written. |
| `goal` | The goal of the chat, if set. |
| `check` | The check command and whether it passed. |
| `fingerprints` | `{ "path": "<first 16 hex of SHA-256>" }` of each changed file, or `"deleted"`. |
| `continues` | The note that this session continued from. |

Sections, in this order, each only when it has content: **Summary**, **Goal**, **Next steps**, **Decisions** (ids `D1`, `D2`…, kept across notes, replaced and dropped ones struck through), **Dead ends: do not repeat**, **Open questions**, **User preferences**, **Plan**, **Facts** (changed files, commands, requests: only from the journal), and **How to verify**.

The facts come from the journal, so the model cannot invent which files changed or which checks passed. The other sections are written by the model.

## Freshness

Before an agent continues, compare the note with the code:

1. Is the current branch the same as `branch`?
2. Is `head` an ancestor of the current commit, and how many commits came after it (`git rev-list --count <head>..HEAD`)?
3. Does the SHA-256 of each file in `fingerprints` still match?

Phew does this for `/continue` and tells the agent what changed, so it rereads those files instead of trusting the note.

## In Phew

- `/handoff`: write a note now. Notes are also written after a task that changed files and when a long chat is compacted (`phew.handoff.auto`).
- `/continue`, the **Continue** card on the welcome screen, or **Phew: Continue from Handoff Note…**: start a chat from a note.
- **Phew: Point Other Agents to Handoff Notes**: update the section in `AGENTS.md`.
- A new chat tells the agent about the unfinished work of other sessions: the latest note of up to three sessions that are not done.
