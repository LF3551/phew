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
   - builds `phew-x.y.z.vsix` with a SHA-256 checksum and a signed build provenance attestation (`gh attestation verify phew-x.y.z.vsix --repo LF3551/phew`);
   - commits `chore: release x.y.z`, tags `vx.y.z`, and pushes both to `main`;
   - creates the GitHub release with the changelog section as notes (a version with a suffix, such as `1.2.0-beta.1`, is a pre-release);
   - publishes to the Visual Studio Marketplace and Open VSX, when they are turned on (see below).
   - starts the **Website** workflow, so the website shows the new version.

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

### Open VSX (VSCodium and other editors)

The namespace `alekseialeinikov` is verified, and trusted publishing is set up. For a new namespace:

1. Sign in at <https://open-vsx.org> with GitHub, sign the publisher agreement, and create the namespace.
2. Ask for ownership of the namespace in an issue at <https://github.com/EclipseFdn/open-vsx.org>. Until it is approved, uploads stay inactive.
3. In the namespace, **Trusted Publishers → GitHub**: extension `phew`, repository `LF3551` / `phew`, workflow `release.yml`, environment `release`.
4. Add the variable `PUBLISH_OPEN_VSX` = `true`.

## When a store job did not run

If a store was turned off or failed, publish the same release later without a new version: open the run of the release in **Actions** and **Re-run** only the job of that store (`gh run rerun <run-id> --job <job-id>`). It uses the `.vsix` of that run; the other jobs do not run again.

## Website

The website in `site/` is published to <https://lf3551.github.io/phew/> by the **Website** workflow after each change on `main` to `site/`, `docs/images/`, `resources/`, or `package.json`, so it shows the version of the latest release. Build it locally with `npm run site`.

### Optional: approve each publication

**Settings → Environments → release → Required reviewers**: add yourself. Then the store jobs wait for your **Approve** after the GitHub release is created.
