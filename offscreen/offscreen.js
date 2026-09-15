import { discoverVideo } from '../utils/discovery.js';
import { DownloadControl, downloadAdaptive } from '../utils/downloader.js';
import { parseMpd } from '../utils/mpd.js';
import { Remuxer } from '../utils/remuxer.js';
import { errorStatus, redact } from '../utils/diagnostics.js';

const transfers = new Map();
const objectUrls = new Set();
const discoveries = new Map();

async function download({ jobId, tabId, manifestUrl, filename }) {
  const source = jobId ?? tabId;
  if (transfers.has(source) || transfers.size >= 2) throw new Error('Two video downloads are already running.');
  const control = new DownloadControl();
  transfers.set(source, control);
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
    let completedBefore = 0;
    const reportProgress = progress => chrome.runtime.sendMessage({
      target: 'background',
      action: 'progress',
      ...(jobId ? { jobId } : { tabId }),
      status: {
        state: 'downloading',
        progress: Math.round((completedBefore + progress.completed) / (tasks.length + tails.length) * 100),
        concurrency: progress.concurrency,
        bytesPerSecond: progress.bytesPerSecond || 0
      }
    });
    await downloadAdaptive(tasks, append, reportProgress, control);

    // Omit an estimated tail only when contiguous samples cover the init's duration.
    stage = 'remux';
    const pendingTails = tails.filter(tail => !remuxer.hasCompleteTrack(tail.kind, tail.index));
    stage = 'segments';
    completedBefore = tasks.length + tails.length - pendingTails.length;
    await downloadAdaptive(pendingTails, append, reportProgress, control);

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
    transfers.delete(source);
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message.target !== 'offscreen') return;
  if (message.action === 'discover') {
    const control = new AbortController();
    discoveries.set(message.jobId, control);
    discoverVideo(message.url, control.signal).then(result => {
      if (!control.signal.aborted) return chrome.runtime.sendMessage({
        target: 'background', action: 'discovered', jobId: message.jobId, ...result
      });
    }, error => {
      if (!control.signal.aborted) return chrome.runtime.sendMessage({
        target: 'background', action: 'discovered', jobId: message.jobId,
        status: { ...errorStatus(error, 'discovery'), errorKey: 'discoveryFailed' }
      });
    }).catch(error => {
      console.error('Failed to report video source resolution:', redact(error?.message || error));
    }).finally(() => {
      if (discoveries.get(message.jobId) === control) discoveries.delete(message.jobId);
    });
    return;
  }
  if (message.action === 'cancel') discoveries.get(message.jobId)?.abort();
  if (message.action === 'release') {
    URL.revokeObjectURL(message.url);
    objectUrls.delete(message.url);
    return;
  }
  if (['pause', 'resume', 'cancel'].includes(message.action)) {
    transfers.get(message.jobId ?? message.tabId)?.[message.action]();
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
