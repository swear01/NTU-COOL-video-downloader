import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AdaptiveConcurrency,
  activeBatchItem,
  batchProgress,
  buildSegments,
  formatSpeed,
  ManifestStore,
  parseBatchUrls,
  parseIsoDuration,
  sanitizeFilename,
  selectTracks
} from '../utils/core.js';
import { hasOffscreenDocument } from '../utils/offscreen.js';
import { mergeTemplateValues } from '../utils/mpd.js';
import {
  Remuxer,
  releaseMdatBuffers
} from '../utils/remuxer.js';
import { createFile, MP4BoxBuffer } from '../vendor/mp4box.all.mjs';

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
  assert.equal(sanitizeFilename('6/5 Counting 3'), '6／5 Counting 3.mp4');
  assert.equal(sanitizeFilename('Two-View Geometry: Epipolar / Geometry'), 'Two-View Geometry： Epipolar ／ Geometry.mp4');
  assert.equal(sanitizeFilename('<>:"/\\|?*'), '＜＞：＂／\uFF3C｜？＊.mp4');
  assert.equal(sanitizeFilename('CON'), 'CON_.mp4');
  assert.equal(sanitizeFilename('nul.txt'), 'nul_.txt.mp4');
  assert.equal(sanitizeFilename('   '), 'ntu-cool-video.mp4');
});

test('normalizes, deduplicates, and validates direct NTU COOL video page URLs', () => {
  assert.deepEqual(parseBatchUrls(`
    https://cool.ntu.edu.tw/courses/58095/modules/items/2536772?from=modules#content
    https://cool.ntu.edu.tw/courses/58095/modules/items/2536772/
    https://cool.ntu.edu.tw/courses/61640/modules/items/2443678
    https://cool.ntu.edu.tw/courses/58095/modules
    https://example.com/courses/1/modules/items/2
  `), {
    urls: [
      'https://cool.ntu.edu.tw/courses/58095/modules/items/2536772',
      'https://cool.ntu.edu.tw/courses/61640/modules/items/2443678'
    ],
    invalid: [
      'https://cool.ntu.edu.tw/courses/58095/modules',
      'https://example.com/courses/1/modules/items/2'
    ]
  });
});

test('reports overall batch progress by completed and active videos', () => {
  assert.equal(batchProgress([]), 0);
  assert.equal(batchProgress([
    { state: 'complete', progress: 100 },
    { state: 'downloading', progress: 50 },
    { state: 'queued', progress: 0 },
    { state: 'error', progress: 0 }
  ]), 63);
});

test('finds the active batch item and formats download speed', () => {
  assert.equal(activeBatchItem([
    { state: 'complete', progress: 100 },
    { state: 'downloading', progress: 40, bytesPerSecond: 1500 },
    { state: 'queued', progress: 0 }
  ]).index, 1);
  assert.equal(activeBatchItem([{ state: 'queued', progress: 0 }]), null);
  assert.equal(formatSpeed(0), '0 B/s');
  assert.equal(formatSpeed(900), '900 B/s');
  assert.equal(formatSpeed(1536), '1.5 KB/s');
  assert.equal(formatSpeed(2 * 1024 * 1024), '2.0 MB/s');
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

test('leaves fragmented MP4 header durations at zero', () => {
  const avcDecoderConfigRecord = Uint8Array.from(Buffer.from(
    'AWQAKP/hABtnZAAorNkAeAIn5cBEAAADAAQAAAMA8DxgxlgBAAZo6+LEyEw=',
    'base64'
  )).buffer;
  const video = createFile();
  video.init({ timescale: 600, duration: 6000 });
  video.addTrack({
    type: 'avc1', hdlr: 'vide', timescale: 15360, duration: 153600,
    media_duration: 153600, width: 16, height: 16, avcDecoderConfigRecord
  });
  const audio = createFile();
  audio.init({ timescale: 600, duration: 6000 });
  audio.addTrack({
    type: 'mp4a', hdlr: 'soun', timescale: 48000, duration: 480000,
    media_duration: 480000, channel_count: 2, samplesize: 16, samplerate: 48000
  });

  const output = new Remuxer(video.getBuffer().buffer, audio.getBuffer().buffer).finish();
  const parsed = createFile();
  let info;
  parsed.onReady = value => { info = value; };
  parsed.appendBuffer(MP4BoxBuffer.fromArrayBuffer(output, 0));
  parsed.flush();

  assert.equal(info.duration, 0);
  assert.deepEqual(info.tracks.map(track => track.duration), [0, 0]);
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
