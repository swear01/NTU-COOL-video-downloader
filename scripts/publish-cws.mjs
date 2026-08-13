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

function fail(message) {
  console.error(`publish-cws: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { upload: null, publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--upload') {
      args.upload = argv[i + 1];
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

async function waitForUpload(name, headers, initialState) {
  let state = initialState;
  for (let attempt = 0; attempt < 10 && state === 'UPLOAD_IN_PROGRESS'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const statusResponse = await fetch(`${API}/v2/${name}:fetchStatus`, { headers });
    const status = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) {
      fail(`fetchStatus failed (${statusResponse.status}): ${JSON.stringify(status)}`);
    }
    state = status.uploadState;
    console.log(`Upload state: ${state}`);
  }
  if (state !== 'UPLOADED') {
    fail(`package did not upload cleanly: ${state ?? 'unknown'}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publisherId = process.env.CWS_PUBLISHER_ID;
  if (!publisherId) fail('CWS_PUBLISHER_ID is not set');
  if (!args.upload) fail('--upload <zip> is required');
  if (!process.env.CI && args.upload === 'release/*.zip') {
    fail('refusing a literal glob outside CI; pass the actual ZIP path');
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
  // Reading the release ZIP and sending it to the store is the whole purpose
  // of this script; the CodeQL "file data in outbound network request"
  // finding for this call is expected behavior.
  const zip = await readFile(args.upload);
  console.log(`Uploading ${args.upload} (${zip.length} bytes) to ${name} ...`);

  const uploadResponse = await fetch(`${API}/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: zip,
  });
  const uploaded = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok) {
    fail(`upload failed (${uploadResponse.status}): ${JSON.stringify(uploaded)}`);
  }
  const uploadState = uploaded.uploadState ?? 'unknown';
  console.log(`Upload state: ${uploadState}`);
  if (uploadState === 'UPLOAD_IN_PROGRESS') {
    await waitForUpload(name, headers, uploadState);
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
  });
  const published = await publishResponse.json().catch(() => ({}));
  if (!publishResponse.ok) {
    fail(`publish failed (${publishResponse.status}): ${JSON.stringify(published)}`);
  }
  console.log(`Published: state=${published.state ?? 'unknown'} itemId=${published.itemId ?? ITEM_ID}`);
}

main().catch(error => fail(error.message));
