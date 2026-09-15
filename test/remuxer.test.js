import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxParser, createFile, DataStream } from '../vendor/mp4box.all.mjs';
import { mp4Blob, Remuxer } from '../utils/remuxer.js';

function track(kind) {
  const file = createFile();
  file.init({ timescale: 1000, duration: 10000 });
  const id = file.addTrack(kind === 'video' ? {
    type: 'avc1', hdlr: 'vide', timescale: 1000, width: 16, height: 16,
    avcDecoderConfigRecord: Uint8Array.from(Buffer.from(
      'AWQAKP/hABtnZAAorNkAeAIn5cBEAAADAAQAAAMA8DxgxlgBAAZo6+LEyEw=', 'base64')).buffer
  } : {
    type: 'mp4a', hdlr: 'soun', timescale: 1000,
    channel_count: 2, samplesize: 16, samplerate: 48000
  });
  const mehd = file.moov.mvex.addBox(new BoxParser.box.mehd());
  mehd.fragment_duration = 10000;
  const init = file.getBuffer().buffer;
  return { file, id, init };
}

test('omits an estimated tail only after contiguous samples cover the declared duration', () => {
  const video = track('video');
  const audio = track('audio');
  const remuxer = new Remuxer(video.init, audio.init);
  assert.equal(remuxer.hasCompleteTrack('video', 0), false);
  const initialBoxCount = video.file.boxes.length;
  video.file.addSample(video.id, new Uint8Array([0, 0, 0, 1, 0x65]), {
    duration: 10000, dts: 0, cts: 0, is_sync: true
  });
  const stream = new DataStream();
  for (const box of video.file.boxes.slice(initialBoxCount)) box.write(stream);
  remuxer.append('video', 0, stream.buffer);
  assert.equal(remuxer.hasCompleteTrack('video', 1), true);
  assert.equal(remuxer.hasCompleteTrack('video', 2), false);
  assert.equal(remuxer.hasCompleteTrack('audio', 0), false);
  remuxer.video.fragmentDuration = undefined;
  assert.equal(remuxer.hasCompleteTrack('video', 1), false);
});

test('serializes large outputs as bounded Blob parts with identical bytes', async () => {
  const block = new Uint8Array(9 * 1024 * 1024).fill(0x5a);
  const boxes = Array.from({ length: 4 }, () => ({ write(stream) { stream.writeUint8Array(block); } }));
  const original = DataStream.prototype._realloc;
  let largest = 0;
  DataStream.prototype._realloc = function (extra) {
    largest = Math.max(largest, this.position + extra);
    return original.call(this, extra);
  };
  try {
    const blob = mp4Blob({ boxes });
    assert.equal(blob.type, 'video/mp4');
    assert.equal(blob.size, block.length * 4);
    assert.ok(largest <= block.length * 2, 'must not allocate the whole output');
    assert.deepEqual(new Uint8Array(await blob.slice(block.length - 1, block.length + 1).arrayBuffer()),
      new Uint8Array([0x5a, 0x5a]));
    assert.equal(new Uint8Array(await blob.slice(-1).arrayBuffer())[0], 0x5a);
  } finally {
    DataStream.prototype._realloc = original;
  }
});


test('composition offsets do not hide a required short tail', () => {
  const video = track('video');
  const audio = track('audio');
  const remuxer = new Remuxer(video.init, audio.init);
  const start = video.file.boxes.length;
  video.file.addSample(video.id, new Uint8Array([0, 0, 0, 1, 0x65]), {
    duration: 9960, dts: 0, cts: 80, is_sync: true
  });
  const stream = new DataStream();
  for (const box of video.file.boxes.slice(start)) box.write(stream);
  remuxer.append('video', 0, stream.buffer);
  assert.equal(remuxer.hasCompleteTrack('video', 1), false);
});
