import test from 'node:test';
import assert from 'node:assert/strict';

test('shares two slots between batch and popup jobs, queues overflow, and controls waiting jobs', async t => {
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
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    requests.push({ url, signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await import(`../offscreen/offscreen.js?queue=${Date.now()}`);
  const send = (action, source) => receive({ target: 'offscreen', action,
    ...(typeof source === 'number' ? { tabId: source } : { jobId: source }),
    manifestUrl: `https://video.dlc.ntu.edu.tw/${source}/manifest.mpd` });
  const tick = () => new Promise(resolve => setTimeout(resolve));
  send('download', 'first');
  send('download', 'second');
  send('download', 3);
  send('download', 3);
  await tick();
  assert.equal(requests.length, 2);
  assert.deepEqual(reports.filter(message => message.tabId === 3).map(message => message.status.state), ['waiting']);
  assert.equal(reports.some(message => message.status.state === 'error'), false);
  send('pause', 'first');
  await tick();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  send('resume', 'first');
  assert.equal(requests.length, 3);
  send('cancel', 'second');
  await tick();
  assert.equal(requests.length, 4);
  assert.match(requests[3].url, /\/3\//);

  send('download', 'paused');
  send('pause', 'paused');
  send('download', 'canceled');
  send('cancel', 'canceled');
  send('download', 'next');
  await tick();
  send('cancel', 'first');
  await tick();
  assert.equal(requests.length, 5);
  assert.match(requests[4].url, /\/next\//);
  assert.equal(requests.some(request => /\/(paused|canceled)\//.test(request.url)), false);
  send('resume', 'paused');
  await tick();
  assert.equal(requests.length, 5, 'resuming a queued job must still wait for a slot');
  requests[3].resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
  await tick();
  assert.equal(reports.filter(message => message.tabId === 3 && message.status.state === 'error').length, 1);
  assert.equal(requests.length, 6, 'manifest parse failure releases its slot');
  assert.match(requests[5].url, /\/paused\//);
  send('cancel', 'next');
  send('cancel', 'paused');
  await tick();
  assert.ok(requests.filter(request => request !== requests[3]).every(request => request.signal.aborted));
  assert.equal(reports.filter(message => message.status.state === 'error').length, 1,
    'queued and active cancellations do not become failures');
});


test('reports queue admission failure instead of leaving a job preparing forever', async t => {
  const originalChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = originalChrome; });
  let receive;
  const reports = [];
  globalThis.chrome = { runtime: {
    onMessage: { addListener(listener) { receive = listener; } },
    async sendMessage(message) {
      if (message.status.state === 'waiting') throw new Error('Status channel failed.');
      reports.push(message);
    }
  } };
  await import(`../offscreen/offscreen.js?admission=${Date.now()}`);
  receive({ target: 'offscreen', action: 'download', tabId: 1, manifestUrl: 'https://video.dlc.ntu.edu.tw/test/manifest.mpd' });
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status.state, 'error');
  assert.equal(reports[0].status.errorDetails.stage, 'dispatch');
  assert.match(reports[0].status.error, /Status channel failed/);
});
