# NTU COOL Video Downloader

A Chromium extension that downloads native NTU COOL DASH videos as MP4 files. It captures the video manifest from an already signed-in NTU COOL tab, downloads video and audio fragments in parallel, combines them in the browser, and sends the result to the browser's normal download manager.

## Supported browsers

- Google Chrome
- Brave
- Microsoft Edge
- Other Chromium-based desktop browsers with Manifest V3 offscreen document support

Windows, macOS, and Linux use the same extension. YouTube videos and login automation are intentionally out of scope.

## Install

1. Download and unzip the release.
2. Open the browser's extensions page.
3. Enable Developer mode.
4. Choose **Load unpacked** and select this folder.

## Use

1. Open a native NTU COOL video and wait for the player to load.
2. Open the extension.
3. Click **Download video**.
4. Keep the browser open while the extension downloads and combines the fragments. The completed MP4 is sent to the browser's normal download manager.

The extension automatically selects the highest available video quality and adjusts parallel download concurrency between 4 and 64.

## Development

```sh
npm install
npm test
```

MP4Box.js is the only runtime dependency. Its browser modules and license are vendored under `vendor/` so release users do not need Node.js or npm.

## License

MIT. See `LICENSE`. MP4Box.js is distributed under its BSD-3-Clause license in `vendor/MP4Box.LICENSE`.
