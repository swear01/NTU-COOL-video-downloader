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

test('reports download speed while fragments complete', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = performance.now;
  let now = 0;
  performance.now = () => now;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => {
      now += 1000;
      return new ArrayBuffer(2048);
    }
  });
  const updates = [];

  try {
    await downloadAdaptive(
      [{ url: 'a' }],
      () => {},
      progress => updates.push(progress)
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].completed, 1);
    assert.equal(updates[0].total, 1);
    assert.equal(updates[0].bytesPerSecond, 2048);
  } finally {
    globalThis.fetch = originalFetch;
    performance.now = originalNow;
  }
});

test('blends reported speed after a measurement window resets', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = performance.now;
  let now = 0;
  let started = 0;
  let gate = Promise.resolve();
  performance.now = () => now;
  // Serialize fragments so the post-reset leftover timing is deterministic.
  globalThis.fetch = () => new Promise(resolve => {
    gate = gate.then(() => {
      started += 1;
      const delay = started <= 16 ? 1000 : 1;
      resolve({
        ok: true,
        arrayBuffer: async () => {
          now += delay;
          return new ArrayBuffer(1024);
        }
      });
    });
  });
  const updates = [];

  try {
    await downloadAdaptive(
      Array.from({ length: 17 }, (_, index) => ({ url: `fragment-${index}` })),
      () => {},
      progress => updates.push(progress.bytesPerSecond)
    );
    assert.equal(updates[15], 1024);
    assert.equal(updates[16], Math.round(1024 * (15 / 16) + (1024 / 0.001) * (1 / 16)));
  } finally {
    globalThis.fetch = originalFetch;
    performance.now = originalNow;
  }
});

test('reports the failed segment and does not retry an MP4 consumer failure', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  try {
    globalThis.fetch = async () => { attempts++; return { ok: false, status: 404 }; };
    const task = { kind: 'video', index: 294, url: 'https://media.example/video-295.m4s' };
    await assert.rejects(downloadAdaptive([task], () => {}), error => {
      assert.equal(error.httpStatus, 404);
      assert.equal(error.segment, 295);
      assert.equal(error.attempts, 3);
      assert.equal(error.resource, task.url);
      return true;
    });
    attempts = 0;
    globalThis.fetch = async () => { attempts++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; };
    await assert.rejects(downloadAdaptive([task], () => { throw new RangeError('Array buffer allocation failed'); }), RangeError);
    assert.equal(attempts, 1);
  } finally { globalThis.fetch = originalFetch; }
});


test('does not finish before the final asynchronous progress report settles', async () => {
  const originalFetch = globalThis.fetch;
  let rejectReport;
  let reports = 0;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  try {
    const result = downloadAdaptive([{ url: 'a' }, { url: 'b' }], () => {}, () => {
      if (++reports === 1) return new Promise((_, reject) => { rejectReport = reject; });
    });
    const checked = assert.rejects(result, /Report unavailable/);
    await new Promise(resolve => setTimeout(resolve, 0));
    rejectReport(new Error('Report unavailable'));
    await checked;
  } finally { globalThis.fetch = originalFetch; }
});
