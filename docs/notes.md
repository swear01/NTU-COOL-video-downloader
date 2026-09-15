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

## Large MP4s, estimated tail segments, and diagnostics (v1.2.2)

- MP4Box `getBuffer()` serializes the whole output into a `DataStream` whose
  allocation doubles. A movie over 1 GiB requests a 2 GiB ArrayBuffer; that
  allocation failed in the affected Brave profile. `mp4Blob()` now writes the
  same boxes into bounded Blob parts. Do not convert the final Blob back to
  one ArrayBuffer. Samples are still held in memory during remuxing, so total
  available RAM remains a practical limit.
- GPAC fixed-duration MPDs can estimate one nonexistent final video segment
  when the presentation duration exceeds actual video duration by milliseconds.
  Download the prefix first; omit the final segment only if contiguous samples
  already cover the initialization segment's declared fragment duration.
  Without that evidence, fetch the tail normally and report any failure.
  Never floor the MPD count or ignore arbitrary 404s: audio and partial video
  tails can contain required samples.
- Download failures retain stage, HTTP status, resource path, track, segment,
  attempts, and timestamp. Consumer/remux errors are terminal, not retried as
  network failures. Diagnostics omit signed URL query strings and credentials.
- Batch rows and the readonly URL input remain selectable. Storage events
  replace polling, preserving expanded details and unchanged selected text.
  Copy/export take a fixed snapshot; clipboard rejection exposes a readonly
  fallback. Stop keeps completed/error rows and canceled retry metadata.
  Retry creates fresh job IDs and
  discovers fresh manifests only for failed rows; it retains the last error.
- Only the most recent batch report persists in local storage, from batch
  creation and at state transitions (not every progress tick). A report read
  after browser restart is historical: nonterminal rows are shown as canceled,
  and transfers never restart automatically. Persistence errors are surfaced
  so the user can export before closing the browser.

## Service worker startup (v1.2.3)

Chromium rejects service worker modules containing top-level `await`, including
in imported modules. A rejected background worker cannot register the action
context menu or handle download requests. Restore pending filenames without
top-level `await`, after synchronously registering wake listeners.

Node's asynchronous `import()` accepts this syntax, so ordinary mocked worker
tests missed it. The synchronous module-load regression check rejects an async
module graph, including a top-level `await` introduced in an import.

A clean Brave 152.1.94.117 profile reproduces the failure with the 1.2.2
package: no worker target, no status response, and `open-batch` is absent.
Changing only the startup `await` to `void` in that same package restores
the worker response and menu. Version 1.2.3 also passes this browser check.

## Batch source resolution without video tabs (v1.2.4)

- Fetch the module item HTML with the user's existing browser login, parse its
  native COOL LTI form in the offscreen document, and POST it only to the
  validated `cool-video.dlc.ntu.edu.tw/ltiv1p1/launch/videos/<id>` endpoint.
- Follow the authorized player URL to `/api/courses/<course>/videos/<id>/view`
  and use its `sourceUri`. Launch IDs and player video IDs differ; derive the
  API path from the final player URL, not from the launch ID.
- Use `cache: no-store` for a fresh signed form on every attempt. Reusing a
  consumed form returned HTTP 401 in a live check. Never persist LTI fields.
- Resolve in the existing offscreen document (`DOM_PARSER` plus `BLOBS`), with
  abort on Stop/timeout and job-ID checks that reject late source results.
  Pause permits source lookup to finish but leaves the item queued.
- Live verification covered all 18 previously failing source lookups: module
  HTML fetched in an ordinary authenticated COOL tab, then only that HTML
  supplied to an isolated Brave extension. Real extension fetch performed
  the LTI redirect, metadata request, and MPD fetch/parse for every item.
  All 18 succeeded. This does not prove 18 complete MP4 downloads or the
  installed profile's extension-to-Canvas cookie path.
- A separate real-worker/offscreen smoke check resolved a source while paused,
  left it queued, and stopped successfully with only the probe tab open.
