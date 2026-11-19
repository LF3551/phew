# Security policy

## Supported versions

Only the latest released version gets security fixes.

## Report a vulnerability

Do not open a public issue for a security problem.

Use one of these private channels:

1. GitHub private vulnerability reporting: go to the **Security** tab of this repository and select **Report a vulnerability**.
2. Email: contact@alekseialeinikov.com

Include the affected version or commit, the steps to reproduce, and the possible impact.
You get a first reply within 7 days.

## Verify that you have the real Phew

Fake and compromised extensions in extension stores are a real risk. Phew comes from one place: this repository.

1. Install only `alekseialeinikov.phew`: from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=alekseialeinikov.phew), from [Open VSX](https://open-vsx.org/extension/alekseialeinikov/phew), where the namespace `alekseialeinikov` is verified, or from [GitHub Releases](https://github.com/LF3551/phew/releases).
2. Every release is built and published by the **Release** workflow of this repository. The stores trust the workflow through OIDC (trusted publishing), so no long-lived publishing token exists that someone could steal.
3. Each `.vsix` on GitHub Releases has a SHA-256 checksum:

   ```sh
   sha256sum -c phew-0.5.0.vsix.sha256
   ```

4. From version 0.5.0, each `.vsix` also has a signed build provenance attestation: a statement, signed through GitHub, that the Release workflow of `LF3551/phew` built this exact file from a given commit. Check it with the GitHub CLI:

   ```sh
   gh attestation verify phew-0.5.0.vsix --repo LF3551/phew
   ```

Phew does not download or run code from the internet by itself. The terminal library (node-pty) is in the package. MCP servers and commands run only when you or your project configuration ask for them.

## Security principles

1. Each file change of the agent can be reviewed: **Keep** and **Undo** in the editor by default, or **Ask first** to approve hunks before they are written. Each request is a checkpoint that **Restore checkpoint** reverts.
2. Commands that change something ask first in the default **Smart** mode. Dangerous commands, such as `git push --force`, `rm -rf`, `sudo`, or `terraform apply`, always ask, and `phew.commands.deny` blocks commands for good.
3. Phew does not read sensitive files, such as `.env` files and keys, and removes secrets from tool output before it goes to the model.
4. Phew changes files, runs commands, starts MCP servers, and reads project rules only in a trusted workspace. In Restricted Mode it only answers questions.
5. API keys stay in the VS Code secret storage. Model profiles and key commands come only from the user settings, so a workspace cannot redirect a key or run a command. Plain HTTP is allowed only for localhost and private networks.
6. Passwords that a command asks for go from you to the program, never to the model.
7. Phew does not collect telemetry.
8. The chat view uses a strict Content Security Policy and never renders model output as HTML.
