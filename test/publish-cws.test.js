import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAlreadySubmitted,
  isGlobPath,
  itemStatus,
  parseArgs,
  readServiceAccount,
  revisionVersion,
} from '../scripts/publish-cws.mjs';

test('parses --upload with a path and optional --publish', () => {
  assert.deepEqual(parseArgs(['--upload', 'release/a.zip']), { upload: 'release/a.zip', publish: false });
  assert.deepEqual(parseArgs(['--upload', 'release/a.zip', '--publish']), { upload: 'release/a.zip', publish: true });
});

test('rejects --upload without a path or with a flag as its value', () => {
  assert.throws(() => parseArgs(['--upload']), /requires a ZIP path/);
  assert.throws(() => parseArgs(['--upload', '--publish']), /requires a ZIP path/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('refuses unexpanded globs outside CI', () => {
  assert.equal(isGlobPath('release/*.zip'), true);
  assert.equal(isGlobPath('./release/*.zip'), true);
  assert.equal(isGlobPath('release/NTU-COOL-video-downloader-1.2.1.zip'), false);
});

test('decodes a service account key from base64 or raw JSON', () => {
  const key = { client_email: 'sa@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----' };
  assert.deepEqual(readServiceAccount(Buffer.from(JSON.stringify(key)).toString('base64')), key);
  assert.deepEqual(readServiceAccount(JSON.stringify(key)), key);
});

test('rejects service account keys without client_email or private_key', () => {
  assert.throws(() => readServiceAccount('{}'), /client_email/);
  assert.throws(() => readServiceAccount(JSON.stringify({ client_email: 'x@y' })), /private_key/);
  assert.throws(() => readServiceAccount('not json'), /JSON or base64/);
});

test('reads the submitted revision version from channels or the revision root', () => {
  assert.equal(revisionVersion({ distributionChannels: [{ crxVersion: '1.2.1' }] }), '1.2.1');
  assert.equal(revisionVersion({ crxVersion: '1.2.1' }), '1.2.1');
  assert.equal(revisionVersion(null), null);
});

test('accepts both flat and itemStatus-array response shapes', () => {
  const flat = { uploadState: 'UPLOADED' };
  const nested = { itemStatus: [{ uploadState: 'UPLOADED' }] };
  assert.equal(itemStatus(flat).uploadState, 'UPLOADED');
  assert.equal(itemStatus(nested).uploadState, 'UPLOADED');
});

test('treats a matching submitted or published revision as already done', () => {
  const flatSubmitted = {
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.2.1' }] },
  };
  assert.equal(isAlreadySubmitted(flatSubmitted, '1.2.1'), true);
  assert.equal(isAlreadySubmitted(flatSubmitted, '1.2.0'), false);

  const nestedPublished = {
    itemStatus: [{ publishedItemRevisionStatus: { state: 'PUBLISHED', crxVersion: '1.2.1' } }],
  };
  assert.equal(isAlreadySubmitted(nestedPublished, '1.2.1'), true);

  const rejected = {
    submittedItemRevisionStatus: { state: 'REJECTED', distributionChannels: [{ crxVersion: '1.2.1' }] },
  };
  assert.equal(isAlreadySubmitted(rejected, '1.2.1'), false);
});
