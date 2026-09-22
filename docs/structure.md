# Structure

```
background/   Service worker: manifest capture, download orchestration,
              two-video batch queue + latest local report, source resolution dispatch, filename determination (scoped listener)
batch/        Batch-download page: selectable results, copy/export, failed-only retry
offscreen/    Offscreen document: shared popup/batch waiting queue, two slots through saving + parallel fragments + MP4 remux
popup/        Extension popup UI
utils/        core (sanitizeFilename, ManifestStore), downloader (adaptive
              concurrency), remuxer (bounded MP4 Blob + tail coverage), mpd,
              offscreen, diagnostics (error formatting/redaction/report serialization)
scripts/      package.sh (ZIP), publish-cws.mjs (Chrome Web Store API V2)
store/        chrome-web-store.md (listing copy), publishing.md (release
              pipeline + one-time setup)
test/         node --test suite; background.test.js mocks chrome.*
.github/      ci.yml, codeql.yml, release.yml (tag → release → store)
```

Key invariants:

- `background/background.js` owns ALL `chrome.downloads` interaction.
- The `onDeterminingFilename` listener must stay registered ONLY while one
  of our own MP4s is waiting for its filename (see the comment block in
  background.js and `docs/notes.md`).
- `scripts/publish-cws.mjs` is the only Chrome Web Store API client.
