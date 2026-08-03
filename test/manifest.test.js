import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));

test('keeps browser access limited to the documented NTU COOL surface', () => {
  assert.deepEqual(manifest.permissions.sort(), [
    'activeTab',
    'alarms',
    'contextMenus',
    'downloads',
    'offscreen',
    'storage',
    'webRequest'
  ]);
  assert.deepEqual(manifest.host_permissions, ['https://*.dlc.ntu.edu.tw/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://cool.ntu.edu.tw/*']);
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.minimum_chrome_version, '116');
});
