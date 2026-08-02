import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AdaptiveConcurrency,
  buildSegments,
  ManifestStore,
  parseIsoDuration,
  sanitizeFilename,
  selectTracks
} from '../utils/core.js';
import { hasOffscreenDocument } from '../utils/offscreen.js';
import { mergeTemplateValues } from '../utils/mpd.js';
import { releaseMdatBuffers, scaleDuration, secondsToTimescale } from '../utils/remuxer.js';

test('selects the highest-resolution video and its matching audio', () => {
  const tracks = selectTracks([
    { id: 'video-360', kind: 'video', width: 480, height: 360, bandwidth: 172049 },
    { id: 'audio-720', kind: 'audio', bandwidth: 144088 },
    { id: 'video-720', kind: 'video', width: 960, height: 720, bandwidth: 379381 },
    { id: 'audio-360', kind: 'audio', bandwidth: 96467 }
  ]);

  assert.equal(tracks.video.id, 'video-720');
  assert.equal(tracks.audio.id, 'audio-720');
});

test('parses DASH ISO-8601 durations', () => {
  assert.equal(parseIsoDuration('PT1H6M16.672S'), 3976.672);
  assert.equal(parseIsoDuration('PT30S'), 30);
});

test('keeps the latest manifest isolated by browser tab', () => {
  const manifests = new ManifestStore();
  manifests.set(10, 'https://files.example/first/manifest.mpd');
  manifests.set(11, 'https://files.example/second/manifest.mpd');

  assert.equal(manifests.get(10), 'https://files.example/first/manifest.mpd');
  assert.equal(manifests.get(11), 'https://files.example/second/manifest.mpd');
  manifests.delete(10);
  assert.equal(manifests.get(10), null);
  assert.equal(manifests.get(11), 'https://files.example/second/manifest.mpd');
});

test('expands fixed-duration SegmentTemplate URLs through the final partial segment', () => {
  const segments = buildSegments({
    id: 'video-720',
    duration: 153600,
    timescale: 15360,
    startNumber: 1,
    initialization: '$RepresentationID$-init.m4s.mp4',
    media: '$RepresentationID$-$Number$.m4s'
  }, 25, 'https://files.example/video/manifest.mpd');

  assert.deepEqual(segments, [
    'https://files.example/video/video-720-init.m4s.mp4',
    'https://files.example/video/video-720-1.m4s',
    'https://files.example/video/video-720-2.m4s',
    'https://files.example/video/video-720-3.m4s'
  ]);
});

test('auto concurrency grows on useful throughput gains and halves on throttling', () => {
  const auto = new AdaptiveConcurrency();

  assert.equal(auto.value, 8);
  assert.equal(auto.observe({ throughput: 10, completed: 16, errors: 0 }), 12);
  assert.equal(auto.observe({ throughput: 12, completed: 16, errors: 0 }), 16);
  assert.equal(auto.observe({ throughput: 12.2, completed: 16, errors: 0 }), 16);
  assert.equal(auto.observe({ throughput: 12, completed: 0, errors: 1, throttled: true }), 8);
});

test('sanitizes page titles into safe MP4 filenames', () => {
  assert.equal(sanitizeFilename('Two-View Geometry: Epipolar / Geometry'), 'Two-View Geometry Epipolar Geometry.mp4');
  assert.equal(sanitizeFilename('   '), 'ntu-cool-video.mp4');
});

test('finds an existing offscreen document on Chrome 116+', async () => {
  const chromeApi = {
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      getContexts: async query => query.documentUrls[0].endsWith('/offscreen/offscreen.html')
        ? [{ contextType: 'OFFSCREEN_DOCUMENT' }]
        : []
    }
  };

  assert.equal(await hasOffscreenDocument(chromeApi, 'offscreen/offscreen.html'), true);
});

test('inherits missing representation SegmentTemplate attributes', () => {
  assert.deepEqual(mergeTemplateValues(
    { initialization: 'init-$RepresentationID$', media: '$Number$', timescale: '10', duration: '20', startNumber: '1' },
    { startNumber: '4' }
  ), {
    initialization: 'init-$RepresentationID$',
    media: '$Number$',
    timescale: 10,
    duration: 20,
    startNumber: 4
  });
});

test('converts media duration to the movie timescale', () => {
  assert.equal(scaleDuration(480000, 48000, 600), 6000);
  assert.equal(scaleDuration(153600, 15360, 600), 6000);
  assert.equal(secondsToTimescale(3976.672, 600), 2386003);
});

test('releases consumed source mdat buffers after extracting samples', () => {
  let cleaned = 0;
  const file = { mdats: [
    { stream: { buffers: [], cleanBuffers: () => { cleaned += 1; } } },
    { stream: { buffers: [], cleanBuffers: () => { cleaned += 1; } } }
  ] };
  releaseMdatBuffers(file);
  assert.equal(cleaned, 2);
  assert.equal(file.mdats.length, 0);
});
