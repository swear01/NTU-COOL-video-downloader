import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

function event() {
  return {
    addListener(listener) { this.listener = listener; },
    removeListener(listener) { if (this.listener === listener) this.listener = undefined; }
  };
}

function mockChrome(store, download = async () => 7) {
  const sent = [];
  const createdTabs = [];
  const removedTabs = [];
  const alarms = [];
  const menuItems = [];
  let nextTabId = 20;
  const chromeApi = {
    storage: { local: { async get() { return { lastBatchReport: store.lastBatchReport }; }, async set(values) { Object.assign(store, structuredClone(values)); } }, session: {
      async set(values) { Object.assign(store, values); },
      async get(keys) {
        if (keys === null) return { ...store };
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(key => key in store).map(key => [key, store[key]]));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      }
    } },
    runtime: {
      getManifest: () => ({ version: '1.2.2' }),
      getURL: path => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      onInstalled: event(),
      onMessage: event(),
      async sendMessage(message) { sent.push(message); return {}; }
    },
    i18n: { getMessage: key => key },
    contextMenus: {
      async removeAll() { menuItems.length = 0; },
      create(item) { menuItems.push(item); },
      onClicked: event()
    },
    alarms: {
      create(name, info) { alarms.push({ name, info }); },
      async clear() {},
      onAlarm: event()
    },
    downloads: {
      download,
      async pause() {},
      async resume() {},
      async cancel() {},
      onChanged: event(),
      onDeterminingFilename: event()
    },
    webRequest: { onBeforeRequest: event() },
    tabs: {
      async create(properties) {
        const tab = { id: nextTabId++, title: `Video ${nextTabId}`, ...properties };
        createdTabs.push(tab);
        return tab;
      },
      async get(tabId) { return createdTabs.find(tab => tab.id === tabId); },
      async remove(tabId) { removedTabs.push(tabId); },
      async update() {},
      onUpdated: event(),
      onRemoved: event()
    },
    offscreen: { async createDocument() {} }
  };
  return { chromeApi, sent, createdTabs, removedTabs, alarms, menuItems };
}

