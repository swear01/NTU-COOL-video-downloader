import {
  createFile,
  Endianness,
  MP4BoxBuffer,
  MultiBufferStream
} from '../vendor/mp4box.all.mjs';

function sourceTrack(initBuffer) {
  const file = createFile(true);
  let info;
  file.onReady = value => { info = value; };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(initBuffer, 0), false);
  if (!info?.tracks.length) throw new Error('Invalid MP4 initialization segment.');
  return { file, info: info.tracks[0], offset: initBuffer.byteLength, pending: new Map(), next: 0 };
}

export function scaleDuration(duration, mediaTimescale, movieTimescale) {
  return Math.round(duration * movieTimescale / mediaTimescale);
}

export function releaseMdatBuffers(file) {
  for (const mdat of file.mdats) mdat.stream?.cleanBuffers();
  file.mdats = file.mdats.filter(mdat => !mdat.stream || mdat.stream.buffers.length);
}

function avcConfiguration(file) {
  const stream = new MultiBufferStream();
  stream.endianness = Endianness.BIG_ENDIAN;
  const box = file.getBox('avcC');
  if (!box) throw new Error('No AVC decoder configuration found.');
  box.write(stream);
  return stream.buffer.slice(8);
}

export class Remuxer {
  constructor(videoInit, audioInit) {
    const movieTimescale = 600;
    this.video = sourceTrack(videoInit);
    this.audio = sourceTrack(audioInit);
    this.output = createFile();
    this.output.init({ timescale: movieTimescale });

    this.video.outputId = this.output.addTrack({
      type: 'avc1',
      hdlr: 'vide',
      timescale: this.video.info.timescale,
      duration: scaleDuration(this.video.info.duration, this.video.info.timescale, movieTimescale),
      media_duration: this.video.info.duration,
      width: this.video.info.video.width,
      height: this.video.info.video.height,
      avcDecoderConfigRecord: avcConfiguration(this.video.file)
    });

    const audioEntry = this.audio.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0];
    this.audio.outputId = this.output.addTrack({
      type: 'mp4a',
      hdlr: 'soun',
      timescale: this.audio.info.timescale,
      duration: scaleDuration(this.audio.info.duration, this.audio.info.timescale, movieTimescale),
      media_duration: this.audio.info.duration,
      channel_count: audioEntry.channel_count,
      samplesize: audioEntry.samplesize,
      samplerate: audioEntry.samplerate,
      description_boxes: audioEntry.boxes
    });

    for (const source of [this.video, this.audio]) {
      source.file.setExtractionOptions(source.info.id, undefined, { nbSamples: 1000 });
      source.file.onSamples = (_, __, samples) => {
        for (const sample of samples) {
          this.output.addSample(source.outputId, sample.data, {
            duration: sample.duration,
            cts: sample.cts,
            dts: sample.dts,
            is_sync: sample.is_sync
          });
        }
        source.file.releaseUsedSamples(source.info.id, samples.at(-1).number + 1);
        releaseMdatBuffers(source.file);
      };
      source.file.start();
    }
  }

  append(kind, index, buffer) {
    const source = this[kind];
    source.pending.set(index, buffer);
    while (source.pending.has(source.next)) {
      const current = source.pending.get(source.next);
      source.pending.delete(source.next);
      source.file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(current, source.offset), false);
      source.offset += current.byteLength;
      source.next += 1;
    }
  }

  finish() {
    this.video.file.flush();
    this.audio.file.flush();
    return this.output.getBuffer().buffer;
  }
}
