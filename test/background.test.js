import test from 'node:test';
import assert from 'node:assert/strict';

function event() {
  return { addListener(listener) { this.listener = listener; } };
}

function mockChrome(store, download = async () => 7) {
  const sent = [];
  const chromeApi = {
    storage: { session: {
      async set(values) { Object.assign(store, values); },
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(key => key in store).map(key => [key, store[key]]));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      }
    } },
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      onMessage: event(),
      async sendMessage(message) { sent.push(message); return {}; }
    },
    downloads: { download, onChanged: event() },
    webRequest: { onBeforeRequest: event() },
    tabs: { onUpdated: event(), onRemoved: event() },
    offscreen: { async createDocument() {} }
  };
  return { chromeApi, sent };
}

async function send(chromeApi, message) {
  return new Promise(resolve => chromeApi.runtime.onMessage.listener(message, {}, resolve));
}

test('restores active browser-download metadata after worker suspension', async () => {
  const store = {};
  const first = mockChrome(store);
  globalThis.chrome = first.chromeApi;
  await import(`../background/background.js?first=${Date.now()}`);
  await send(first.chromeApi, {
    target: 'background', action: 'ready', tabId: 3, filename: 'video.mp4', url: 'blob:test'
  });
  assert.deepEqual(store['download:7'], { tabId: 3, url: 'blob:test' });

  const restarted = mockChrome(store);
  globalThis.chrome = restarted.chromeApi;
  await import(`../background/background.js?second=${Date.now()}`);
  await restarted.chromeApi.downloads.onChanged.listener({ id: 7, state: { current: 'complete' } });

  assert.equal(store['download:7'], undefined);
  assert.deepEqual(store['job:3'], { state: 'complete', progress: 100 });
  assert.deepEqual(restarted.sent[0], { target: 'offscreen', action: 'release', url: 'blob:test' });
});

test('releases the MP4 blob when the browser rejects the download', async () => {
  const store = {};
  const failed = mockChrome(store, async () => { throw new Error('blocked'); });
  globalThis.chrome = failed.chromeApi;
  await import(`../background/background.js?failed=${Date.now()}`);
  await send(failed.chromeApi, {
    target: 'background', action: 'ready', tabId: 4, filename: 'video.mp4', url: 'blob:failed'
  });

  assert.deepEqual(failed.sent[0], { target: 'offscreen', action: 'release', url: 'blob:failed' });
  assert.deepEqual(store['job:4'], { state: 'error', error: 'blocked' });
});

test('sets saving state before starting a browser download', async () => {
  const store = {};
  let savingSeen = false;
  const ordered = mockChrome(store, async () => {
    savingSeen = store['job:5']?.state === 'saving';
    return 8;
  });
  globalThis.chrome = ordered.chromeApi;
  await import(`../background/background.js?ordered=${Date.now()}`);
  await send(ordered.chromeApi, {
    target: 'background', action: 'ready', tabId: 5, filename: 'video.mp4', url: 'blob:ordered'
  });
  assert.equal(savingSeen, true);
});
