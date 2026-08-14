# Plan

## Done (2026-08-14)

- Chrome Web Store publishing setup completed:
  1. Service account
     `cws-publisher@gemini-github-review-503915.iam.gserviceaccount.com`
     added in the CWS Developer Dashboard under Account. It must be an
     **active** member: a pending invite grants no API access (service
     accounts cannot accept the invite email) — see `docs/notes.md`.
  2. `CWS_PUBLISHER_ID` secret set in the `cws-publish` environment.
  3. Publisher account 2-step verification satisfied (the API publish
     succeeded, so the prerequisite holds).
- v1.2.1 uploaded and submitted for review (PENDING_REVIEW, 2026-08-14);
  the store listing shows the new version once Google's review approves.
  The pipeline was unblocked by PR #13 (UploadState `SUCCEEDED` fix) after
  the script's first real upload failed its own cleanliness check.

## Next Up

- See `docs/roadmap.md` for the backlog; nothing pending in the publishing
  pipeline.
