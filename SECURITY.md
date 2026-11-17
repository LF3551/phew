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

Phew follows these rules:

1. Phew does not change files without a visible diff and an explicit **Apply**, unless the user turns on a less strict mode.
2. Phew runs process-launching and file-changing workflows only in a trusted workspace.
3. Phew sends prompts and context to Pi through stdin, not through process arguments.
4. Phew does not collect telemetry.
5. Webviews use a strict Content Security Policy and sanitize rendered content.
