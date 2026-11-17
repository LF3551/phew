<p align="center">
  <img src="resources/icon.png" alt="Phew logo: two relieved closed eyes and a sweat drop" width="128" height="128">
</p>

<h1 align="center">Phew</h1>

<p align="center">
  <strong>Bug fixed. Phew.</strong><br>
  An open-source AI coding agent for VS Code, built on the <a href="https://pi.dev">Pi</a> coding agent.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-orange.svg">
</p>

> [!WARNING]
> Phew is in early development.
> There is no release yet, and nothing below is available in the VS Code Marketplace.
> The [Roadmap](#roadmap) shows what is planned and what is done.

## Why Phew

AI coding agents are powerful, but many VS Code integrations are heavy, closed, or hard to trust.
Phew has these goals:

1. **Open source.** MIT license, public development, no hidden telemetry.
2. **Light.** Phew uses your installed Pi.
   The extension does not bundle a large runtime.
3. **Safe by default.** You see every file change as a diff before Phew applies it.
4. **Fast to start.** Install, sign in to a provider, and ask.
5. **Fun.** When the work is done, you get a "Phew! Done."

## Planned features

| Feature | Description |
| --- | --- |
| Chat sidebar | Ask about the code base with the current file, selection, and diagnostics as context. |
| Preview and Apply | Review each proposed change in the native VS Code diff editor before you apply it. |
| Fix this problem | Send an error from the Problems panel to Phew with one click. |
| Fix failing tests | Run a test command, send the failures to Phew, and review the fix. |
| Git review | Review the staged changes or a branch diff before you commit. |
| Sessions | Continue, branch, and export conversations. |
| Any model | Use the providers and models that you configured in Pi. |

## Requirements (planned)

1. VS Code (the minimum version is not decided yet).
2. [Pi](https://pi.dev) installed and configured with a model provider.
3. A trusted workspace for actions that run processes or change files.

## Roadmap

- [x] Name, logo, and license
- [ ] Extension scaffold, build, lint, and CI
- [ ] Connect to the installed Pi through its RPC interface
- [ ] Chat sidebar with editor context
- [ ] Preview and Apply for file changes
- [ ] "Fix this problem" from the Problems panel
- [ ] Test repair workflow
- [ ] Git review
- [ ] First Marketplace and Open VSX release

## Brand

The logo, colors, and usage rules are in [docs/BRAND.md](docs/BRAND.md).

## Contributing

Contributions are welcome.
Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.
For security problems, follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## Disclaimer

Phew is an independent project.
It is not affiliated with or endorsed by the Pi project, Earendil Works, or Microsoft.
"Visual Studio Code" and "VS Code" are trademarks of Microsoft Corporation.

## License

[MIT](LICENSE) © 2026 Aleksei Aleinikov
