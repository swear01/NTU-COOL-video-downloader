import test from 'node:test';
import assert from 'node:assert/strict';

import { DownloadControl, downloadAdaptive } from '../utils/downloader.js';

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

test('pauses active requests and resumes unfinished fragments', async () => {
  const originalFetch = globalThis.fetch;
  const control = new DownloadControl();
  let starts = 0;
  let received = 0;
  globalThis.fetch = (_url, { signal }) => {
    starts += 1;
    if (starts > 1) return Promise.resolve({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1)
    });
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      reject(signal.reason);
    }, { once: true }));
  };

  try {
    const downloading = downloadAdaptive([{ url: 'fragment' }], () => { received += 1; }, undefined, control);
    await new Promise(resolve => setTimeout(resolve));
    control.pause();
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(received, 0);
    control.resume();
    await downloading;
    assert.equal(starts, 2);
    assert.equal(received, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancels active fragment downloads', async () => {
  const originalFetch = globalThis.fetch;
  const control = new DownloadControl();
  globalThis.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  try {
    const downloading = downloadAdaptive([{ url: 'fragment' }], () => {}, undefined, control);
    await new Promise(resolve => setTimeout(resolve));
    control.cancel();
    await assert.rejects(downloading, /canceled/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a download that was canceled before it started', { timeout: 100 }, async () => {
  const control = new DownloadControl();
  control.cancel();
  await assert.rejects(
    downloadAdaptive([{ url: 'fragment' }], () => {}, undefined, control),
    /canceled/i
  );
});

test('passes the final response URL to the fragment consumer', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    url: 'https://media.example/redirected/manifest.mpd',
    arrayBuffer: async () => new ArrayBuffer(1)
  });
  let finalUrl;

  try {
    await downloadAdaptive([{ url: 'https://media.example/manifest.mpd' }],
      (_task, _buffer, responseUrl) => { finalUrl = responseUrl; });
    assert.equal(finalUrl, 'https://media.example/redirected/manifest.mpd');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
