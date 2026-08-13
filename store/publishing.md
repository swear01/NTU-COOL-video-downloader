# Automated Chrome Web Store publishing

Every GitHub release tag (`v*`) automatically uploads the packaged ZIP to the
Chrome Web Store and submits it for review, using the Chrome Web Store API V2
with a Google Cloud service account. The step is skipped when the
`CWS_SERVICE_ACCOUNT` secret is not configured, so releases keep working
without it.

## One-time setup

### 1. Google Cloud service account

Create a service account and enable the Chrome Web Store API in a Google Cloud
project (or reuse an existing one):

```sh
gcloud services enable chromewebstore.googleapis.com --project PROJECT_ID
gcloud iam service-accounts create cws-publisher \
  --display-name "Chrome Web Store publisher" --project PROJECT_ID
gcloud iam service-accounts keys create cws-publisher.json \
  --iam-account cws-publisher@PROJECT_ID.iam.gserviceaccount.com \
  --project PROJECT_ID
```

Keep `cws-publisher.json` private. It grants whoever holds it the ability to
upload and publish this extension.

### 2. Grant the service account in the Developer Dashboard

Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
go to **Account**, and add the service account email
(`cws-publisher@PROJECT_ID.iam.gserviceaccount.com`) as a user with a role that
allows uploading and publishing. This is a dashboard-only step; there is no API
for it.

Find your **publisher ID** under **Publisher > Settings** in the same
dashboard. It is required for every API call.

### 3. Configure the publishing environment

### 3. Enable and configure store publishing

Set the repository **variable** `CWS_ENABLED` to `true`
(Settings > Secrets and variables > Actions > Variables). The store job is
skipped while this variable is unset, so a disabled configuration never
requests environment approvals.

The store job runs in the `cws-publish` environment (it is created
automatically on the first tag push). In the repository settings
(Settings > Environments > cws-publish), add the secrets there so no other
workflow or job can read them:

| Secret | Value |
| --- | --- |
| `CWS_SERVICE_ACCOUNT` | Contents of `cws-publisher.json` (base64 encoded) |
| `CWS_PUBLISHER_ID` | Publisher ID from the Developer Dashboard |

Optionally, add your GitHub account as a **required reviewer** on the
environment: every tag push then waits for your approval before the store
submission runs. Without required reviewers the submission is fully
automatic. The approval gates only the store job; the GitHub release is
created first regardless.

`CWS_ITEM_ID` defaults to this extension
(`hbmhcpfcjdbgokaloffibmehefkdjdap`) and does not need to be set.

### 4. Prerequisites for the publisher account

The Chrome Web Store requires the publisher's Google Account to have
[2-step verification](https://support.google.com/accounts/answer/185839)
enabled before API uploads are accepted.

## Manual upload and publish

Requires Node.js 22 or newer. Run from the repository root so the script can
read `manifest.json` (it checks whether the store already accepted this
version, making retries safe):

```sh
CWS_SERVICE_ACCOUNT="$(base64 < cws-publisher.json)" \
CWS_PUBLISHER_ID="<publisher-id>" \
  npm run cws:publish -- --upload release/NTU-COOL-video-downloader-<version>.zip --publish
```

Omit `--publish` to only upload the package without submitting it for review.

## Upload protocol

The script posts the raw ZIP to the media upload endpoint
`/upload/v2/publishers/{publisherId}/items/{itemId}:upload`, which is the
documented media-upload protocol for the Chrome Web Store API V2 (no
`uploadType` parameter is needed on the `/upload/` path). If the upload is
asynchronous (`UPLOAD_IN_PROGRESS`), the script polls `fetchStatus` for up to
five minutes, retrying transient network and 5xx errors. A rerun that finds
the same manifest version already submitted to the store (pending review,
staged, or published) reports success without re-uploading.

## What happens on failure

The script exits non-zero when the upload state is not clean or the API
returns an error, which fails the GitHub Actions job. A broken package never
reaches the store review queue.
