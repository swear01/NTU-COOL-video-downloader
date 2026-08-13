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
//     node scripts/publish-cws.mjs --upload release/NTU-COOL-video-downloader-1.2.1.zip [--publish]
//
// Environment variables:
//   CWS_SERVICE_ACCOUNT  Service account key as a JSON string (or base64).
//   CWS_PUBLISHER_ID     Publisher ID from the developer dashboard.
//   CWS_ITEM_ID          Store item ID (defaults to this extension).
//
// The script fails when the uploaded package does not report a clean
// upload state or reports an item error, so a broken release never reaches
// the store review queue.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JWT } from 'google-auth-library';

const ITEM_ID = process.env.CWS_ITEM_ID ?? 'hbmhcpfcjdbgokaloffibmehefkdjdap';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API = 'https://chromewebstore.googleapis.com';
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_BUDGET_MS = 5 * 60_000;
// States that mean the store has accepted the submitted revision; a rerun
// that finds its manifest version in one of these must not re-upload it.
const SUBMITTED_STATES = ['PENDING_REVIEW', 'IN_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'];

class PublishError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22) {
  throw new PublishError(`requires Node.js 22+ (found ${process.versions.node})`);
}

export function parseArgs(argv) {
  const args = { upload: null, publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--upload') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new PublishError('--upload requires a ZIP path');
      args.upload = value;
      i += 1;
    } else if (argv[i] === '--publish') {
      args.publish = true;
    } else {
      throw new PublishError(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

export function isGlobPath(path) {
  return /[*?[]/.test(path);
}

export function readServiceAccount(raw) {
  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new PublishError('CWS_SERVICE_ACCOUNT must be a service account key as JSON or base64');
    }
  }
  if (typeof credentials.client_email !== 'string' || credentials.client_email.length === 0) {
    throw new PublishError('service account key is missing client_email');
  }
  if (typeof credentials.private_key !== 'string' || credentials.private_key.length === 0) {
    throw new PublishError('service account key is missing private_key');
  }
  return credentials;
}

// The v2 fetchStatus reference places crxVersion on the revision's
// distribution channels; check the top-level field too in case the API
// surface changes.
export function revisionVersion(revision) {
  if (!revision) return null;
  if (revision.crxVersion) return revision.crxVersion;
  const channels = revision.distributionChannels;
  return Array.isArray(channels)
    ? channels.find(channel => channel.crxVersion)?.crxVersion ?? null
    : null;
}

// Extension versions are dotted numeric strings; compare numerically.
// Versions with non-numeric segments are incomparable and treated as equal
// so they never wrongly supersede or block a release.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// The store already carries a newer submitted or published revision, so an
// older tag's rerun must not try to upload or publish (the store rejects
// non-advancing versions anyway).
export function isSuperseded(status, version) {
  const item = itemStatus(status);
  const revisions = [item?.submittedItemRevisionStatus, item?.publishedItemRevisionStatus];
  return revisions.some(revision => {
    const storeVersion = revisionVersion(revision);
    return storeVersion != null && compareVersions(storeVersion, version) > 0;
  });
}

// The reference documents the item status as top-level response fields, but
// real responses have also been observed nested under an itemStatus array;
// accept both shapes.
export function itemStatus(response) {
  return response?.itemStatus?.[0] ?? response;
}

export function isAlreadySubmitted(status, version) {
  const item = itemStatus(status);
  const revisions = [item?.submittedItemRevisionStatus, item?.publishedItemRevisionStatus];
  return revisions.some(revision =>
    revision && SUBMITTED_STATES.includes(revision.state) && revisionVersion(revision) === version);
}

export function hasItemErrors(item) {
  // itemError may be a single object or an array; explicit empty containers
  // must not count as a validation failure.
  if (Array.isArray(item?.itemError)) return item.itemError.length > 0;
  if (item?.itemError && typeof item.itemError === 'object') {
    return Object.keys(item.itemError).length > 0;
  }
  return Boolean(item?.itemError);
}

async function fetchJson(url, options = {}, attempts = 3) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        // A fresh signal per attempt: an aborted signal from a timed-out
        // attempt must not poison the retry.
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Retry transient statuses before parsing the body: proxy and gateway
      // errors often carry non-JSON bodies.
      if (!response.ok && (response.status >= 500 || response.status === 429)
          && attempt < attempts - 1) {
        console.log(`transient error ${response.status}, retrying ...`);
        await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
        continue;
      }
      const text = await response.text();
      let body = {};
      if (text.trim() !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          throw new PublishError(`non-JSON response (${response.status}): ${text.slice(0, 200)}`, response.status);
        }
      }
      if (!response.ok) {
        throw new PublishError(`${url.split('/').pop()} failed (${response.status}): ${JSON.stringify(body)}`, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof PublishError) throw error;
      lastError = error;
      if (attempt < attempts - 1) {
        console.log(`network error, retrying ... (${error.message})`);
        await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
      }
    }
  }
  throw new PublishError(`request failed after ${attempts} attempts: ${lastError?.message ?? 'unknown'}`);
}

