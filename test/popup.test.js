import test from 'node:test';
import assert from 'node:assert/strict';

test('popup reaches 100 percent even when omitted tails emit no download update', async () => {
  const nodes = new Map();
  globalThis.document = { documentElement: {}, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, classList: { toggle() {} }, addEventListener() {} });
    return nodes.get(id);
  } };
  let job = { state: 'downloading', progress: 98 };
  globalThis.chrome = {
    i18n: { getMessage: key => key, getUILanguage: () => 'en' },
    tabs: { query: async () => [{ id: 1 }] },
    runtime: { sendMessage: async () => ({ found: true, job }) }
  };
  const originalInterval = globalThis.setInterval;
  let refresh;
  globalThis.setInterval = callback => { refresh = callback; };
  try {
    await import(`../popup/popup.js?progress=${Date.now()}`);
    assert.equal(nodes.get('progress').value, 98);
    for (const state of ['processing', 'saving', 'complete']) {
      nodes.get('progress').value = 98;
      job = { state, progress: 100 };
      await refresh();
      assert.equal(nodes.get('progress').value, 100);
      assert.equal(nodes.get('progress').hidden, false);
    }
  } finally { globalThis.setInterval = originalInterval; }
});
