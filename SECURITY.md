# Security policy

## Supported versions

Phew has no release yet.
After the first release, only the latest released version gets security fixes.

## Report a vulnerability

Do not open a public issue for a security problem.

Use one of these private channels:

1. GitHub private vulnerability reporting: go to the **Security** tab of this repository and select **Report a vulnerability**.
2. Email: contact@alekseialeinikov.com

Include the affected version or commit, the steps to reproduce, and the possible impact.
You get a first reply within 7 days.

## Security principles

1. Phew shows every file change as hunks and applies only the hunks that the user selects, unless the user turns off `phew.edits.requireApproval`.
2. Phew always asks before dangerous or chained shell commands.
3. Phew does not read sensitive files, such as `.env` files and keys, and removes secrets from tool output before it goes to the model.
4. Phew changes files, runs commands, starts MCP servers, and reads project rules only in a trusted workspace.
5. Phew keeps the API key in the VS Code secret storage and allows plain HTTP only for localhost.
6. Phew does not collect telemetry.
7. The chat view uses a strict Content Security Policy and never renders model output as HTML.
