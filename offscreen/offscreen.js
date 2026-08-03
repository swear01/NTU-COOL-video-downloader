import { downloadAdaptive } from '../utils/downloader.js';
import { parseMpd } from '../utils/mpd.js';
import { Remuxer } from '../utils/remuxer.js';

let busy = false;
const objectUrls = new Set();

async function download({ tabId, manifestUrl, filename }) {
  if (busy) throw new Error('Another video download is already running.');
  busy = true;
  try {
    const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Unable to read video manifest (HTTP ${response.status}).`);
    const manifest = parseMpd(await response.text(), response.url || manifestUrl);
    const initialization = {};
    await downloadAdaptive([
      { kind: 'video', url: manifest.video.segments[0] },
      { kind: 'audio', url: manifest.audio.segments[0] }
    ], (task, buffer) => { initialization[task.kind] = buffer; });
    const remuxer = new Remuxer(initialization.video, initialization.audio);
    const tasks = [];
    for (const kind of ['video', 'audio']) {
      manifest[kind].segments.slice(1).forEach((url, index) => tasks.push({ kind, index, url }));
    }

    await downloadAdaptive(
      tasks,
      (task, buffer) => remuxer.append(task.kind, task.index, buffer),
      progress => chrome.runtime.sendMessage({
        target: 'background',
        action: 'progress',
        tabId,
        status: {
          state: 'downloading',
          progress: Math.round(progress.completed / progress.total * 100),
          concurrency: progress.concurrency
        }
      })
    );

    chrome.runtime.sendMessage({
      target: 'background',
      action: 'progress',
      tabId,
      status: { state: 'processing', progress: 100 }
    });
    const url = URL.createObjectURL(new Blob([remuxer.finish()], { type: 'video/mp4' }));
    objectUrls.add(url);
    await chrome.runtime.sendMessage({ target: 'background', action: 'ready', tabId, filename, url });
  } finally {
    busy = false;
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message.target !== 'offscreen') return;
  if (message.action === 'release') {
    URL.revokeObjectURL(message.url);
    objectUrls.delete(message.url);
    return;
  }
  if (message.action === 'download') {
    download(message).catch(error => chrome.runtime.sendMessage({
      target: 'background',
      action: 'progress',
      tabId: message.tabId,
      status: { state: 'error', error: error.message }
    }));
  }
});
