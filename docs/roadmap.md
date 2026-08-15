# Roadmap

## Backlog

- m3u8 streaming support (currently DASH/mp4 only).
- Percentage-rollout publish option via the store API for large audiences.
- Optional manual-publish mode (upload-only) as a repo variable.

## Recently Done

- v1.2.1 store submission via the fixed pipeline (PR #13, 2026-08-14):
  first real store publish — `UploadState` `SUCCEEDED` fix in
  `publish-cws.mjs`, service account activated in the dashboard,
  `CWS_PUBLISHER_ID` secret set; item at `PENDING_REVIEW`.
- v1.2.1: fixed the `onDeterminingFilename` conflict with other downloader
  extensions (scoped listener; PR #9).
- Chrome Web Store auto-publish pipeline via API V2 + service account
  (PR #11): `scripts/publish-cws.mjs`, `release.yml` store job, `cws-publish`
  environment, `CWS_ENABLED` opt-in, agent handbook docs.
- v1.2.0: batch video downloads + download progress UI.