async function waitForUpload(name, headers) {
  const deadline = Date.now() + POLL_BUDGET_MS;
  let state = 'UPLOAD_IN_PROGRESS';
  // Larger packages can take a while to process; the budget stays well
  // within the release job's 30-minute limit.
  while (Date.now() < deadline && state === 'UPLOAD_IN_PROGRESS') {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const remaining = Math.max(1_000, deadline - Date.now());
    // Single attempt per poll so a hanging request can never consume time
    // beyond the deadline; transient failures continue polling instead of
    // aborting a healthy upload.
    try {
      const status = await fetchJson(`${API}/v2/${name}:fetchStatus`, {
        headers,
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
      }, 1);
      const item = itemStatus(status);
      if (hasItemErrors(item)) {
        throw new PublishError(`package has validation errors: ${JSON.stringify(item.itemError)}`);
      }
      state = item.uploadState;
      console.log(`Upload state: ${state}`);
    } catch (error) {
      // Network errors, timeouts, 5xx, and 429 are transient; keep polling
      // until the deadline. Other HTTP failures (4xx) are terminal.
      const transient = !(error instanceof PublishError)
        || error.status == null
        || error.status >= 500
        || error.status === 429;
      if (transient) {
        console.log(`transient poll failure, continuing ... (${error.message})`);
      } else {
        throw error;
      }
    }
  }
  if (state !== 'UPLOADED') {
    throw new PublishError(`package did not upload cleanly: ${state ?? 'unknown'}`);
  }
}

async function publishVersion(name, headers) {
  console.log('Submitting for review ...');
  const published = await fetchJson(`${API}/v2/${name}:publish`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  }, 1);
  console.log(`Published: state=${published.state ?? 'unknown'} itemId=${published.itemId ?? ITEM_ID}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publisherId = process.env.CWS_PUBLISHER_ID;
  if (!publisherId) throw new PublishError('CWS_PUBLISHER_ID is not set');
  if (!/^[A-Za-z0-9-]+$/.test(publisherId)) {
    throw new PublishError(`CWS_PUBLISHER_ID looks invalid: ${publisherId}`);
  }
  if (!args.upload) throw new PublishError('--upload <zip> is required');
  // The script never expands globs; require the actual ZIP path.
  if (isGlobPath(args.upload)) {
    throw new PublishError('refusing an unexpanded glob; pass the actual ZIP path');
  }
  if (!/^[a-z]{32}$/.test(ITEM_ID)) {
    throw new PublishError(`CWS_ITEM_ID must be a 32-character lowercase store item ID, got: ${ITEM_ID}`);
  }

  const credentials = readServiceAccount(process.env.CWS_SERVICE_ACCOUNT ?? '');
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
    throw new PublishError('cannot read ./manifest.json; run the script from the repository root');
  }

  // The reconciliation above must track the version that will actually be
  // uploaded, so the archive's own manifest is the source of truth. A
  // missing unzip binary degrades to a warning; a corrupt archive or a
  // missing root manifest.json is a hard error.
  const { spawnSync } = await import('node:child_process');
  const unzip = spawnSync('unzip', ['-p', args.upload, 'manifest.json'], { encoding: 'utf8' });
  if (unzip.status === 0) {
    let zipVersion;
    try {
      zipVersion = JSON.parse(unzip.stdout).version;
    } catch {
      throw new PublishError(`cannot parse manifest.json inside ${args.upload}`);
    }
    if (zipVersion !== version) {
      throw new PublishError(`ZIP version ${zipVersion} differs from ./manifest.json version ${version}`);
    }
  } else if (unzip.error?.code === 'ENOENT') {
    console.log('Warning: unzip is unavailable; skipping the ZIP manifest check.');
  } else {
    throw new PublishError(`cannot inspect ${args.upload}: ${unzip.stderr?.trim() || `unzip exited ${unzip.status}`}`);
  }

  // If the store already accepted this manifest version but the response was
  // lost (connection drop after accept), a rerun must treat it as success
  // instead of failing to upload the same version again. Revisions that are
  // staged or tester-only still need the DEFAULT_PUBLISH promotion.
  const status = await fetchJson(`${API}/v2/${name}:fetchStatus`, { headers });
  if (isSuperseded(status, version)) {
    console.log(`The store already has a newer revision than ${version}; nothing to do.`);
    return;
  }
  const submittedRevision = itemStatus(status)?.submittedItemRevisionStatus;
  if (isAlreadySubmitted(status, version)) {
    const needsPromotion = ['STAGED', 'PUBLISHED_TO_TESTERS'].includes(submittedRevision?.state)
      && revisionVersion(submittedRevision) === version;
    if (needsPromotion && args.publish) {
      console.log(`Version ${version} is ${submittedRevision.state}; promoting it ...`);
      await publishVersion(name, headers);
    } else {
      console.log(`Version ${version} is already submitted or published; nothing to do.`);
    }
    return;
  }

  // Reading the release ZIP and sending it to the store is the whole purpose
  // of this script; the CodeQL "file data in outbound network request"
  // finding for this call is expected behavior. The bare POST to the
  // /upload/ path is the documented media-upload protocol for this API
  // (developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload).
  const zip = await readFile(args.upload).catch(error => {
    throw new PublishError(`cannot read ${args.upload}: ${error.message}`);
  });
  console.log(`Uploading ${args.upload} (${zip.length} bytes) to ${name} ...`);

  const uploaded = await fetchJson(`${API}/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: zip,
    timeoutMs: 120_000,
  }, 1);
  if (hasItemErrors(uploaded)) {
    throw new PublishError(`package has validation errors: ${JSON.stringify(uploaded.itemError)}`);
  }
  const uploadState = uploaded.uploadState ?? 'unknown';
  console.log(`Upload state: ${uploadState}`);
  if (uploadState === 'UPLOAD_IN_PROGRESS') {
    await waitForUpload(name, headers);
  } else if (uploadState !== 'UPLOADED') {
    throw new PublishError(`package did not upload cleanly: ${JSON.stringify(uploaded)}`);
  }

  if (!args.publish) {
    console.log('Upload complete. Re-run with --publish to submit for review.');
    return;
  }

  await publishVersion(name, headers);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    if (error instanceof PublishError) {
      console.error(`publish-cws: ${error.message}`);
    } else {
      console.error(`publish-cws: unexpected failure: ${error?.stack ?? error}`);
    }
    process.exit(1);
  });
}
