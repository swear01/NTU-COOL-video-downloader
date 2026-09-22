# NTU COOL Video Downloader

[![CI](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/ci.yml)
[![CodeQL](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/codeql.yml/badge.svg)](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/codeql.yml)
[![Latest release](https://img.shields.io/github/v/release/swear01/NTU-COOL-video-downloader)](https://github.com/swear01/NTU-COOL-video-downloader/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[繁體中文](README.zh-TW.md)

[Privacy Policy](PRIVACY.md)

A small Chromium extension for downloading native NTU COOL videos as MP4 files. It uses the session that is already open in the browser; there is no login automation, helper application, or developer-operated service.

## Features

- Captures the current signed DASH manifest without reading cookies.
- Selects the highest video resolution offered by NTU COOL and includes audio.
- Downloads fragments in parallel with automatic concurrency from 4 to 32 per video (up to 64 across two videos).
- Combines H.264 video and AAC audio entirely in the browser.
- Sends the finished MP4 to the browser's normal download manager.
- Downloads a pasted list of direct NTU COOL video-page links, with up to two videos at a time. Popup downloads share those slots and wait automatically when both are busy.
- Provides English and Traditional Chinese interfaces.
- Keeps each tab isolated and clears captured URLs when the tab navigates or closes.

## Support

The same extension works on Windows, macOS, and Linux in Chrome 116 or newer, Brave, Edge, and other compatible Chromium browsers. Its interfaces follow the operating system's light or dark appearance.

It supports the current native NTU COOL DASH player. YouTube embeds, login automation, Firefox, Safari, and other streaming formats are outside its scope.

Other downloader extensions (for example image or video downloaders) coexist with this one. This extension registers its filename listener only while one of its own MP4s is being saved, and it never suggests a filename for a download it did not start, so it does not override file names chosen by other downloader extensions.

## Install

1. Download the ZIP and `SHA256SUMS` from the [latest release](https://github.com/swear01/NTU-COOL-video-downloader/releases/latest), then extract the ZIP into a new folder.
2. Open the browser's extensions page, such as `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.

## Use

1. Sign in to NTU COOL normally.
2. Open a native video and wait for the player to load.
3. Open the extension and click **Download video**.
4. Keep the browser open while the extension downloads and combines the fragments.

The MP4 appears in the browser's normal download manager when processing finishes. The browser's existing download-location preference is respected.

For batch download, click the extension icon and select **Open COOL batch downloader** in the popup, or use the same entry in the icon's right-click menu. Paste direct video-page links, one per line, then select **Start**. **Pause** suspends both active transfers and **Stop** cancels the queue. Completed and failed results remain visible after Stop. Expand a video row for its error stage, HTTP status, track, segment, and retry count. Use **Copy failed URLs**, **Copy error report**, or **Export JSON report** to keep a snapshot; if clipboard access fails, a selectable text box appears. **Retry failed videos** obtains fresh authorization only for failed videos, preserving successful results. During retries, the counter, progress bar, and summary count only the videos in that attempt; original list numbers and prior results remain visible. Up to two videos run concurrently, so the next source lookup overlaps an active download. Each active video has its own progress and speed. Popup downloads and batch transfers share a two-slot queue: extra requests wait instead of failing, and a slot stays occupied until browser saving finishes. Batch Pause/Stop also controls its waiting transfers without affecting popup downloads. Batch downloads resolve each video through COOL authorization and metadata requests without opening video tabs. The latest report is saved locally across browser restarts; downloads do not resume automatically.

Batch mode supports direct `/courses/.../modules/items/...` links only.

## Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `activeTab` | Reads the active tab title only after the extension is opened, for the MP4 filename. |
| `alarms` | Limits each batch source lookup to 30 seconds. |
| `contextMenus` | Adds the user-invoked shortcut that opens the batch-download page. |
| `webRequest` | Detects `manifest.mpd` requests from the native player. It does not modify network traffic. |
| `storage` | Keeps temporary manifest, job, and batch-queue state in memory-backed `storage.session` so service-worker suspension does not lose it; saves the latest sanitized batch report in `storage.local`. |
| `offscreen` | Runs the download and MP4 assembly after the popup closes. |
| `downloads` | Hands the completed MP4 to the browser download manager. |
| `https://*.dlc.ntu.edu.tw/*` | Accesses NTU video authorization, metadata, and media hosts. |
| Optional `https://cool.ntu.edu.tw/*` | Granted only after the user starts a batch, so the extension can fetch the pasted pages with the existing login and obtain fresh video authorization. |

The extension cannot read or export cookies or passwords and has no access to general browsing history or unrelated websites. The browser supplies the existing login cookies for authorized COOL requests. Batch mode temporarily parses COOL-provided LTI fields, which may include a name, email address, account identifiers, and an authorization signature, and posts them only to the official video service. The fields are not persisted or sent to the developer. It has no analytics, telemetry, advertising, or remote code. Signed source URLs remain in temporary session state; persistent reports omit them.

## Release safety and verification

Every pull request and release runs the test suite, npm dependency audit, CodeQL analysis, and a ClamAV scan. Release ZIPs and their checksum file receive a GitHub artifact attestation backed by Sigstore, so the files can be verified as products of this repository's release workflow.

Verify the checksum after downloading both release files:

```sh
sha256sum --check SHA256SUMS       # Linux
shasum -a 256 --check SHA256SUMS  # macOS
```

On Windows, run `Get-FileHash .\NTU-COOL-video-downloader-1.2.8.zip -Algorithm SHA256` in PowerShell and compare it with `SHA256SUMS`.

Verify the signed build provenance with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify NTU-COOL-video-downloader-1.2.8.zip \
  --repo swear01/NTU-COOL-video-downloader
```

Use the version number shown by the release you downloaded. Workflow actions are pinned to exact commits, the release contains only the files needed at runtime, and the full source is available for inspection. Because Chrome normally restricts self-hosted extension installation on Windows and macOS, this project distributes a verifiable ZIP for **Load unpacked** instead of claiming that a self-signed CRX works everywhere.

## Development

```sh
npm install
npm test
npm run package
```

MP4Box.js 2.4.1 is the only runtime dependency. Its browser modules and BSD-3-Clause license are vendored under `vendor/`, so users do not need Node.js or npm. All other code uses browser APIs and the JavaScript standard library.

The generated ZIP follows Chrome's package layout with `manifest.json` at the archive root. The same ZIP can be uploaded to a compatible extension dashboard or extracted for **Load unpacked** installation.

This independent project is not affiliated with or endorsed by National Taiwan University. The NTU COOL name and logo belong to their respective owner and are used only to identify compatibility.

## License

This project is available under the MIT License. See `LICENSE`. MP4Box.js licensing is included in `vendor/MP4Box.LICENSE`.
