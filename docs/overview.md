# Overview

A small Chromium extension (Manifest V3) that downloads native NTU COOL
course videos as MP4 files. It captures the signed DASH manifest of the
video the user is already authorized to watch, downloads the video/audio
fragments in parallel inside an offscreen document, remuxes them with
MP4Box entirely in the browser, and hands the finished MP4 to the browser's
normal download manager.

The popup links directly to the batch page, independently of video detection
and the background worker; the action context menu remains another entry.
Batch mode fetches each COOL module page with the existing login, submits its
fresh LTI form, and reads the authorized player metadata in the offscreen
document. It opens no per-video tabs. Stop and the 30-second discovery timeout
abort source requests; authorization errors are shown per video.
Batch mode preserves selectable per-video results and structured errors, with
copy/export and failed-only retry. The latest sanitized report is saved locally
from the start of a batch and at state transitions; after a browser restart,
unfinished entries are shown as canceled rather than automatically resumed.

- Store listing: **NTU COOL Video Downloader** (item ID
  `hbmhcpfcjdbgokaloffibmehefkdjdap`), Chinese (Traditional) primary
  language, Tools category.
- Repo: `swear01/NTU-COOL-video-downloader` (this is the canonical project).
- Upstream `willychen0146/NTU-COOL-video-downloader` is a divergent legacy
  codebase (v1.0.0, no downloads API usage). Never target it for PRs.
- Cloud: Chrome Web Store API is enabled on GCP project
  `gemini-github-review-503915`; service account
  `cws-publisher@gemini-github-review-503915.iam.gserviceaccount.com`
  publishes the store item. The private key is NOT in this repository
  (local copy: `~/.config/cws-publish/cws-publisher.json`).

Out of scope: YouTube embeds, login automation, Firefox/Safari, DRM.
