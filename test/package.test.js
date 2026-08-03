import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('packages the extension with manifest.json at the ZIP root', () => {
  execFileSync('sh', ['scripts/package.sh']);
  const version = JSON.parse(readFileSync('manifest.json')).version;
  const entries = execFileSync('unzip', [
    '-Z1', `release/NTU-COOL-video-downloader-${version}.zip`
  ], { encoding: 'utf8' }).trim().split('\n');

  assert.ok(entries.includes('manifest.json'));
  assert.ok(entries.includes('PRIVACY.md'));
  assert.ok(entries.includes('background/background.js'));
  assert.ok(entries.includes('batch/batch.html'));
  assert.ok(entries.includes('batch/batch.js'));
  assert.ok(entries.includes('_locales/en/messages.json'));
  assert.ok(entries.includes('_locales/zh_TW/messages.json'));
  assert.equal(entries.some(entry => entry.startsWith(`NTU-COOL-video-downloader-${version}/`)), false);
});
