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
- UploadState enum (V2): `SUCCEEDED` is the **only** terminal success
  state; in-flight is `IN_PROGRESS` (the media.upload reference text also
  uses `UPLOAD_IN_PROGRESS`; treat both as in-progress); `FAILED` /
  `NOT_FOUND` are errors. `fetchStatus` reports async progress as
  `lastAsyncUploadState`.

## First real store publish (v1.2.1, 2026-08-14) — gotchas

- **Reruns use the workflow file from the run's original commit.** v1.2.0 /
  v1.2.1 were pushed before PR #11 (auto-publish) merged and before
  `CWS_ENABLED` was set, so their runs had no `store` job at all; `gh run
  rerun` of the old run re-executed the old `release.yml` (unconditional
  `gh release create`, which then fails because the release already
  exists). Fix: force-move the tag to a commit carrying the current
  `release.yml` and force-push — the tag push re-triggers with the current
  workflow (tag name must still equal the manifest version).
- **A pending member invite grants no API access.** The 2026 role-based
  member flow can leave a service account at "invite sent" forever (SAs
  have no mailbox to accept); the SA must be an **active** member of the
  publisher (role >= Item manager per the 2026-04-28 roles blog post).
  Before rerunning the store job, probe with the SA key:
  `GET /v2/publishers/{id}/items/{item}:fetchStatus` must return 200, not
  403.
- **The pipeline had never completed an upload before 2026-08-14:**
  `publish-cws.mjs` shipped expecting upload state `UPLOADED`, but the V2
  API returns `SUCCEEDED`, so the store job failed right after every
  successful upload. Fixed by PR #13; 1.2.1 itself was submitted for
  review via the documented manual path (local key at
  `~/.config/cws-publish/cws-publisher.json`) before the fix merged.
