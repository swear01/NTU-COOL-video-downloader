import { DownloadControl, downloadAdaptive } from '../utils/downloader.js';
import { parseMpd } from '../utils/mpd.js';
import { Remuxer } from '../utils/remuxer.js';
import { errorStatus } from '../utils/diagnostics.js';

let current = null;
const objectUrls = new Set();

async function download({ jobId, tabId, manifestUrl, filename }) {
  if (current) throw new Error('Another video download is already running.');
  const source = jobId ?? tabId;
  const control = new DownloadControl();
  current = { source, control };
  let stage = 'manifest';
  let blobUrl;
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
    stage = 'parse';
    const manifest = parseMpd(new TextDecoder().decode(manifestBuffer), manifestBaseUrl);
    stage = 'init';
    const initialization = {};
    await downloadAdaptive([
      { kind: 'video', url: manifest.video.segments[0] },
      { kind: 'audio', url: manifest.audio.segments[0] }
    ], (task, buffer) => { initialization[task.kind] = buffer; }, undefined, control);
    stage = 'remux';
    const remuxer = new Remuxer(initialization.video, initialization.audio);
    const tasks = [];
    const tails = [];
    for (const kind of ['video', 'audio']) {
      const segments = manifest[kind].segments.slice(1);
      segments.forEach((url, index) => (index === segments.length - 1 ? tails : tasks)
        .push({ kind, index, url }));
    }
    stage = 'segments';
    const append = (task, buffer) => {
      try { remuxer.append(task.kind, task.index, buffer); }
      catch (error) { error.stage = 'remux'; throw error; }
    };
    await downloadAdaptive(
      tasks,
      append,
      progress => chrome.runtime.sendMessage({
        target: 'background',
        action: 'progress',
        ...(jobId ? { jobId } : { tabId }),
        status: {
          state: 'downloading',
          progress: Math.round(progress.completed / (tasks.length + tails.length) * 100),
          concurrency: progress.concurrency,
          bytesPerSecond: progress.bytesPerSecond || 0
        }
      }),
      control
    );

    for (const tail of tails) {
      // GPAC's nominal segment count can include a nonexistent video tail.
      // Omit it only when every earlier segment already covers the init's declared duration.
      stage = 'remux';
      if (!remuxer.hasCompleteTrack(tail.kind, tail.index)) {
        stage = 'segments';
        await downloadAdaptive([tail], append, undefined, control);
      }
    }

    stage = 'remux';
    chrome.runtime.sendMessage({
      target: 'background',
      action: 'progress',
      ...(jobId ? { jobId } : { tabId }),
      status: { state: 'processing', progress: 100 }
    });
    const blob = remuxer.finish();
    if (control.state === 'canceled') throw new Error('Download canceled.');
    blobUrl = URL.createObjectURL(blob);
    objectUrls.add(blobUrl);
    stage = 'save';
    await chrome.runtime.sendMessage({
      target: 'background', action: 'ready', filename, url: blobUrl,
      ...(jobId ? { jobId } : { tabId })
    });
  } catch (error) {
    if (blobUrl) { URL.revokeObjectURL(blobUrl); objectUrls.delete(blobUrl); }
    error.stage ||= stage;
    throw error;
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
        status: errorStatus(error, 'dispatch')
      });
    });
  }
});
