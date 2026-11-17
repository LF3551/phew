# Releasing Phew

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a version tag is pushed.

## Steps

1. Update `version` in `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`).
2. In `CHANGELOG.md`, move the items from **Unreleased** into a new `## [x.y.z] - YYYY-MM-DD` section and update the links at the bottom.
3. Check locally:

   ```bash
   npm run package                 # types, lint, unit tests, production build, VSIX
   npm run test:integration        # needs a display; on Linux run Xvfb and set DISPLAY
   node scripts/release-notes.mjs x.y.z
   ```

4. Commit with sign-off and push to `main`. Wait for green CI.

   ```bash
   git commit -s -m "chore: release x.y.z"
   git push origin main
   ```

5. Tag and push the tag:

   ```bash
   git tag -s vx.y.z -m "Phew x.y.z"   # or -a if you do not sign tags
   git push origin vx.y.z
   ```

The workflow then:

- checks that the tag matches `package.json` and that `CHANGELOG.md` has the section;
- runs all checks and builds `phew-x.y.z.vsix` with a SHA-256 checksum;
- creates the GitHub release with the changelog section as notes (0.x versions are marked as pre-releases);
- publishes to the Visual Studio Marketplace if the `VSCE_PAT` secret is set;
- publishes to Open VSX if the `OVSX_PAT` secret is set.

## Store accounts (one time)

- **Visual Studio Marketplace:** create the publisher `alekseialeinikov` at <https://marketplace.visualstudio.com/manage>, create an Azure DevOps personal access token with the **Marketplace → Manage** scope, and save it as the repository secret `VSCE_PAT`.
- **Open VSX** (VSCodium, Cursor, Windsurf, and others): sign in at <https://open-vsx.org> with GitHub, sign the publisher agreement, create the namespace `alekseialeinikov` (`npx ovsx create-namespace alekseialeinikov -p <token>`), and save the token as `OVSX_PAT`.

Without these secrets, the workflow only creates the GitHub release with the VSIX.
