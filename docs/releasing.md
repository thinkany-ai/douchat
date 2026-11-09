# Releasing Douchat

This guide is for maintainers who publish signed builds.

## Automatic updates

Production updates are served from the public `douchat` Cloudflare R2 bucket at
`https://cdn.douchat.ai`, while draft GitHub Releases serve as the staging area.
`electron-builder` creates each platform installer plus its checksum-protected
update manifest, and the packaged app embeds only the public CDN URL. The
renderer can request a check or installation over IPC, but it cannot replace the
release feed or access the R2 publishing credentials.

Installed builds check quietly 15 seconds after launch and every hour afterward,
and catch up after waking from sleep if the last check was over an hour ago.
Once an update is found, the settings icon keeps its notification dot until the
user chooses to upgrade. Users can also open
**Settings → About** to check manually. One click downloads the verified update,
installs it and restarts Douchat. If an agent task is active, the completed
download waits until the task has finished before restarting.

## Preparing a release

1. Set the same version in `package.json` and `package-lock.json`.
2. Commit the version change and push it.
3. Tag that commit with `v<version>` and push the tag.
4. Wait for [`.github/workflows/release.yml`](../.github/workflows/release.yml) to create a draft GitHub Release.
5. Test the attached DMG, then publish the draft. Publishing runs
   [`.github/workflows/publish-cdn.yml`](../.github/workflows/publish-cdn.yml), which uploads versioned files first and
   all platform update manifests last. The manifest update is the shipping step seen by
   installed clients.

```bash
npm version 0.2.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "release: Douchat 0.2.0"
git tag v0.2.0
git push origin dev v0.2.0
```

## Platforms

Tagged releases ship separate signed and notarized Apple Silicon (`arm64`) and
Intel (`x64`) macOS builds. Both architectures share `latest-mac.yml`; the
updater selects the matching ZIP automatically, so users never download the
other architecture's Electron runtime.
Tagged releases also include an unsigned Windows x64 NSIS installer and Linux x64
AppImage and Debian packages, with separate update manifests.

## Repository secrets

The release workflows use these repository secrets:

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the certificate archive |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_PASSWORD` | App-specific Apple password |
| `APPLE_TEAM_ID` | Apple Developer team identifier |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account containing the `douchat` bucket |
| `R2_ACCESS_KEY_ID` | Bucket-scoped R2 Object Read & Write token id |
| `R2_SECRET_ACCESS_KEY` | Bucket-scoped R2 token secret |

Never store these values in `.env`, the builder configuration or Git history.
The R2 token is restricted to the `douchat` bucket and exists only in GitHub
Actions Secrets; downloads through `cdn.douchat.ai` are public and credential-free.
The local `package:mac` command explicitly disables signing and notarization, so
it is suitable for smoke testing but not distribution or automatic-update tests.

## Bundled agl

Packaged macOS and Linux builds ship the [agl](https://github.com/thinkany-ai/agl)
binary as `<resources>/bin/agl`. Douchat installs it into the shared
`~/.agl/bin/agl` on first launch (never over a newer one) and runs it as the
local agent daemon; see `src/main/agl/aglLifecycle.ts`.

- The version is pinned once, in `package.json` → `"agl": { "version": … }`.
  `DOUCHAT_AGL_VERSION` overrides it for one build.
- `npm run package*` and `npm run release:mac` run `scripts/fetch-agl.mjs`
  first. It downloads `agl-<target>` and `agl-<target>.sha256` from the
  `v<version>` GitHub release (`darwin-arm64`, `darwin-x64`, `linux-x64`,
  `linux-arm64`), refuses a checksum mismatch, and places the binary under
  `resources/bin/<target>/agl` (git-ignored). electron-builder copies it with
  `build.mac.extraResources` / `build.linux.extraResources`.
- **The pinned agl version must be released on GitHub before packaging.**
  Packaging fails with `HTTP 404 (is this agl version released?)` otherwise.
- macOS signing: `@electron/osx-sign` signs every Mach-O file in the bundle,
  including `Contents/Resources/bin/agl`, with the app's Developer ID, hardened
  runtime and `entitlementsInherit`, and the binary is notarized with the app.
- Windows builds bundle nothing: agl does not support Windows, and Douchat keeps
  its own local runtime there.
- Development: `DOUCHAT_AGL_BIN=/path/to/agl` makes `fetch-agl.mjs` copy that
  binary for the host's own target (refused with `--release`), and makes a
  development run of the app use it as the bundled agl. A development run leaves
  the shared `~/.agl` alone unless `DOUCHAT_AGL_HOME` names an agl home.
