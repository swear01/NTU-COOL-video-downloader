# NTU COOL Video Downloader

[繁體中文](README.zh-TW.md)

A small Chromium extension for downloading native NTU COOL videos as MP4 files. It uses the session that is already open in the browser; there is no login automation, helper application, or external service.

## Features

- Captures the current signed DASH manifest without reading cookies.
- Selects the highest video resolution offered by NTU COOL and includes audio.
- Downloads fragments in parallel with automatic concurrency from 4 to 64.
- Combines H.264 video and AAC audio entirely in the browser.
- Sends the finished MP4 to the browser's normal download manager.
- Keeps each tab isolated and clears captured URLs when the tab navigates or closes.

## Support

The same extension works on Windows, macOS, and Linux in current versions of Chrome, Brave, Edge, and other Chromium browsers with Manifest V3 offscreen-document support.

It supports the current native NTU COOL DASH player. YouTube embeds, login automation, Firefox, Safari, and other streaming formats are outside its scope.

## Install

1. Download and unzip the release package.
2. Open the browser's extensions page, such as `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.

## Use

1. Sign in to NTU COOL normally.
2. Open a native video and wait for the player to load.
3. Open the extension and click **Download video**.
4. Keep the browser open while the extension downloads and combines the fragments.

The MP4 appears in the browser's normal download manager when processing finishes. The browser's existing download-location preference is respected.

## Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `activeTab` | Reads the active tab title only after the extension is opened, for the MP4 filename. |
| `webRequest` | Detects `manifest.mpd` requests from the native player. It does not modify network traffic. |
| `storage` | Keeps the latest manifest URL in memory-backed `storage.session` so service-worker suspension does not lose it. |
| `offscreen` | Runs the download and MP4 assembly after the popup closes. |
| `downloads` | Hands the completed MP4 to the browser download manager. |
| `https://*.dlc.ntu.edu.tw/*` | Limits network access to NTU's video-player and media hosts. |

The extension has no access to general browsing history, cookies, passwords, or unrelated websites. It has no analytics, telemetry, advertising, or remote code. Captured signed URLs remain inside the browser session and are removed when the tab navigates or closes.

## Development

```sh
npm install
npm test
```

MP4Box.js 2.4.1 is the only runtime dependency. Its browser modules and BSD-3-Clause license are vendored under `vendor/`, so users do not need Node.js or npm. All other code uses browser APIs and the JavaScript standard library.

## License

This project is available under the MIT License. See `LICENSE`. MP4Box.js licensing is included in `vendor/MP4Box.LICENSE`.