async function send(chromeApi, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response for ${message.action}`)), 100);
    chromeApi.runtime.onMessage.listener(message, {}, value => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
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
  assert.equal(store['job:4'].error, 'blocked');
  assert.equal(store['job:4'].errorDetails.stage, 'save');
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

test('persists an offscreen dispatch failure as a terminal job', async () => {
  const store = { 'manifest:6': 'https://media.example/manifest.mpd' };
  const failed = mockChrome(store);
  failed.chromeApi.runtime.sendMessage = async () => { throw new Error('offscreen crashed'); };
  globalThis.chrome = failed.chromeApi;
  await import(`../background/background.js?dispatch=${Date.now()}`);
  await send(failed.chromeApi, { action: 'startDownload', tabId: 6, title: 'Lecture' });

  assert.equal(store['job:6'].error, 'offscreen crashed');
  assert.equal(store['job:6'].errorDetails.stage, 'dispatch');
});

test('preserves the active NTU COOL page title in the download filename', async () => {
  const store = { 'manifest:7': 'https://media.example/manifest.mpd' };
  const ready = mockChrome(store);
  globalThis.chrome = ready.chromeApi;
  await import(`../background/background.js?filename=${Date.now()}`);
  await send(ready.chromeApi, { action: 'startDownload', tabId: 7, title: '6/5 Counting 3' });

  assert.equal(ready.sent[0].filename, '6／5 Counting 3.mp4');
});

test('overrides Chrome blob filenames with the active NTU COOL page title', async () => {
  const store = {};
  const named = mockChrome(store);
  globalThis.chrome = named.chromeApi;
  await import(`../background/background.js?determining=${Date.now()}`);
  await send(named.chromeApi, {
    target: 'background', action: 'ready', tabId: 8,
    filename: '6／5 Counting 3.mp4', url: 'blob:named'
  });
  let suggestion;
  named.chromeApi.downloads.onDeterminingFilename.listener(
    { url: 'blob:named' }, value => { suggestion = value; }
  );

  assert.deepEqual(suggestion, { filename: '6／5 Counting 3.mp4', conflictAction: 'uniquify' });
});

test('registers the filename listener only while a download is pending', async () => {
  const store = {};
  const idle = mockChrome(store);
  globalThis.chrome = idle.chromeApi;
  await import(`../background/background.js?idle=${Date.now()}`);

  // With no MP4 waiting to be named, the extension must not listen to
  // onDeterminingFilename at all, so it can never fight another downloader
  // extension for a filename it does not own.
  assert.equal(idle.chromeApi.downloads.onDeterminingFilename.listener, undefined);
});

test('does not rename downloads owned by other extensions', async () => {
  const store = {};
  const busy = mockChrome(store);
  globalThis.chrome = busy.chromeApi;
  await import(`../background/background.js?foreign=${Date.now()}`);
  await send(busy.chromeApi, {
    target: 'background', action: 'ready', tabId: 9,
    filename: 'video.mp4', url: 'blob:ours'
  });
  let suggestion = 'not-called';
  busy.chromeApi.downloads.onDeterminingFilename.listener(
    { url: 'blob:theirs' }, value => { suggestion = value; }
  );

  // The listener must still call suggest() exactly once (the API contract),
  // but never with a filename for a download we did not start.
  assert.equal(suggestion, undefined);
});

test('unregisters the filename listener when the download completes', async () => {
  const store = {};
  const done = mockChrome(store);
  globalThis.chrome = done.chromeApi;
  await import(`../background/background.js?done=${Date.now()}`);
  await send(done.chromeApi, {
    target: 'background', action: 'ready', tabId: 10,
    filename: 'video.mp4', url: 'blob:done'
  });
  assert.notEqual(done.chromeApi.downloads.onDeterminingFilename.listener, undefined);

  await done.chromeApi.downloads.onChanged.listener({
    id: 7, state: { current: 'complete' }
  });

  assert.equal(done.chromeApi.downloads.onDeterminingFilename.listener, undefined);
});

test('restores a pending filename after worker suspension', async () => {
  const store = {};
  const first = mockChrome(store);
  globalThis.chrome = first.chromeApi;
  await import(`../background/background.js?suspend-a=${Date.now()}`);
  await send(first.chromeApi, {
    target: 'background', action: 'ready', tabId: 11,
    filename: 'video.mp4', url: 'blob:suspend'
  });

  const restarted = mockChrome(store);
  globalThis.chrome = restarted.chromeApi;
  await import(`../background/background.js?suspend-b=${Date.now()}`);
  let suggestion;
  restarted.chromeApi.downloads.onDeterminingFilename.listener(
    { url: 'blob:suspend' }, value => { suggestion = value; }
  );

  assert.deepEqual(suggestion, { filename: 'video.mp4', conflictAction: 'uniquify' });
});

test('worker module loads synchronously without top-level await', () => {
  const mock = mockChrome({});
  globalThis.chrome = mock.chromeApi;
  assert.doesNotThrow(() => createRequire(import.meta.url)('../background/background.js'));
  assert.notEqual(mock.chromeApi.runtime.onInstalled.listener, undefined);
  assert.notEqual(mock.chromeApi.runtime.onMessage.listener, undefined);
});

test('registers wake listeners synchronously while pending filenames restore', { timeout: 1000 }, async () => {
  const store = { 'pending-filename:blob:slow': 'video.mp4' };
  const slow = mockChrome(store);
  let finishRestore;
  slow.chromeApi.storage.session.get = () => new Promise(resolve => { finishRestore = resolve; });
  globalThis.chrome = slow.chromeApi;
  await import(`../background/background.js?slow=${Date.now()}`);

  // A slow storage read must not postpone the listeners that wake the worker.
  assert.notEqual(slow.chromeApi.runtime.onMessage.listener, undefined);
  assert.notEqual(slow.chromeApi.downloads.onChanged.listener, undefined);

  assert.equal(slow.chromeApi.downloads.onDeterminingFilename.listener, undefined);
  finishRestore({ ...store });
  await Promise.resolve();
  let suggestion;
  slow.chromeApi.downloads.onDeterminingFilename.listener(
    { url: 'blob:slow' }, value => { suggestion = value; }
  );
  assert.deepEqual(suggestion, { filename: 'video.mp4', conflictAction: 'uniquify' });
});

test('adds an action context menu that opens the batch extension page', async () => {
  const store = {};
  const batch = mockChrome(store);
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?menu=${Date.now()}`);
  await batch.chromeApi.runtime.onInstalled.listener();

  assert.deepEqual(batch.menuItems, [{
    id: 'open-batch', title: 'contextOpenBatch', contexts: ['action']
  }]);
  await batch.chromeApi.contextMenus.onClicked.listener({ menuItemId: 'open-batch' });
  assert.equal(batch.createdTabs[0].url, 'chrome-extension://test/batch/batch.html');
});

