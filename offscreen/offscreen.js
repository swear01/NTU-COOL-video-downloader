import { discoverVideo } from '../utils/discovery.js';
import { DownloadControl, downloadAdaptive } from '../utils/downloader.js';
import { parseMpd } from '../utils/mpd.js';
import { Remuxer } from '../utils/remuxer.js';
import { errorStatus, redact } from '../utils/diagnostics.js';

const transfers = new Map();
const objectUrls = new Map();
const waiting = new Map();
const discoveries = new Map();

function pump() {
  for (const [source, entry] of waiting) {
    if (transfers.size >= 2) break;
    if (!entry.ready || entry.control.state !== 'running') continue;
    waiting.delete(source);
    transfers.set(source, entry.control);
    download(entry.message, entry.control).catch(error => {
      console.error('Failed to report download status:', redact(error?.message || error));
    });
  }
}

async function enqueue(message) {
  const source = message.jobId ?? message.tabId;
  if (transfers.has(source) || waiting.has(source)) return;
  const entry = { message, control: new DownloadControl(), ready: false };
  waiting.set(source, entry);
  try {
    await chrome.runtime.sendMessage({
      target: 'background', action: 'progress',
      ...(message.jobId ? { jobId: message.jobId } : { tabId: message.tabId }),
      status: { state: 'waiting', progress: 0 }
    });
    entry.ready = true;
    pump();
  } catch (error) {
    if (waiting.get(source) !== entry) return;
    waiting.delete(source);
    await chrome.runtime.sendMessage({
      target: 'background', action: 'progress',
      ...(message.jobId ? { jobId: message.jobId } : { tabId: message.tabId }),
      status: errorStatus(error, 'dispatch')
    });
  }
}

async function download({ jobId, tabId, manifestUrl, filename }, control) {
  const source = jobId ?? tabId;
  let stage = 'manifest';
  let blobUrl;
  try {
    await chrome.runtime.sendMessage({
      target: 'background', action: 'progress',
      ...(jobId ? { jobId } : { tabId }),
      status: { state: 'preparing', progress: 0 }
    });
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
    objectUrls.set(blobUrl, { source, control });
    stage = 'save';
    await chrome.runtime.sendMessage({
      target: 'background', action: 'ready', filename, url: blobUrl,
      ...(jobId ? { jobId } : { tabId })
    });
  } catch (error) {
    if (blobUrl) { URL.revokeObjectURL(blobUrl); objectUrls.delete(blobUrl); }
    if (control.state !== 'canceled') {
      error.stage ||= stage;
      await chrome.runtime.sendMessage({
        target: 'background', action: 'progress',
        ...(jobId ? { jobId } : { tabId }),
        status: errorStatus(error, 'dispatch')
      });
    }
  } finally {
    if (!blobUrl || !objectUrls.has(blobUrl)) {
      if (transfers.get(source) === control) transfers.delete(source);
      pump();
    }
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
    const entry = objectUrls.get(message.url);
    objectUrls.delete(message.url);
    if (entry && transfers.get(entry.source) === entry.control) transfers.delete(entry.source);
    pump();
    return;
  }
  if (['pause', 'resume', 'cancel'].includes(message.action)) {
    const source = message.jobId ?? message.tabId;
    (transfers.get(source) || waiting.get(source)?.control)?.[message.action]();
    if (message.action === 'cancel') waiting.delete(source);
    pump();
    return;
  }
  if (message.action === 'download') {
    enqueue(message).catch(error => {
      console.error('Failed to queue download:', redact(error?.message || error));
    });
  }
});
