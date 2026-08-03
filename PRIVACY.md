# Privacy Policy

Effective date: August 3, 2026

NTU COOL Video Downloader downloads native NTU COOL videos that the user is already authorized to access. All processing occurs locally in the user's browser.

## Data handled

The extension temporarily handles:

- The active tab title, used only to create the MP4 filename.
- Direct NTU COOL video-page URLs pasted into the batch page, and those pages' titles, used only to run the requested queue and name its files.
- Signed NTU COOL media URLs requested from `*.dlc.ntu.edu.tw`, used only to download the selected video.
- Video and audio fragments, used only to assemble the requested MP4 locally.
- Temporary download status and signed URL metadata in `chrome.storage.session`.

The extension does not read or store passwords, authentication cookies, payment information, personal communications, or general browsing history.

## Collection, transmission, and sharing

The developer does not collect, receive, transmit, sell, or share user data. The extension communicates only with the NTU COOL media hosts needed for its user-facing download function. It has no analytics, telemetry, advertising, tracking, or developer-operated server.

## Storage and retention

Temporary status, batch links, page titles, and signed media URLs stay in the browser's session storage. Batch discovery tabs close after the native manifest is found or the wait times out. Generated MP4 object URLs are revoked after the browser download completes, is interrupted, or fails. Closing the browser clears remaining session storage.

## Permissions

- `activeTab`: reads the current tab title after the user opens the extension.
- `alarms`: ends batch discovery when a page does not expose a native video.
- `contextMenus`: provides the user-invoked shortcut to the batch-download page.
- `webRequest`: detects native NTU COOL `manifest.mpd` requests without modifying traffic.
- `storage`: preserves temporary manifest, job, and batch-queue state across service-worker suspension.
- `offscreen`: downloads and assembles the MP4 after the popup closes.
- `downloads`: sends the completed MP4 to the browser download manager.
- `https://*.dlc.ntu.edu.tw/*`: limits network access to NTU COOL media hosts.
- Optional `https://cool.ntu.edu.tw/*`: requested only when the user starts a batch, to open the pasted video pages and read their titles.

The use of information received through browser APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the extension's single user-facing purpose.

## Changes and contact

Material changes to this policy will be published with the corresponding extension update. Questions can be submitted through the project's [GitHub Issues](https://github.com/swear01/NTU-COOL-video-downloader/issues).
