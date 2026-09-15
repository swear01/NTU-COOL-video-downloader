import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverVideo } from '../utils/discovery.js';

const pageUrl = 'https://cool.ntu.edu.tw/courses/1/modules/items/2';
const videoOrigin = 'https://cool-video.dlc.ntu.edu.tw';
const launchUrl = `${videoOrigin}/ltiv1p1/launch/videos/3`;
const playerUrl = `${videoOrigin}/courses/1/videos/4`;
const source = 'https://video.dlc.ntu.edu.tw/video/manifest.mpd?signature=private';

function setup({ action = launchUrl, metadata = { sourceUri: source, title: 'Lecture' }, failedStep } = {}) {
  const calls = [];
  globalThis.DOMParser = class {
    parseFromString() {
      return { title: 'Page', forms: [{
        getAttribute: () => action,
        querySelectorAll: () => [{ name: 'oauth_signature', value: 'private' }]
      }] };
    }
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === failedStep) return { ok: false, status: 401 };
    return {
      ok: true, url: url === pageUrl ? pageUrl : playerUrl,
      text: async () => '<form></form>', json: async () => metadata
    };
  };
  return calls;
}

test('resolves a fresh signed LTI launch into the actual player metadata API', async t => {
  const originalFetch = globalThis.fetch;
  const originalParser = globalThis.DOMParser;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.DOMParser = originalParser; });
  const calls = setup();
  const signal = new AbortController().signal;
  assert.deepEqual(await discoverVideo(pageUrl, signal), { manifestUrl: source, title: 'Lecture' });
  assert.deepEqual(calls.map(call => call.url), [pageUrl, launchUrl, `${videoOrigin}/api/courses/1/videos/4/view`]);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body.get('oauth_signature'), 'private');
  for (const { options } of calls) {
    assert.equal(options.credentials, 'include');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.signal, signal);
  }
});

test('rejects untrusted destinations and preserves authorization failure stages', async t => {
  const originalFetch = globalThis.fetch;
  const originalParser = globalThis.DOMParser;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.DOMParser = originalParser; });
  for (const action of ['https://evil.example/ltiv1p1/launch/videos/3', `${videoOrigin}/other`]) {
    const calls = setup({ action });
    await assert.rejects(discoverVideo(pageUrl), { code: 'authorization_form_missing', stage: 'discovery_page' });
    assert.equal(calls.length, 1);
  }
  for (const [failedStep, stage] of [[1, 'page'], [2, 'authorization'], [3, 'metadata']]) {
    setup({ failedStep });
    await assert.rejects(discoverVideo(pageUrl), { httpStatus: 401, stage: `discovery_${stage}` });
  }
  for (const sourceUri of ['https://evil.example/manifest.mpd', 'http://video.dlc.ntu.edu.tw/manifest.mpd',
    'https://user:password@video.dlc.ntu.edu.tw/manifest.mpd']) {
    setup({ metadata: { sourceUri } });
    await assert.rejects(discoverVideo(pageUrl), { code: 'unsupported_source' });
  }
  setup({ metadata: null });
  await assert.rejects(discoverVideo(pageUrl), { code: 'unsupported_source', stage: 'discovery_metadata' });
  setup({ metadata: { sourceUri: 'invalid' } });
  await assert.rejects(discoverVideo(pageUrl), { code: 'unsupported_source' });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await fetch(...args);
    response.json = async () => { throw new SyntaxError('Private response content'); };
    return response;
  };
  await assert.rejects(discoverVideo(pageUrl), { code: 'invalid_metadata', stage: 'discovery_metadata',
    message: 'COOL returned invalid video metadata. Check login and course access.' });
  const calls = setup();
  await assert.rejects(discoverVideo('https://evil.example/courses/1/modules/items/2'));
  assert.equal(calls.length, 0);
});
