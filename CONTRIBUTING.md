# Contributing to Phew

Thank you for your interest in Phew.
The process is small on purpose: an issue for a large change, focused pull requests, and tests for each behavior change.

## Before you start

1. Search the [issues](https://github.com/LF3551/phew/issues) for the same bug or idea.
2. For a large change, open an issue first and describe the problem and your plan.
3. Read [AGENTS.md](AGENTS.md) for the project rules.
   The rules apply to humans and to AI coding agents.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused on one change.
3. Add or update tests for each behavior change.
4. Update `README.md` and `CHANGELOG.md` when a user-visible behavior changes.
5. Sign off each commit to accept the [Developer Certificate of Origin](https://developercertificate.org/):

   ```sh
   git commit -s -m "feat: add the chat sidebar"
   ```

6. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit titles, for example `fix:`, `feat:`, `docs:`, or `test:`.

## Development

```sh
npm ci
npm run check            # type check, lint, and unit tests
npm run test:integration # run the extension in VS Code with a fake model server
npm run ui:audit         # check the chat in 3 themes and 3 widths (needs Playwright)
npm run images           # render the README pictures from the real chat (needs Playwright)
```

For a change in the chat, run `npm run ui:audit` and look at the screenshots it writes.

Press `F5` in VS Code to start an Extension Development Host.
Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before you change the structure.

## License of contributions

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as Section 5 of the License describes.

## Code of conduct

All participants must follow the [Code of Conduct](CODE_OF_CONDUCT.md).
