# Releasing Phew

Releases run in GitHub Actions with one click. No tokens are stored: the stores trust this repository through OIDC.

## Release

1. Make sure the changes are listed under **Unreleased** in `CHANGELOG.md` and CI on `main` is green.
   CI checks Ubuntu and Windows on every push; check macOS by hand before a release (**Actions → CI → Run workflow**).
2. Open **Actions → Release → Run workflow** on `main`.
   - **bump**: `patch`, `minor`, or `major`. It is used only when the version in `package.json` already has a tag.
   - **dry_run**: check and build only.
3. The workflow:
   - chooses the version, moves **Unreleased** in `CHANGELOG.md` to it, and runs all checks;
   - builds `phew-x.y.z.vsix` with a SHA-256 checksum;
   - commits `chore: release x.y.z`, tags `vx.y.z`, and pushes both to `main`;
   - creates the GitHub release with the changelog section as notes (0.x versions are pre-releases);
   - publishes to the Visual Studio Marketplace and Open VSX, when they are turned on (see below).

From the command line: `gh workflow run Release --ref main -f bump=patch`.

## Store setup (one time)

Both stores use trusted publishing: the workflow gets a short-lived token from GitHub (OIDC) and exchanges it with the store.

### Visual Studio Marketplace

1. <https://marketplace.visualstudio.com/manage> → publisher `alekseialeinikov` → **Trusted Publishing** → **Create**:
   - Policy name: `Phew release`
   - Provider: GitHub Actions
   - Repository owner: `LF3551`
   - Repository: `phew`
   - Workflow: `release.yml`
   - Environment: `release`
2. In GitHub: **Settings → Secrets and variables → Actions → Variables** → add `PUBLISH_MARKETPLACE` = `true`.

### Open VSX (VSCodium, Cursor, Windsurf, and others)

1. Sign in at <https://open-vsx.org> with GitHub, sign the publisher agreement, and create the namespace `alekseialeinikov`.
2. Set up trusted publishing for the namespace with the same repository, workflow, and environment.
3. Add the variable `PUBLISH_OPEN_VSX` = `true`.

### Optional: approve each publication

**Settings → Environments → release → Required reviewers**: add yourself. Then the store jobs wait for your **Approve** after the GitHub release is created.
