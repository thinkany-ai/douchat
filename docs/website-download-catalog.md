# Website download catalog

The homepage and `/download` read `https://cdn.douchat.ai/latest.json` at runtime.
Versions and installer URLs belong to the CDN catalog, not the website source.
The website caches public catalog data for 60 seconds and refreshes visible pages
every minute. A failed refresh keeps the last successful data; a cold failure
shows unavailable downloads rather than inventing a version or URL.

## Release publication

The `Publish release to CDN` workflow runs `scripts/publish-release.sh`. It:

1. Uploads immutable artifacts.
2. Publishes supplied platform updater manifests.
3. Reads the live Mac, Windows and Linux feeds, preserving platforms not released.
4. Generates `latest.json` and checks that every advertised installer is reachable.
5. Uploads `latest.json` last with `Cache-Control: no-store, max-age=0`.

New Mac artifacts and updater metadata use `thinkany/`. The original root
`latest-mac.yml` stays on the original-team-signed migration bridge; regular
releases must not replace it with a ThinkAny-only signature. Windows and Linux
continue to use root paths. These namespaces are handled by the publication
script, and absolute installer URLs in `latest.json` keep the website independent
of naming and storage layout.

For a manual publication, run the same publisher with the release files and its
documented R2 credentials. Do not upload an installer alone and expect the site
to infer its version from an object listing: publish its updater manifest too.
No website edit, commit or deployment is needed for subsequent releases.

## Regenerating an existing catalog

Download `thinkany/latest-mac.yml`, `latest.yml` and `latest-linux.yml` into a local
directory, named `latest-mac.yml`, `latest.yml` and `latest-linux.yml`. Then run:

```sh
node scripts/generate-download-catalog.mjs <feed-directory> <output-latest.json>
```

Verify the advertised installer URLs, then upload the JSON as `douchat/latest.json`
with `Content-Type: application/json` and `Cache-Control: no-store, max-age=0`.
The catalog schema is versioned (`schemaVersion: 1`), with each platform providing
its own `version` and `downloads` (`mac.arm64/x64`, `windows.x64`,
`linux.appImage/deb`). A platform manifest missing an installer is rejected.
