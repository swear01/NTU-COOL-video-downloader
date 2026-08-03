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

export function parseBatchUrls(text) {
  const urls = [];
  const invalid = [];
  const seen = new Set();

  for (const value of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://cool.ntu.edu.tw' ||
          !/^\/courses\/\d+\/modules\/items\/\d+\/?$/.test(url.pathname)) {
        invalid.push(value);
        continue;
      }
      url.pathname = url.pathname.replace(/\/$/, '');
      url.search = '';
      url.hash = '';
      if (!seen.has(url.href)) {
        seen.add(url.href);
        urls.push(url.href);
      }
    } catch {
      invalid.push(value);
    }
  }
  return { urls, invalid };
}

export function batchProgress(items) {
  if (items.length === 0) return 0;
  const total = items.reduce((sum, item) => {
    if (item.state === 'complete' || item.state === 'error') return sum + 100;
    return sum + Math.max(0, Math.min(100, item.progress || 0));
  }, 0);
  return Math.round(total / items.length);
}

const activeBatchStates = new Set(['opening', 'preparing', 'downloading', 'processing', 'saving']);

export function activeBatchItem(items) {
  const index = items.findIndex(item => activeBatchStates.has(item.state));
  return index === -1 ? null : { index, item: items[index] };
}

export function formatSpeed(bytesPerSecond) {
  const rate = Math.max(0, Number(bytesPerSecond) || 0);
  if (rate < 1024) return `${Math.round(rate)} B/s`;
  if (rate < 1024 * 1024) return `${(rate / 1024).toFixed(1)} KB/s`;
  return `${(rate / (1024 * 1024)).toFixed(1)} MB/s`;
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