test('opens each pasted COOL page in the background and starts its captured manifest', async () => {
  const store = {};
  const batch = mockChrome(store);
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?batch=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch',
    urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });

  assert.equal(batch.createdTabs[0].active, false);
  assert.equal(store.batch.items[0].state, 'opening');
  assert.equal(store.batch.items[0].tabId, batch.createdTabs[0].id);
  assert.match(batch.alarms[0].name, /^batch-discovery:/);

  await batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });

  assert.deepEqual(batch.removedTabs, [batch.createdTabs[0].id]);
  assert.equal(store.batch.items[0].state, 'preparing');
  assert.deepEqual(batch.sent.at(-1), {
    target: 'offscreen',
    action: 'download',
    jobId: store.batch.items[0].jobId,
    manifestUrl: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd',
    filename: 'Video 21.mp4'
  });

  await send(batch.chromeApi, {
    target: 'background', action: 'progress', jobId: store.batch.items[0].jobId,
    status: { state: 'downloading', progress: 42, bytesPerSecond: 4096 }
  });
  assert.equal(store.batch.items[0].progress, 42);
  assert.equal(store.batch.items[0].bytesPerSecond, 4096);
});

test('pauses, resumes, and stops the active batch download', async () => {
  const store = {};
  const batch = mockChrome(store);
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?controls=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch',
    urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  await batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });

  await send(batch.chromeApi, { action: 'pauseBatch' });
  assert.equal(store.batch.state, 'paused');
  assert.equal(batch.sent.at(-1).action, 'pause');
  await send(batch.chromeApi, { action: 'resumeBatch' });
  assert.equal(store.batch.state, 'running');
  assert.equal(batch.sent.at(-1).action, 'resume');
  await send(batch.chromeApi, { action: 'stopBatch' });
  assert.equal(store.batch.state, 'idle');
  assert.equal(store.batch.items[0].state, 'canceled');
  assert.equal(batch.sent.at(-1).action, 'cancel');
});

test('marks a batch stopped before closing its discovery tab', async () => {
  const store = {};
  const batch = mockChrome(store);
  let stateDuringRemove;
  batch.chromeApi.tabs.remove = async tabId => {
    stateDuringRemove = store.batch.state;
    batch.removedTabs.push(tabId);
  };
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?stop-opening=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch',
    urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });

  await send(batch.chromeApi, { action: 'stopBatch' });

  assert.equal(stateDuringRemove, 'idle');
});

test('advances to the next batch URL after the browser download completes', async () => {
  const store = {};
  const batch = mockChrome(store);
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?advance=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch',
    urls: [
      'https://cool.ntu.edu.tw/courses/58095/modules/items/2536772',
      'https://cool.ntu.edu.tw/courses/61640/modules/items/2443678'
    ]
  });
  await batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });
  await send(batch.chromeApi, {
    target: 'background', action: 'ready', jobId: store.batch.items[0].jobId,
    filename: 'First.mp4', url: 'blob:first'
  });
  await batch.chromeApi.downloads.onChanged.listener({ id: 7, state: { current: 'complete' } });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(store.batch.items[0].state, 'complete');
  assert.equal(batch.createdTabs.length, 2);
  assert.equal(batch.createdTabs[1].url, 'https://cool.ntu.edu.tw/courses/61640/modules/items/2443678');
});

test('fails a batch item that never exposes a native manifest', async () => {
  const store = {};
  const batch = mockChrome(store);
  let stateDuringRemove;
  batch.chromeApi.tabs.remove = async tabId => {
    stateDuringRemove = store.batch.items[0].state;
    batch.removedTabs.push(tabId);
  };
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?timeout=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch',
    urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  await batch.chromeApi.alarms.onAlarm.listener(batch.alarms[0]);

  assert.equal(store.batch.state, 'complete');
  assert.equal(store.batch.items[0].state, 'error');
  assert.equal(store.batch.items[0].errorKey, 'discoveryTimeout');
  assert.equal(stateDuringRemove, 'error');
});

