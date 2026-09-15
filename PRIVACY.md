# Privacy Policy

Effective date: September 15, 2026

NTU COOL Video Downloader downloads native NTU COOL videos that the user is already authorized to access. Video assembly occurs locally in the user's browser; authorization and media requests go to NTU COOL services.

## Data handled

The extension temporarily handles:

- The active tab title, used only to create the MP4 filename.
- Direct NTU COOL video-page URLs pasted into the batch page, and those pages' titles, used only to run the requested queue and name its files.
- Signed NTU COOL media URLs requested from `*.dlc.ntu.edu.tw`, used only to download the selected video.
- COOL-provided module HTML and signed LTI authorization fields, which may include account identifiers, name, email address, course roles, and an authorization signature. These fields are forwarded only to the official COOL video launch endpoint to authorize the requested video.
- Video and audio fragments, used only to assemble the requested MP4 locally.
- Temporary download status and signed URL metadata in `chrome.storage.session`.

The extension does not read or store passwords, authentication cookies, payment information, personal communications, or general browsing history.

## Collection, transmission, and sharing

No user data is sent to the developer or sold. The extension fetches the requested module pages from `cool.ntu.edu.tw` using the existing browser login, posts the platform-provided LTI form to the validated `cool-video.dlc.ntu.edu.tw` launch endpoint, follows the authorization redirect, and reads video metadata and media from official COOL services under `dlc.ntu.edu.tw`. The browser supplies authentication cookies for these credentialed requests; the extension does not read or export cookie values. It has no analytics, telemetry, advertising, tracking, or developer-operated server.

## Storage and retention

Temporary status, batch links, page titles, and signed media URLs stay in the browser's session storage. Batch source discovery runs in the offscreen document without opening video tabs. Module HTML and LTI fields are kept only in memory for the current lookup, then become eligible for cleanup; they are not saved to storage or reports. Stop and the 30-second discovery timeout abort pending source requests. Generated MP4 object URLs are revoked after the browser download completes, is interrupted, or fails. Closing the browser clears remaining session storage. The latest batch report is retained in `chrome.storage.local` across restarts: page URLs, titles, completion states, and diagnostic details. Media URL query strings, fragments, and credentials are removed before reporting; signed manifests and MP4 data are not saved in this report. Each new report replaces the previous report; removing the extension clears it. Reports are exported or copied only when the user requests it and are never sent to the developer.

## Permissions

- `activeTab`: reads the current tab title after the user opens the extension.
- `alarms`: limits each batch source lookup to 30 seconds.
- `contextMenus`: provides the user-invoked shortcut to the batch-download page.
- `webRequest`: detects native NTU COOL `manifest.mpd` requests without modifying traffic.
- `storage`: preserves temporary manifest, job, and batch-queue state across service-worker suspension, and retains the latest sanitized batch report locally.
- `offscreen`: parses the authorization form, resolves the source, and downloads/assembles the MP4 after the popup closes.
- `downloads`: sends the completed MP4 to the browser download manager.
- `https://*.dlc.ntu.edu.tw/*`: permits NTU COOL video authorization, metadata, and media requests.
- Optional `https://cool.ntu.edu.tw/*`: requested only when the user starts a batch, to fetch the pasted video pages with the existing login and obtain fresh video authorization.

The use of information received through browser APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the extension's single user-facing purpose.

## Changes and contact

Material changes to this policy will be published with the corresponding extension update. Questions can be submitted through the project's [GitHub Issues](https://github.com/swear01/NTU-COOL-video-downloader/issues).
