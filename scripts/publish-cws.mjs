#!/usr/bin/env node
// Uploads the packaged extension ZIP to the Chrome Web Store and optionally
// submits it for review, using the Chrome Web Store API V2.
//
// Requirements (one-time setup, see store/publishing.md):
//   1. A Google Cloud service account with the Chrome Web Store API enabled.
//   2. The service account email added in the Chrome Web Store Developer
//      Dashboard under Account, with a role that can upload and publish.
//   3. The publisher ID from the Developer Dashboard (Publisher > Settings).
//
// Usage:
//   CWS_SERVICE_ACCOUNT=<json> CWS_PUBLISHER_ID=<id> \
//     node scripts/publish-cws.mjs --upload release/*.zip [--publish]
//
// Environment variables:
//   CWS_SERVICE_ACCOUNT  Service account key as a JSON string (or base64).
//   CWS_PUBLISHER_ID     Publisher ID from the developer dashboard.
//   CWS_ITEM_ID          Store item ID (defaults to this extension).
//
// The script fails when the uploaded package does not report a clean
// upload state, so a broken release never reaches the store review queue.

import { readFile } from 'node:fs/promises';
import { JWT } from 'google-auth-library';

const ITEM_ID = process.env.CWS_ITEM_ID ?? 'hbmhcpfcjdbgokaloffibmehefkdjdap';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API = 'https://chromewebstore.googleapis.com';
const REQUEST_TIMEOUT_MS = 60_000;
const SUBMITTED_STATES = ['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'];

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22) {
  fail(`requires Node.js 22+ (found ${process.versions.node})`);
}

function fail(message) {
  console.error(`publish-cws: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { upload: null, publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--upload') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail('--upload requires a ZIP path');
      args.upload = value;
      i += 1;
    } else if (argv[i] === '--publish') {
      args.publish = true;
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

async function readServiceAccount() {
  const raw = process.env.CWS_SERVICE_ACCOUNT;
  if (!raw) fail('CWS_SERVICE_ACCOUNT is not set');
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      fail('CWS_SERVICE_ACCOUNT must be a service account key as JSON or base64');
    }
  }
}

async function fetchItemStatus(name, headers) {
  const statusResponse = await fetch(`${API}/v2/${name}:fetchStatus`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const status = await statusResponse.json().catch(() => ({}));
  if (!statusResponse.ok) {
    fail(`fetchStatus failed (${statusResponse.status}): ${JSON.stringify(status)}`);
  }
  return status;
}

async function waitForUpload(name, headers) {
  let state = 'UPLOAD_IN_PROGRESS';
  const deadline = Date.now() + 5 * 60_000;
  // Larger packages can take a while to process; five minutes stays well
  // within the release job's 30-minute budget.
  while (Date.now() < deadline && state === 'UPLOAD_IN_PROGRESS') {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const remaining = Math.max(1_000, deadline - Date.now());
    try {
      const statusResponse = await fetch(`${API}/v2/${name}:fetchStatus`, {
        headers,
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
      const status = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) {
        if (statusResponse.status >= 500) {
          console.log(`fetchStatus transient error ${statusResponse.status}, retrying ...`);
          continue;
        }
        fail(`fetchStatus failed (${statusResponse.status}): ${JSON.stringify(status)}`);
      }
      state = status.uploadState;
      console.log(`Upload state: ${state}`);
    } catch (error) {
      console.log(`fetchStatus network error, retrying ... (${error.message})`);
    }
  }
  if (state !== 'UPLOADED') {
    fail(`package did not upload cleanly: ${state ?? 'unknown'}`);
  }
}

function revisionVersion(revision) {
  // The v2 fetchStatus reference places crxVersion on the revision's
  // distribution channels; check the top-level field too in case the API
  // surface changes.
  if (!revision) return null;
  if (revision.crxVersion) return revision.crxVersion;
  return revision.distributionChannels?.find(channel => channel.crxVersion)?.crxVersion ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publisherId = process.env.CWS_PUBLISHER_ID;
  if (!publisherId) fail('CWS_PUBLISHER_ID is not set');
  if (!args.upload) fail('--upload <zip> is required');
  if (!process.env.CI && args.upload === 'release/*.zip') {
    fail('refusing a literal glob outside CI; pass the actual ZIP path');
  }
  if (!/^[a-z]{32}$/.test(ITEM_ID)) {
    fail(`CWS_ITEM_ID must be a 32-character lowercase store item ID, got: ${ITEM_ID}`);
  }

  const credentials = await readServiceAccount();
  const client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [SCOPE],
  });
  await client.authorize();

  const name = `publishers/${publisherId}/items/${ITEM_ID}`;
  const headers = { Authorization: `Bearer ${client.credentials.access_token}` };

  let version;
  try {
    version = JSON.parse(await readFile('./manifest.json', 'utf8')).version;
  } catch {
    fail('cannot read ./manifest.json; run the script from the repository root');
  }

  // If the store already accepted this manifest version but the response was
  // lost (connection drop after accept), a rerun must treat it as success
  // instead of failing to upload the same version again.
  const status = await fetchItemStatus(name, headers);
  const submitted = status.submittedItemRevisionStatus;
  const alreadySubmitted = submitted && SUBMITTED_STATES.includes(submitted.state)
    && revisionVersion(submitted) === version;
  if (alreadySubmitted) {
    console.log(`Version ${version} is already submitted (${submitted.state}); nothing to do.`);
    return;
  }

  // Reading the release ZIP and sending it to the store is the whole purpose
  // of this script; the CodeQL "file data in outbound network request"
  // finding for this call is expected behavior. The bare POST to the
  // /upload/ path is the documented media-upload protocol for this API
  // (developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload).
  const zip = await readFile(args.upload);
  console.log(`Uploading ${args.upload} (${zip.length} bytes) to ${name} ...`);

  const uploadResponse = await fetch(`${API}/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: zip,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const uploaded = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok) {
    fail(`upload failed (${uploadResponse.status}): ${JSON.stringify(uploaded)}`);
  }
  const uploadState = uploaded.uploadState ?? 'unknown';
  console.log(`Upload state: ${uploadState}`);
  if (uploadState === 'UPLOAD_IN_PROGRESS') {
    await waitForUpload(name, headers);
  } else if (uploadState !== 'UPLOADED') {
    fail(`package did not upload cleanly: ${JSON.stringify(uploaded)}`);
  }

  if (!args.publish) {
    console.log('Upload complete. Re-run with --publish to submit for review.');
    return;
  }

  console.log('Submitting for review ...');
  const publishResponse = await fetch(`${API}/v2/${name}:publish`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const published = await publishResponse.json().catch(() => ({}));
  if (!publishResponse.ok) {
    fail(`publish failed (${publishResponse.status}): ${JSON.stringify(published)}`);
  }
  console.log(`Published: state=${published.state ?? 'unknown'} itemId=${published.itemId ?? ITEM_ID}`);
}

main().catch(error => fail(error.message));
