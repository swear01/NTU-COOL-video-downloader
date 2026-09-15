import test from 'node:test';
import assert from 'node:assert/strict';

test('offscreen runs two transfers and routes pause, resume, and cancellation by job', async t => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; });
  let receive;
  const requests = [];
  const reports = [];
  globalThis.chrome = { runtime: {
    onMessage: { addListener(listener) { receive = listener; } },
    async sendMessage(message) { reports.push(message); }
  } };
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => {
    requests.push({ url, signal });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await import(`../offscreen/offscreen.js?two=${Date.now()}`);
  const send = (action, jobId) => receive({ target: 'offscreen', action, jobId,
    manifestUrl: `https://video.dlc.ntu.edu.tw/${jobId}/manifest.mpd` });
  const tick = () => new Promise(resolve => setTimeout(resolve));
  send('download', 'first');
  send('download', 'second');
  send('download', 'third');
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(reports[0].jobId, 'third');
  assert.match(reports[0].status.error, /Two video downloads/);
  send('pause', 'first');
  await tick();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  send('resume', 'first');
  assert.equal(requests.length, 3);
  send('cancel', 'second');
  await tick();
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(requests[2].signal.aborted, false);
  send('download', 'third');
  assert.equal(requests.length, 4);
  send('cancel', 'first');
  send('cancel', 'third');
  await tick();
  assert.ok(requests.every(request => request.signal.aborted));
  assert.equal(reports.length, 1, 'intentional cancellations do not become download failures');
});