test('rejects non-video URLs before opening a background tab', async () => {
  const store = {};
  const batch = mockChrome(store);
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?invalid=${Date.now()}`);
  const response = await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules']
  });

  assert.deepEqual(response, { success: false, errorKey: 'invalidLinks' });
  assert.equal(batch.createdTabs.length, 0);
});

test('starts every pasted URL again after a completed batch', async () => {
  const urls = [
    'https://cool.ntu.edu.tw/courses/58095/modules/items/2536772',
    'https://cool.ntu.edu.tw/courses/61640/modules/items/2443678'
  ];
  const store = { batch: {
    state: 'complete',
    items: [
      { id: '1', url: urls[0], state: 'complete', progress: 100 },
      { id: '2', url: urls[1], state: 'error', progress: 100 }
    ]
  } };
  const batch = mockChrome(store);
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?restart=${Date.now()}`);

  await send(batch.chromeApi, { action: 'startBatch', urls });

  assert.equal(store.batch.items.length, 2);
});

test('advances after an offscreen dispatch failure without deadlocking', async () => {
  const store = {};
  const batch = mockChrome(store);
  batch.chromeApi.runtime.sendMessage = async message => {
    if (message.target === 'offscreen' && message.action === 'download') throw new Error('offscreen failed');
    return {};
  };
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?batch-dispatch=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch',
    urls: [
      'https://cool.ntu.edu.tw/courses/58095/modules/items/2536772',
      'https://cool.ntu.edu.tw/courses/61640/modules/items/2443678'
    ]
  });

  await Promise.race([
    batch.chromeApi.webRequest.onBeforeRequest.listener({
      tabId: batch.createdTabs[0].id,
      url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('batch advancement deadlocked')), 100))
  ]);
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(store.batch.items[0].state, 'error');
  assert.equal(batch.createdTabs.length, 2);
});

