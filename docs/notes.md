# Notes

## Chrome's filename-determination rules (do not re-learn the hard way)

- `chrome.downloads.onDeterminingFilename` fires for **every** download in
  the browser, not just the registering extension's own downloads.
- When several extensions have listeners, Chrome lets the **most recently
  installed** extension decide the filename for ALL downloads
  (`DetermineFilenameInternal` in chromium's `downloads_api.cc`). Every
  losing extension gets the "Extension cannot name the downloaded file"
  conflict warning on its `chrome://extensions` page.
- **Quirk:** calling `suggest()` with no arguments (or `undefined`) still
  counts as participating — the bindings send an empty filename and an
  empty conflict action, which parses to `kNone` (not `kUniquify`), so the
  determiner logic treats it as an override with an empty name.
- Consequence: an always-registered listener with `suggest(undefined)` for
  foreign downloads silently replaces other extensions' filenames (e.g.
  Image Downloader) with Chrome's defaults and shows them the warning.
  This exact bug shipped in v1.2.0 and was fixed in v1.2.1 (PR #9).

## The v1.2.1 fix (background/background.js)

The listener is registered only while one of our own MP4s is waiting for
its filename to be determined (`setPendingFilename` / `removePendingFilename`
manage a `pendingFilenames` map persisted in `storage.session`). During the
brief registered window a foreign download still receives a bare `suggest()`
(the API requires exactly one call) — unavoidable while registered, so the
window is kept minimal. Never widen this scope.

## Chrome Web Store publishing pipeline (PR #11)

- Every `v*` tag runs `release.yml`: GitHub release (tests, ClamAV,
  attestation) then the `store` job uploads the release ZIP to the store
  and submits it for review via the Chrome Web Store API V2.
- The store job is gated on the `CWS_ENABLED` repository **variable** and
  runs in the `cws-publish` GitHub **environment** (credentials live there;
  optional required reviewers = approval gate).
- `scripts/publish-cws.mjs` is deliberately idempotent and defensive:
  - same manifest version already submitted/published → no-op (no duplicate
    upload);
  - store already newer than the tag → no-op (older tags must never regress
    the store item);
  - ZIP's own `manifest.json` must match the checkout;
  - `itemError` from the API aborts before publish;
  - transient 5xx/429/network errors are retried; polling is bounded by
    elapsed time.
- CWS dashboard-only steps that cannot be automated: granting the service
  account under Account, reading the publisher ID (Publisher > Settings),
  and the publisher account's 2-step verification.

## Store API facts (verified against official docs 2026-08)

- V2 is the current API (`chromewebstore.googleapis.com`); V1 was
  superseded in October 2025.
- Media upload = bare POST to `/upload/v2/publishers/{publisherId}/items/{itemId}:upload`
  with the ZIP as the body — no `uploadType` parameter on the `/upload/`
  path.
- `fetchStatus` responses have been observed both flat and nested under
  `itemStatus[0]`; `publish-cws.mjs` accepts both shapes.
- Node >= 22 is required (google-auth-library@11).
