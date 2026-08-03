import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readMessages = async locale => JSON.parse(await readFile(
  new URL(`../_locales/${locale}/messages.json`, import.meta.url)
));

test('keeps English and Traditional Chinese locale keys in sync', async () => {
  const english = await readMessages('en');
  const traditionalChinese = await readMessages('zh_TW');
  assert.deepEqual(Object.keys(traditionalChinese).sort(), Object.keys(english).sort());
});
