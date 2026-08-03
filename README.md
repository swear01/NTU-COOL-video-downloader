# NTU COOL Video Downloader

[![CI](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/ci.yml)
[![CodeQL](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/codeql.yml/badge.svg)](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/codeql.yml)
[![Latest release](https://img.shields.io/github/v/release/swear01/NTU-COOL-video-downloader)](https://github.com/swear01/NTU-COOL-video-downloader/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[繁體中文](README.zh-TW.md)

[Privacy Policy](PRIVACY.md)

A small Chromium extension for downloading native NTU COOL videos as MP4 files. It uses the session that is already open in the browser; there is no login automation, helper application, or external service.

## Features

- Captures the current signed DASH manifest without reading cookies.
- Selects the highest video resolution offered by NTU COOL and includes audio.
- Downloads fragments in parallel with automatic concurrency from 4 to 64.
- Combines H.264 video and AAC audio entirely in the browser.
- Sends the finished MP4 to the browser's normal download manager.
- Downloads a pasted list of direct NTU COOL video-page links one at a time.
- Provides English and Traditional Chinese interfaces.
- Keeps each tab isolated and clears captured URLs when the tab navigates or closes.

## Support

The same extension works on Windows, macOS, and Linux in Chrome 116 or newer, Brave, Edge, and other compatible Chromium browsers. Its interfaces follow the operating system's light or dark appearance.

It supports the current native NTU COOL DASH player. YouTube embeds, login automation, Firefox, Safari, and other streaming formats are outside its scope.

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

For batch download, right-click the extension icon and choose **Open COOL batch downloader**. Paste direct video-page links, one per line, then select **Start**. **Pause** suspends the active transfer and **Stop** cancels the queue. Batch mode supports direct `/courses/.../modules/items/...` links only.

## Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `activeTab` | Reads the active tab title only after the extension is opened, for the MP4 filename. |
| `alarms` | Stops waiting for a batch page that does not expose a native video. |
| `contextMenus` | Adds the user-invoked shortcut that opens the batch-download page. |
| `webRequest` | Detects `manifest.mpd` requests from the native player. It does not modify network traffic. |
| `storage` | Keeps temporary manifest, job, and batch-queue state in memory-backed `storage.session` so service-worker suspension does not lose it. |
| `offscreen` | Runs the download and MP4 assembly after the popup closes. |
| `downloads` | Hands the completed MP4 to the browser download manager. |
| `https://*.dlc.ntu.edu.tw/*` | Limits network access to NTU's video media hosts. |
| Optional `https://cool.ntu.edu.tw/*` | Granted only after the user starts a batch, so the extension can open the pasted pages and read their titles. |

The extension has no access to general browsing history, cookies, passwords, or unrelated websites. It has no analytics, telemetry, advertising, or remote code. Captured signed URLs remain inside the browser session and are removed when the tab navigates or closes.

## Release safety and verification

Every pull request and release runs the test suite, npm dependency audit, CodeQL analysis, and a ClamAV scan. Release ZIPs and their checksum file receive a GitHub artifact attestation backed by Sigstore, so the files can be verified as products of this repository's release workflow.

Verify the checksum after downloading both release files:

```sh
sha256sum --check SHA256SUMS       # Linux
shasum -a 256 --check SHA256SUMS  # macOS
```

On Windows, run `Get-FileHash .\NTU-COOL-video-downloader-1.2.0.zip -Algorithm SHA256` in PowerShell and compare it with `SHA256SUMS`.

Verify the signed build provenance with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify NTU-COOL-video-downloader-1.2.0.zip \
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
