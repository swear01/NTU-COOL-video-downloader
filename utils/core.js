export function selectTracks(representations) {
  const videos = representations.filter(track => track.kind === 'video');
  const audios = representations.filter(track => track.kind === 'audio');
  const video = videos.sort((a, b) =>
    (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0)
  )[0];

  if (!video) throw new Error('No video track found.');

  const suffix = video.id.match(/-(.+)$/)?.[1];
  const audio = audios.find(track => track.id.endsWith(`-${suffix}`)) ||
    audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];

  if (!audio) throw new Error('No audio track found.');
  return { video, audio };
}

export function parseIsoDuration(value) {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || '');
  if (!match) throw new Error('Unsupported video duration.');
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

export function buildSegments(track, presentationDuration, manifestUrl) {
  const count = Math.ceil(presentationDuration / (track.duration / track.timescale));
  const expand = (template, number) => template
    .replaceAll('$RepresentationID$', track.id)
    .replaceAll('$Number$', number);
  const urls = [new URL(expand(track.initialization, track.startNumber), manifestUrl).href];

  for (let offset = 0; offset < count; offset += 1) {
    urls.push(new URL(expand(track.media, track.startNumber + offset), manifestUrl).href);
  }
  return urls;
}

export class AdaptiveConcurrency {
  constructor({ initial = 8, minimum = 4, maximum = 64 } = {}) {
    this.value = initial;
    this.minimum = minimum;
    this.maximum = maximum;
    this.previousThroughput = null;
  }

  observe({ throughput, completed, errors, throttled = false }) {
    if (throttled || errors > 0) {
      this.value = Math.max(this.minimum, Math.floor(this.value / 2));
      this.previousThroughput = throughput;
      return this.value;
    }

    if (completed >= 16) {
      const gain = this.previousThroughput === null
        ? Infinity
        : (throughput - this.previousThroughput) / this.previousThroughput;
      if (gain >= 0.05) this.value = Math.min(this.maximum, this.value + 4);
      this.previousThroughput = throughput;
    }
    return this.value;
  }
}

export class ManifestStore {
  constructor() {
    this.byTab = new Map();
  }

  set(tabId, url) {
    if (tabId >= 0) this.byTab.set(tabId, url);
  }

  get(tabId) {
    return this.byTab.get(tabId) || null;
  }

  delete(tabId) {
    this.byTab.delete(tabId);
  }
}

const filenameReplacements = {
  '<': '＜',
  '>': '＞',
  ':': '：',
  '"': '＂',
  '/': '／',
  '\\': '＼',
  '|': '｜',
  '?': '？',
  '*': '＊'
};

export function sanitizeFilename(title) {
  const sanitized = title
    .replace(/[<>:"/\\|?*]/g, character => filenameReplacements[character])
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const safe = sanitized.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, '$&_');
  return `${safe || 'ntu-cool-video'}.mp4`;
}
