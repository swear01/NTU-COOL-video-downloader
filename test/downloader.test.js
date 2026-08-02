import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadAdaptive } from '../utils/downloader.js';

test('aborts remaining fragment requests after a terminal failure', async () => {
  const originalFetch = globalThis.fetch;
  let failedAttempts = 0;
  let aborted = false;

  globalThis.fetch = (url, { signal }) => {
    if (url === 'fail') {
      failedAttempts += 1;
      return Promise.resolve({ ok: false, status: 500 });
    }
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true;
      reject(signal.reason);
    }, { once: true }));
  };

  try {
    await assert.rejects(downloadAdaptive([
      { url: 'fail' },
      { url: 'slow' }
    ], () => {}), /HTTP 500/);
    assert.equal(failedAttempts, 3);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries a failed early fragment before queued later fragments', async () => {
  const originalFetch = globalThis.fetch;
  const starts = [];
  let failed = false;
  globalThis.fetch = async url => {
    starts.push(url);
    if (url === 'early' && !failed) {
      failed = true;
      return { ok: false, status: 500 };
    }
    if (url !== 'early') await new Promise(resolve => setTimeout(resolve, 400));
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  };

  try {
    await downloadAdaptive([
      { url: 'early' },
      ...Array.from({ length: 9 }, (_, index) => ({ url: `later-${index}` }))
    ], () => {});
    assert.equal(starts[8], 'early');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
