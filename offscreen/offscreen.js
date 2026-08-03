import { DownloadControl, downloadAdaptive } from '../utils/downloader.js';
import { parseMpd } from '../utils/mpd.js';
import { Remuxer } from '../utils/remuxer.js';

let current = null;
const objectUrls = new Set();

async function download({ jobId, tabId, manifestUrl, filename }) {
  if (current) throw new Error('Another video download is already running.');
  const source = jobId ?? tabId;
  const control = new DownloadControl();
  current = { source, control };
  try {
    let manifestBuffer;
    let manifestBaseUrl;
    await downloadAdaptive(
      [{ url: manifestUrl }],
      (_task, buffer, responseUrl) => {
        manifestBuffer = buffer;
        manifestBaseUrl = responseUrl;
      },
      undefined,
      control
    );
    const manifest = parseMpd(new TextDecoder().decode(manifestBuffer), manifestBaseUrl);
    const initialization = {};
    await downloadAdaptive([
      { kind: 'video', url: manifest.video.segments[0] },
      { kind: 'audio', url: manifest.audio.segments[0] }
    ], (task, buffer) => { initialization[task.kind] = buffer; }, undefined, control);
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
        ...(jobId ? { jobId } : { tabId }),
        status: {
          state: 'downloading',
          progress: Math.round(progress.completed / progress.total * 100),
          concurrency: progress.concurrency
        }
      }),
      control
    );

    chrome.runtime.sendMessage({
      target: 'background',
      action: 'progress',
      ...(jobId ? { jobId } : { tabId }),
      status: { state: 'processing', progress: 100 }
    });
    const url = URL.createObjectURL(new Blob([remuxer.finish()], { type: 'video/mp4' }));
    objectUrls.add(url);
    if (control.state === 'canceled') throw new Error('Download canceled.');
    await chrome.runtime.sendMessage({
      target: 'background', action: 'ready', filename, url,
      ...(jobId ? { jobId } : { tabId })
    });
  } finally {
    current = null;
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message.target !== 'offscreen') return;
  if (message.action === 'release') {
    URL.revokeObjectURL(message.url);
    objectUrls.delete(message.url);
    return;
  }
  if (['pause', 'resume', 'cancel'].includes(message.action)) {
    if (current?.source !== (message.jobId ?? message.tabId)) return;
    current.control[message.action]();
    return;
  }
  if (message.action === 'download') {
    download(message).catch(error => {
      if (/canceled/i.test(error.message)) return;
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'progress',
        ...(message.jobId ? { jobId: message.jobId } : { tabId: message.tabId }),
        status: { state: 'error', error: error.message, errorKey: 'downloadFailed' }
      });
    });
  }
});
