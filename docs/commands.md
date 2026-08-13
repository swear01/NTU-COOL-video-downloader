# Commands

## Release a new version

1. Bump `manifest.json`, `package.json`, `package-lock.json` (root entry)
   and the versioned examples in `README.md` / `README.zh-TW.md`
   (`NTU-COOL-video-downloader-<version>.zip`).
2. Open a PR, wait for CI (`npm test` runs 60+ tests; CodeQL; audit).
3. Merge, then from a main checkout:

```sh
git tag v<version>          # tag must equal manifest version exactly
git push origin v<version>  # triggers release.yml
```

The workflow creates the GitHub release (ZIP + SHA256SUMS + attestation)
and, when enabled, uploads/publishes to the Chrome Web Store.

## Local verification

```sh
npm test            # node --test (unit tests incl. publish-cws.mjs)
npm audit           # full tree (the store runtime is a devDependency)
npm run package     # builds release/NTU-COOL-video-downloader-<version>.zip
```

## Manual Chrome Web Store upload (no tag)

```sh
CWS_SERVICE_ACCOUNT="$(base64 < ~/.config/cws-publish/cws-publisher.json)" \
CWS_PUBLISHER_ID="<publisher-id>" \
  npm run cws:publish -- --upload release/NTU-COOL-video-downloader-<version>.zip --publish
```

Omit `--publish` to upload without submitting for review. Requires Node 22+.

## Store status

```sh
# fetchStatus for the store item (publishers/.../items/hbmhcpfcjdbgokaloffibmehefkdjdap)
gh api ... # or run publish-cws.mjs --upload <zip> to see the reconcile outcome
```