test('ignores a delayed tab created for an obsolete batch run', async () => {
  const store = {};
  const batch = mockChrome(store);
  const createTab = batch.chromeApi.tabs.create.bind(batch.chromeApi.tabs);
  let resolveFirst;
  let createCount = 0;
  batch.chromeApi.tabs.create = properties => {
    createCount += 1;
    if (createCount !== 1) return createTab(properties);
    return new Promise(resolve => {
      resolveFirst = () => {
        const tab = { id: 19, title: 'Old video', ...properties };
        batch.createdTabs.push(tab);
        resolve(tab);
      };
    });
  };
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?obsolete-run=${Date.now()}`);
  batch.chromeApi.runtime.onMessage.listener({
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  }, {}, () => {});
  await new Promise(resolve => setTimeout(resolve));
  await send(batch.chromeApi, { action: 'stopBatch' });
  batch.chromeApi.runtime.onMessage.listener({
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/61640/modules/items/2443678']
  }, {}, () => {});
  await new Promise(resolve => setTimeout(resolve));

  resolveFirst();
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(store.batch.items[0].url, 'https://cool.ntu.edu.tw/courses/61640/modules/items/2443678');
  assert.equal(batch.createdTabs.length, 2);
  assert.equal(store.batch.items[0].tabId,
    batch.createdTabs.find(tab => tab.url === 'https://cool.ntu.edu.tw/courses/61640/modules/items/2443678').id);
  assert.deepEqual(batch.removedTabs, [19]);
});

test('does not let stale progress resurrect a stopped batch', async () => {
  const store = {};
  const batch = mockChrome(store);
  const get = batch.chromeApi.storage.session.get.bind(batch.chromeApi.storage.session);
  const set = batch.chromeApi.storage.session.set.bind(batch.chromeApi.storage.session);
  batch.chromeApi.storage.session.get = async keys => structuredClone(await get(keys));
  let releaseProgress;
  let progressBlocked;
  const blocked = new Promise(resolve => { progressBlocked = resolve; });
  batch.chromeApi.storage.session.set = async values => {
    if (values.batch?.items[0]?.progress === 42) {
      progressBlocked();
      await new Promise(resolve => { releaseProgress = resolve; });
    }
    await set(values);
  };
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?stale-progress=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  const progress = send(batch.chromeApi, {
    target: 'background', action: 'progress', jobId: store.batch.items[0].jobId,
    status: { state: 'downloading', progress: 42 }
  });
  await blocked;

  const stopping = send(batch.chromeApi, { action: 'stopBatch' });
  releaseProgress();
  await Promise.all([progress, stopping]);

  assert.equal(store.batch.state, 'idle');
  await send(batch.chromeApi, {
    target: 'background', action: 'progress', jobId: store.batch.items[0].jobId,
    status: { state: 'downloading', progress: 73 }
  });
  assert.equal(store.batch.items[0].state, 'canceled');
  assert.equal(store.batch.items[0].progress, 0);
});

test('cancels a browser download that resolves after Stop', async () => {
  const store = {};
  let resolveDownload;
  const batch = mockChrome(store, () => new Promise(resolve => { resolveDownload = resolve; }));
  const canceled = [];
  batch.chromeApi.downloads.cancel = async id => { canceled.push(id); };
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?late-download=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  await batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });
  const ready = send(batch.chromeApi, {
    target: 'background', action: 'ready', jobId: store.batch.items[0].jobId,
    filename: 'Lecture.mp4', url: 'blob:late'
  });
  await new Promise(resolve => setTimeout(resolve));

  await send(batch.chromeApi, { action: 'stopBatch' });
  resolveDownload(44);
  await ready;

  assert.deepEqual(canceled, [44]);
  assert.equal(store['download:44'], undefined);
  assert.equal(store.batch.state, 'idle');
});

test('does not dispatch an offscreen job after Stop wins setup', async () => {
  const store = {};
  const batch = mockChrome(store);
  let finishSetup;
  batch.chromeApi.offscreen.createDocument = () => new Promise(resolve => { finishSetup = resolve; });
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?late-dispatch=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  const manifest = batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });
  await new Promise(resolve => setTimeout(resolve));

  await send(batch.chromeApi, { action: 'stopBatch' });
  finishSetup();
  await manifest;

  assert.equal(batch.sent.some(message => message.action === 'download'), false);
  assert.equal(store.batch.state, 'idle');
});

test('keeps an offscreen job paused when setup finishes late', async () => {
  const store = {};
  const batch = mockChrome(store);
  let finishSetup;
  batch.chromeApi.offscreen.createDocument = () => new Promise(resolve => { finishSetup = resolve; });
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?late-pause=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  const manifest = batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });
  await new Promise(resolve => setTimeout(resolve));

  await send(batch.chromeApi, { action: 'pauseBatch' });
  finishSetup();
  await manifest;

  assert.deepEqual(batch.sent.slice(-2).map(message => message.action), ['download', 'pause']);
  assert.equal(store.batch.state, 'paused');
});

test('does not apply a stale pause after setup resumes', async () => {
  const store = {};
  const batch = mockChrome(store);
  let finishSetup;
  let finishDispatch;
  let dispatchStarted;
  const dispatching = new Promise(resolve => { dispatchStarted = resolve; });
  batch.chromeApi.offscreen.createDocument = () => new Promise(resolve => { finishSetup = resolve; });
  batch.chromeApi.runtime.sendMessage = async message => {
    batch.sent.push(message);
    if (message.action === 'download') {
      dispatchStarted();
      await new Promise(resolve => { finishDispatch = resolve; });
    }
    return {};
  };
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?resume-setup=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  const manifest = batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });
  await new Promise(resolve => setTimeout(resolve));
  await send(batch.chromeApi, { action: 'pauseBatch' });
  finishSetup();
  await dispatching;

  await send(batch.chromeApi, { action: 'resumeBatch' });
  finishDispatch();
  await manifest;

  assert.equal(batch.sent.at(-1).action, 'resume');
  assert.equal(store.batch.state, 'running');
});

test('removes obsolete batch job records on Stop and replacement', async () => {
  const store = {};
  const batch = mockChrome(store);
  globalThis.chrome = batch.chromeApi;
  await import(`../background/background.js?job-cleanup=${Date.now()}`);
  await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/58095/modules/items/2536772']
  });
  await batch.chromeApi.webRequest.onBeforeRequest.listener({
    tabId: batch.createdTabs[0].id,
    url: 'https://video.dlc.ntu.edu.tw/path/manifest.mpd'
  });
  const oldJobId = store.batch.items[0].jobId;
  assert.ok(store[`job:${oldJobId}`]);

  await send(batch.chromeApi, { action: 'stopBatch' });
  assert.equal(store[`job:${oldJobId}`], undefined);
  store[`job:${oldJobId}`] = { state: 'error' };
  await send(batch.chromeApi, {
    action: 'startBatch', urls: ['https://cool.ntu.edu.tw/courses/61640/modules/items/2443678']
  });

  assert.equal(store[`job:${oldJobId}`], undefined);
});

test('preserves failure diagnostics through Stop and restart, then retries only failed URLs', async () => {
  const good = 'https://cool.ntu.edu.tw/courses/1/modules/items/1';
  const bad = 'https://cool.ntu.edu.tw/courses/1/modules/items/2';
  const canceled = 'https://cool.ntu.edu.tw/courses/1/modules/items/3';
  const store = { batch: { runId: 'old', state: 'running', items: [
    { id: '1', jobId: 'batch:old:1', url: good, state: 'complete', progress: 100 },
    { id: '2', jobId: 'batch:old:2', url: bad, state: 'downloading', progress: 40 },
    { id: '3', jobId: 'batch:old:3', url: canceled, state: 'queued', progress: 0 }
  ] } };
  const mock = mockChrome(store);
  globalThis.chrome = mock.chromeApi;
  await import(`../background/background.js?reports=${Date.now()}`);
  await send(mock.chromeApi, { action: 'pauseBatch' });
  await send(mock.chromeApi, { target: 'background', action: 'progress', jobId: 'batch:old:2',
    status: { state: 'error', errorKey: 'downloadFailed', error: 'HTTP 404',
      errorDetails: { stage: 'segments', httpStatus: 404, segment: 295 } } });
  assert.equal(store.batch.items[1].error, 'HTTP 404');
  await send(mock.chromeApi, { action: 'stopBatch' });
  assert.deepEqual(store.batch.items.map(item => item.state), ['complete', 'error', 'canceled']);
  delete store.batch;
  const previous = await send(mock.chromeApi, { action: 'getBatchStatus' });
  assert.equal(previous.batch.archived, true);
  assert.equal(previous.batch.items[1].errorDetails.segment, 295);
  await send(mock.chromeApi, { action: 'retryBatchFailures' });
  assert.equal(mock.createdTabs.length, 1);
  assert.equal(mock.createdTabs[0].url, bad);
  assert.equal(store.batch.items[0].state, 'complete');
  assert.equal(store.batch.items[1].lastError.error, 'HTTP 404');
  assert.equal(store.batch.items[1].retryCount, 1);
  const before = store.batch.runId;
  assert.equal((await send(mock.chromeApi, { action: 'startBatch', urls: [good] })).success, false);
  assert.equal(store.batch.runId, before);
  await send(mock.chromeApi, { target: 'background', action: 'progress', jobId: 'batch:old:2', status: { state: 'complete' } });
  assert.equal(store.batch.items[1].state, 'opening');
  await send(mock.chromeApi, { action: 'stopBatch' });
  assert.equal(store.lastBatchReport.items[1].state, 'canceled');
  assert.equal(store.lastBatchReport.items[1].lastError.error, 'HTTP 404');
  assert.equal(store.lastBatchReport.items[1].retryCount, 1);
});

test('surfaces report storage failure without discarding the terminal result', async () => {
  const store = { batch: { runId: 'quota', state: 'running', items: [
    { id: '1', jobId: 'batch:quota:1', url: 'https://cool.ntu.edu.tw/courses/1/modules/items/1', state: 'opening' }
  ] } };
  const mock = mockChrome(store);
  mock.chromeApi.storage.local.set = async () => { throw new Error('Quota exceeded'); };
  globalThis.chrome = mock.chromeApi;
  await import(`../background/background.js?quota=${Date.now()}`);
  await mock.chromeApi.alarms.onAlarm.listener({ name: 'batch-discovery:batch:quota:1' });
  assert.equal(store.batch.items[0].state, 'error');
  assert.equal(store.batch.storageError, 'Quota exceeded');
});

test('archives an interrupted first item instead of returning an older batch', async () => {
  const url = 'https://cool.ntu.edu.tw/courses/1/modules/items/1';
  const store = { lastBatchReport: { runId: 'older', items: [] } };
  const mock = mockChrome(store);
  globalThis.chrome = mock.chromeApi;
  await import(`../background/background.js?first-report=${Date.now()}`);
  await send(mock.chromeApi, { action: 'startBatch', urls: [url] });
  assert.equal(store.lastBatchReport.runId, store.batch.runId);
  assert.equal(store.lastBatchReport.items[0].state, 'opening');
  delete store.batch;
  const restored = await send(mock.chromeApi, { action: 'getBatchStatus' });
  assert.equal(restored.batch.archived, true);
  assert.equal(restored.batch.items[0].url, url);
  assert.equal(restored.batch.items[0].state, 'canceled');
});
