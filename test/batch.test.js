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
    i18n: { getMessage: key => key, getUILanguage: () => 'en' },
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
  assert.equal(get('urls').readOnly, true);
  assert.equal(get('urls').disabled, false);
  const row = get('results').children[0];
  row.open = true;
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
});
