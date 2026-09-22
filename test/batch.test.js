import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  textContent = ''; value = ''; children = []; listeners = {}; disabled = false;
  classList = { add() {}, remove() {} };
  setAttribute() {}
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { return this.disabled ? undefined : this.listeners.click?.(); }
  focus() {}
  select() { this.selected = true; }
  remove() { this.removed = true; }
}

test('batch errors and copy snapshots survive updates, permission failures, and clipboard denial', async () => {
  const nodes = new Map();
  globalThis.document = { documentElement: {}, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  }, createElement: () => new Element() };
  const get = id => document.getElementById(id);
  let changed;
  let initial;
  let current = { runId: 'one', state: 'running', items: [{ id: '1', title: 'Lecture',
    url: 'https://cool.ntu.edu.tw/courses/1/modules/items/2', state: 'downloading', progress: 10 }] };
  let grant = false;
  let rejectAction = false;
  let copied = '';
  globalThis.chrome = {
    i18n: { getMessage: (key, values) => values ? `${key}: ${values.join(",")}` : key, getUILanguage: () => 'en' },
    permissions: { request: async () => grant },
    runtime: { getManifest: () => ({ version: '1.2.2' }), sendMessage: async message => {
      if (message.action === 'getBatchStatus') {
        if (!initial) return new Promise(resolve => { initial = resolve; });
        return { batch: current };
      }
      return rejectAction ? { success: false, error: 'Dispatch unavailable' } : { success: true };
    } },
    storage: { onChanged: { addListener(listener) { changed = listener; } } }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async value => { copied = value; } }
  } });
  const loading = import(`../batch/batch.js?ui=${Date.now()}`);
  while (!initial) await new Promise(resolve => setTimeout(resolve, 0));
  changed({ batch: { newValue: current } }, 'session');
  initial({ batch: null });
  await loading;
  assert.equal(get('urls').value, current.items[0].url);
  assert.equal(get('urls').readOnly, true);
  assert.equal(get('urls').disabled, false);
  const row = get('results').children[0];
  row.open = true;
  current.items.push({ id: '2', title: 'Second', url: 'https://cool.ntu.edu.tw/courses/1/modules/items/3',
    state: 'downloading', progress: 25, bytesPerSecond: 2048 });
  changed({ batch: { newValue: current } }, 'session');
  assert.match(get('detail').textContent, /1,2,10,0 B\/s/);
  assert.match(get('detail').textContent, /2,2,25,2.0 KB\/s/);
  changed({ batch: { newValue: { ...current, state: 'paused' } } }, 'session');
  assert.match(get('detail').textContent, /2,2,25,0 B\/s/);

  current = { ...current, state: 'complete', items: [{ ...current.items[0], state: 'error',
    errorKey: 'downloadFailed', error: 'HTTP 404', errorDetails: { stage: 'segments', segment: 295 } }] };
  changed({ batch: { newValue: current } }, 'session');
  assert.equal(get('results').children[0], row);
  assert.equal(row.open, true);
  assert.match(row.children[2].textContent, /HTTP 404\nstage: segments\nsegment: 295/);
  await get('copyFailed').click();
  assert.equal(copied, current.items[0].url);
  navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  await get('copyReport').click();
  const snapshot = get('copyText').value;
  assert.equal(get('copyText').hidden, false);
  assert.equal(get('copyText').selected, true);
  assert.equal(JSON.parse(snapshot).items[0].error, 'HTTP 404');
  get('urls').value = '';
  get('urls').listeners.input();
  changed({ batch: { newValue: current } }, 'session');
  assert.equal(get('urls').value, '');
  get('urls').value = current.items[0].url;
  get('urls').listeners.input();
  await get('start').click();
  assert.equal(get('error').textContent, 'permissionDenied');
  changed({ batch: { newValue: current } }, 'session');
  assert.equal(get('error').textContent, 'permissionDenied');
  assert.equal(get('copyText').value, snapshot);
  grant = true;
  rejectAction = true;
  await get('start').click();
  assert.equal(get('error').textContent, 'Dispatch unavailable');
  current = { ...current, state: 'running' };
  changed({ batch: { newValue: current } }, 'session');
  const originalSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async message => {
    if (message.action !== 'stopBatch') return originalSend(message);
    current = { ...current, state: 'idle' };
    changed({ batch: { newValue: current } }, 'session');
    return { success: false, error: 'Browser cancellation failed' };
  };
  await get('stop').click();
  assert.equal(get('error').textContent, 'Browser cancellation failed');
  assert.equal(get('stop').disabled, true);
  assert.equal(get('urls').readOnly, false, 'storage events update the UI even when a control reports failure');

});


test('retry progress counts this attempt while retaining original rows and archived results', async () => {
  const nodes = new Map();
  globalThis.document = { documentElement: {}, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  }, createElement: () => new Element() };
  const get = id => document.getElementById(id);
  let changed;
  let current = { runId: 'retry', state: 'running', retryIds: ['22'], items: Array.from({ length: 32 }, (_, index) => ({
    id: String(index + 1), title: `Lecture ${index + 1}`,
    url: `https://cool.ntu.edu.tw/courses/1/modules/items/${index + 1}`,
    state: index === 21 ? 'downloading' : 'complete', progress: index === 21 ? 40 : 100
  })) };
  globalThis.chrome = {
    i18n: { getMessage: (key, values) => values ? `${key}: ${values.join(',')}` : key, getUILanguage: () => 'en' },
    runtime: { sendMessage: async () => ({ batch: current }) },
    storage: { onChanged: { addListener(listener) { changed = listener; } } }
  };
  await import(`../batch/batch.js?retry-progress=${Date.now()}`);
  assert.equal(get('detail').textContent, 'retryProgressDetail: 1,1,40,0 B/s,22');
  assert.equal(get('progress').value, 40);
  assert.equal(get('summary').textContent, 'retry · state_complete: 0 · state_error: 0 · state_canceled: 0');
  assert.equal(get('results').children.length, 32);
  assert.match(get('results').children[21].children[0].textContent, /^22\. Lecture 22/);

  current.retryIds = ['22', '30'];
  current.items[21].state = 'complete'; current.items[21].progress = 100;
  current.items[29].state = 'downloading'; current.items[29].progress = 20;
  changed({ batch: { newValue: current } }, 'session');
  assert.equal(get('detail').textContent, 'retryProgressDetail: 2,2,20,0 B/s,30');
  assert.equal(get('progress').value, 60);
  assert.match(get('summary').textContent, /state_complete: 1/);
  current.items[29].state = 'error'; current.items[29].progress = 0;
  current.state = 'idle'; current.archived = true;
  changed({ batch: { newValue: current } }, 'session');
  assert.equal(get('progress').value, 100);
  assert.equal(get('summary').textContent, 'previousBatch · retry · state_complete: 1 · state_error: 1 · state_canceled: 0');

  current = { runId: 'fresh', state: 'running', items: current.items.map(item => ({ ...item, state: 'queued', progress: 0 })) };
  current.items[0].state = 'downloading';
  changed({ batch: { newValue: current } }, 'session');
  assert.equal(get('detail').textContent, 'batchProgressDetail: 1,32,0,0 B/s');
  assert.equal(get('progress').value, 0);
});
