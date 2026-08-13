import { ManifestStore, parseBatchUrls, sanitizeFilename } from '../utils/core.js';
import { hasOffscreenDocument } from '../utils/offscreen.js';

const manifests = new ManifestStore();
const jobs = new Map();
const downloads = new Map();
const storageKey = tabId => `manifest:${tabId}`;

// Filenames for the MP4s we hand to the browser download manager.
//
// chrome.downloads.onDeterminingFilename fires for EVERY download in the
// browser, and when several extensions have listeners Chrome lets the most
// recently installed extension decide the filename for all of them. Even
// suggest() with no arguments still counts as an override with an empty
// filename, so an always-registered listener would silently replace other
// downloader extensions' filenames with Chrome's defaults and show them the
// "Extension cannot name the downloaded file" conflict warning. We therefore
// register the listener only while one of our own downloads is waiting for
// its filename to be determined, and keep the pending entries in
// storage.session so worker suspension cannot strand them. In the brief
// window while the listener is registered, a download we did not start still
// receives a bare suggest() call (the API requires exactly one call); Chrome
// counts that as an empty override, so the window is kept as short as
// possible.
const pendingFilenamePrefix = 'pending-filename:';
const pendingFilenames = new Map(); // blob URL -> filename
let filenameDeterminer = null;

async function restorePendingFilenames() {
  try {
    const stored = await chrome.storage.session.get(null);
    for (const [key, filename] of Object.entries(stored)) {
      if (key.startsWith(pendingFilenamePrefix)) {
        pendingFilenames.set(key.slice(pendingFilenamePrefix.length), filename);
      }
    }
    syncFilenameDeterminer();
  } catch {
    // Best effort: a failed read only means the next download re-registers
    // the listener via setPendingFilename().
  }
}

async function setPendingFilename(url, filename) {
  pendingFilenames.set(url, filename);
  await chrome.storage.session.set({ [pendingFilenamePrefix + url]: filename });
  syncFilenameDeterminer();
}

async function removePendingFilename(url) {
  if (!pendingFilenames.delete(url)) return;
  await chrome.storage.session.remove(pendingFilenamePrefix + url);
  syncFilenameDeterminer();
}

function syncFilenameDeterminer() {
  if (pendingFilenames.size > 0) {
    if (filenameDeterminer === null) {
      filenameDeterminer = (item, suggest) => {
        const filename = pendingFilenames.get(item.url);
        if (filename) {
          suggest({ filename, conflictAction: 'uniquify' });
          void removePendingFilename(item.url);
        } else {
          suggest();
        }
      };
      chrome.downloads.onDeterminingFilename.addListener(filenameDeterminer);
    }
  } else if (filenameDeterminer !== null) {
    chrome.downloads.onDeterminingFilename.removeListener(filenameDeterminer);
    filenameDeterminer = null;
  }
}

const jobKey = jobId => `job:${jobId}`;
const downloadKey = downloadId => `download:${downloadId}`;
const batchAlarm = jobId => `batch-discovery:${jobId}`;
const advancements = new Map();
let batchMutations = Promise.resolve();

async function getBatch() {
  return (await chrome.storage.session.get('batch')).batch || null;
}

async function clearBatchJobs(batch) {
  const jobIds = batch?.items.map(item => item.jobId).filter(Boolean) || [];
  for (const jobId of jobIds) jobs.delete(jobId);
  if (jobIds.length > 0) await chrome.storage.session.remove(jobIds.map(jobKey));
}

function mutateBatch(runId, mutation) {
  const operation = batchMutations.then(async () => {
    const batch = await getBatch();
    if (!batch || (runId && batch.runId !== runId)) return null;
    const value = mutation(batch);
    await chrome.storage.session.set({ batch });
    return { batch, value };
  });
  batchMutations = operation.catch(() => {});
  return operation;
}

function replaceBatch(batch) {
  const operation = batchMutations.then(async () => {
    await clearBatchJobs(await getBatch());
    await chrome.storage.session.set({ batch });
    return batch;
  });
  batchMutations = operation.catch(() => {});
  return operation;
}

async function updateBatchJob(jobId, job) {
  if (typeof jobId !== 'string' || !jobId.startsWith('batch:')) return;
  const updated = await mutateBatch(null, batch => {
    const item = batch.items.find(candidate => candidate.jobId === jobId);
    if (!item || !['running', 'paused'].includes(batch.state)) return null;
    item.state = job.state;
    item.progress = job.progress || 0;
    item.bytesPerSecond = job.bytesPerSecond || 0;
    item.errorKey = job.errorKey;
    return { runId: batch.runId, advance: batch.state === 'running' && ['complete', 'error'].includes(job.state) };
  });
  if (!updated?.value?.advance) return;
  void continueBatch(updated.value.runId).catch(() => {});
}

async function setJob(jobId, job) {
  jobs.set(jobId, job);
  await chrome.storage.session.set({ [jobKey(jobId)]: job });
  await updateBatchJob(jobId, job);
}

async function getJob(jobId) {
  if (jobs.has(jobId)) return jobs.get(jobId);
  const stored = await chrome.storage.session.get(jobKey(jobId));
  const job = stored[jobKey(jobId)] || null;
  if (job) jobs.set(jobId, job);
  return job;
}

async function setDownload(downloadId, download) {
  downloads.set(downloadId, download);
  await chrome.storage.session.set({ [downloadKey(downloadId)]: download });
}

async function getDownload(downloadId) {
  if (downloads.has(downloadId)) return downloads.get(downloadId);
  const stored = await chrome.storage.session.get(downloadKey(downloadId));
  const download = stored[downloadKey(downloadId)] || null;
  if (download) downloads.set(downloadId, download);
  return download;
}

async function setManifest(tabId, url) {
  manifests.set(tabId, url);
  await chrome.storage.session.set({ [storageKey(tabId)]: url });
}

async function getManifest(tabId) {
  const cached = manifests.get(tabId);
  if (cached) return cached;
  const stored = await chrome.storage.session.get(storageKey(tabId));
  const url = stored[storageKey(tabId)] || null;
  if (url) manifests.set(tabId, url);
  return url;
}

async function deleteManifest(tabId) {
  manifests.delete(tabId);
  jobs.delete(tabId);
  await chrome.storage.session.remove([storageKey(tabId), jobKey(tabId)]);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument(chrome, 'offscreen/offscreen.html')) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Download and combine DASH video and audio fragments.'
  });
}

async function dispatchDownload({ jobId, tabId, manifestUrl, title }) {
  const source = jobId ?? tabId;
  await ensureOffscreenDocument();
  await setJob(source, { state: 'preparing', progress: 0 });
  if (jobId) {
    const active = await mutateBatch(null, batch =>
      ['running', 'paused'].includes(batch.state) && batch.items.some(item => item.jobId === jobId));
    if (!active?.value) throw new Error('Download canceled.');
  }
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'download',
    ...(jobId ? { jobId } : { tabId }),
    manifestUrl,
    filename: sanitizeFilename(title)
  });
  const current = jobId && await mutateBatch(null, batch =>
    batch.items.some(item => item.jobId === jobId) ? batch.state : null);
  if (current?.value === 'paused') {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause', jobId });
  }
}

async function startBatchItem(item) {
  try {
    await dispatchDownload({
      jobId: item.jobId,
      manifestUrl: item.manifestUrl,
      title: item.title
    });
  } catch (error) {
    await setJob(item.jobId, {
      state: 'error', error: error.message, errorKey: 'downloadFailed'
    });
  }
}

async function advanceBatch(runId) {
  if (advancements.has(runId)) return advancements.get(runId);
  const advancement = (async () => {
    while (true) {
      const selected = await mutateBatch(runId, batch => {
        if (batch.state !== 'running') return { action: 'stop' };
        if (batch.items.some(item => ['opening', 'preparing', 'downloading', 'processing', 'saving'].includes(item.state))) {
          return { action: 'wait' };
        }
        const item = batch.items.find(candidate => candidate.state === 'queued');
        if (!item) {
          batch.state = 'complete';
          return { action: 'complete' };
        }
        if (item.manifestUrl) {
          item.state = 'downloading';
          item.progress = 0;
          return { action: 'download', item: { ...item } };
        }
        item.state = 'opening';
        item.progress = 0;
        return { action: 'open', item: { ...item } };
      });
      const action = selected?.value;
      if (!action || ['stop', 'wait'].includes(action.action)) return;
      if (action.action === 'complete') {
        await clearBatchJobs(selected.batch);
        return;
      }
      if (action.action === 'download') {
        await startBatchItem(action.item);
        return;
      }
      try {
        const tab = await chrome.tabs.create({ url: action.item.url, active: false });
        const accepted = await mutateBatch(runId, batch => {
          const item = batch.items.find(candidate => candidate.jobId === action.item.jobId && candidate.state === 'opening');
          if (!item || batch.state === 'idle') return false;
          item.tabId = tab.id;
          return true;
        });
        if (!accepted?.value) {
          await chrome.tabs.remove(tab.id);
          return;
        }
        chrome.alarms.create(batchAlarm(action.item.jobId), { delayInMinutes: 0.5 });
        return;
      } catch {
        await mutateBatch(runId, batch => {
          const item = batch.items.find(candidate => candidate.jobId === action.item.jobId);
          if (item) {
            item.state = 'error';
            item.errorKey = 'downloadFailed';
          }
        });
      }
    }
  })();
  advancements.set(runId, advancement);
  const cleanup = () => {
    if (advancements.get(runId) === advancement) advancements.delete(runId);
  };
  advancement.then(cleanup, cleanup);
  return advancement;
}

async function continueBatch(runId) {
  const current = advancements.get(runId);
  if (current) await current.catch(() => {});
  return advanceBatch(runId);
}

async function handleBatchManifest(tabId, manifestUrl) {
  const tab = await chrome.tabs.get(tabId);
  const updated = await mutateBatch(null, batch => {
    const item = batch.items.find(candidate => candidate.state === 'opening' && candidate.tabId === tabId);
    if (!item) return null;
    item.title = tab?.title || chrome.i18n.getMessage('untitledVideo');
    item.manifestUrl = manifestUrl;
    item.tabId = null;
    item.state = 'queued';
    return { jobId: item.jobId, runId: batch.runId, running: batch.state === 'running' };
  });
  if (!updated?.value) return;
  await chrome.alarms.clear(batchAlarm(updated.value.jobId));
  await chrome.tabs.remove(tabId);
  if (updated.value.running) await continueBatch(updated.value.runId);
}

async function handleBatchTimeout(jobId) {
  const updated = await mutateBatch(null, batch => {
    const item = batch.items.find(candidate => candidate.jobId === jobId && candidate.state === 'opening');
    if (!item) return null;
    const tabId = item.tabId;
    item.tabId = null;
    item.state = 'error';
    item.errorKey = 'noNativeVideo';
    return { tabId, runId: batch.runId, running: batch.state === 'running' };
  });
  if (!updated?.value) return;
  if (updated.value.tabId != null) await chrome.tabs.remove(updated.value.tabId).catch(() => {});
  if (updated.value.running) await continueBatch(updated.value.runId);
}

async function openBatchPage() {
  const stored = await chrome.storage.session.get('batchPageTabId');
  if (stored.batchPageTabId != null) {
    try {
      await chrome.tabs.get(stored.batchPageTabId);
      await chrome.tabs.update(stored.batchPageTabId, { active: true });
      return;
    } catch {
      await chrome.storage.session.remove('batchPageTabId');
    }
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('batch/batch.html') });
  await chrome.storage.session.set({ batchPageTabId: tab.id });
}

async function setupContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'open-batch',
    title: chrome.i18n.getMessage('contextOpenBatch'),
    contexts: ['action']
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenu);

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'open-batch') return openBatchPage();
});

chrome.webRequest.onBeforeRequest.addListener(details => {
  return setManifest(details.tabId, details.url)
    .then(() => handleBatchManifest(details.tabId, details.url));
}, { urls: ['https://*.dlc.ntu.edu.tw/*manifest.mpd*'] });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') deleteManifest(tabId);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await deleteManifest(tabId);
  const stored = await chrome.storage.session.get('batchPageTabId');
  if (stored.batchPageTabId === tabId) await chrome.storage.session.remove('batchPageTabId');
  const updated = await mutateBatch(null, batch => {
    const item = batch.items.find(candidate => candidate.state === 'opening' && candidate.tabId === tabId);
    if (!item) return null;
    item.tabId = null;
    item.state = 'error';
    item.errorKey = 'noNativeVideo';
    return { jobId: item.jobId, runId: batch.runId, running: batch.state === 'running' };
  });
  if (!updated?.value) return;
  await chrome.alarms.clear(batchAlarm(updated.value.jobId));
  if (updated.value.running) await continueBatch(updated.value.runId);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith('batch-discovery:')) {
    return handleBatchTimeout(alarm.name.slice('batch-discovery:'.length));
  }
});

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
  const download = await getDownload(delta.id);
  if (!download) return;
  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: download.url });
  await removePendingFilename(download.url);
  const source = download.jobId ?? download.tabId;
  await setJob(source, delta.state.current === 'complete'
    ? { state: 'complete', progress: 100 }
    : { state: 'error', error: delta.error?.current || 'Browser download was interrupted.', errorKey: 'downloadFailed' });
  downloads.delete(delta.id);
  await chrome.storage.session.remove(downloadKey(delta.id));
});

async function updateBatchDownloadId(jobId, downloadId) {
  if (!jobId) return null;
  return mutateBatch(null, batch => {
    const item = batch.items.find(candidate => candidate.jobId === jobId);
    if (!item || !['running', 'paused'].includes(batch.state)) return false;
    item.downloadId = downloadId;
    return true;
  });
}

async function pauseBatch() {
  const updated = await mutateBatch(null, batch => {
    if (batch.state !== 'running') return null;
    batch.state = 'paused';
    const item = batch.items.find(candidate => ['preparing', 'downloading', 'processing', 'saving'].includes(candidate.state));
    return item ? { ...item } : null;
  });
  const item = updated?.value;
  if (item?.state === 'saving' && item.downloadId != null) await chrome.downloads.pause(item.downloadId);
  else if (item) await chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause', jobId: item.jobId });
  return updated?.batch || null;
}

async function resumeBatch() {
  const updated = await mutateBatch(null, batch => {
    if (batch.state !== 'paused') return null;
    batch.state = 'running';
    const item = batch.items.find(candidate => ['preparing', 'downloading', 'processing', 'saving'].includes(candidate.state));
    return { item: item ? { ...item } : null, runId: batch.runId };
  });
  const item = updated?.value?.item;
  if (item?.state === 'saving' && item.downloadId != null) await chrome.downloads.resume(item.downloadId);
  else if (item) await chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume', jobId: item.jobId });
  else if (updated?.value) await continueBatch(updated.value.runId);
  return updated?.batch || null;
}

async function stopBatch() {
  const updated = await mutateBatch(null, batch => {
    const item = batch.items.find(candidate => ['opening', 'preparing', 'downloading', 'processing', 'saving'].includes(candidate.state));
    batch.state = 'idle';
    batch.items = batch.items.map(candidate => ({
      id: candidate.id, jobId: candidate.jobId, url: candidate.url, state: 'queued', progress: 0
    }));
    return item ? { ...item } : null;
  });
  if (!updated) return null;
  const item = updated.value;
  await clearBatchJobs(updated.batch);
  if (item?.tabId != null) {
    await chrome.alarms.clear(batchAlarm(item.jobId));
    await chrome.tabs.remove(item.tabId).catch(() => {});
  }
  if (item?.downloadId != null) {
    const download = await getDownload(item.downloadId);
    if (download) {
      await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: download.url });
      await removePendingFilename(download.url);
      downloads.delete(item.downloadId);
      await chrome.storage.session.remove(downloadKey(item.downloadId));
    }
    await chrome.downloads.cancel(item.downloadId);
  } else if (item && item.state !== 'opening') {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancel', jobId: item.jobId });
  }
  return updated.batch;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background' && message.action === 'progress') {
    setJob(message.jobId ?? message.tabId, message.status)
      .then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.target === 'background' && message.action === 'ready') {
    (async () => {
      if (message.jobId) {
        const batch = await getBatch();
        const item = batch?.items.find(candidate => candidate.jobId === message.jobId);
        if (!item || !['running', 'paused'].includes(batch.state)) {
          await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: message.url });
          sendResponse({ success: false });
          return;
        }
      }
      const source = message.jobId ?? message.tabId;
      await setJob(source, { state: 'saving', progress: 100 });
      await setPendingFilename(message.url, message.filename);
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: false
      });
      const download = { url: message.url, ...(message.jobId ? { jobId: message.jobId } : { tabId: message.tabId }) };
      await setDownload(downloadId, download);
      const batchUpdate = await updateBatchDownloadId(message.jobId, downloadId);
      if (message.jobId && !batchUpdate?.value) {
        await chrome.downloads.cancel(downloadId);
        downloads.delete(downloadId);
        await chrome.storage.session.remove(downloadKey(downloadId));
        await removePendingFilename(message.url);
        await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: message.url });
        sendResponse({ success: false });
        return;
      }
      if (batchUpdate?.batch.state === 'paused') await chrome.downloads.pause(downloadId);
      sendResponse({ success: true });
    })().catch(async error => {
      await removePendingFilename(message.url);
      await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: message.url });
      const source = message.jobId ?? message.tabId;
      await setJob(source, {
        state: 'error', error: error.message, errorKey: 'downloadFailed'
      });
      sendResponse({ success: false });
    });
    return true;
  }

  if (message.action === 'getStatus') {
    Promise.all([getManifest(message.tabId), getJob(message.tabId)])
      .then(([url, job]) => sendResponse({ found: Boolean(url), job }));
    return true;
  }

  if (message.action === 'startDownload') {
    (async () => {
      const manifestUrl = await getManifest(message.tabId);
      if (!manifestUrl) throw new Error('No NTU COOL video found. Refresh the page and try again.');
      await dispatchDownload({ tabId: message.tabId, manifestUrl, title: message.title });
      sendResponse({ success: true });
    })().catch(async error => {
      const errorKey = /No NTU COOL video/.test(error.message) ? 'noNativeVideo' : 'downloadFailed';
      await setJob(message.tabId, { state: 'error', error: error.message, errorKey });
      sendResponse({ success: false, error: error.message, errorKey });
    });
    return true;
  }

  if (message.action === 'getBatchStatus') {
    getBatch().then(batch => sendResponse({ batch }));
    return true;
  }

  if (message.action === 'startBatch') {
    (async () => {
      const parsed = parseBatchUrls((message.urls || []).join('\n'));
      if (parsed.urls.length === 0 || parsed.invalid.length > 0) {
        sendResponse({ success: false, errorKey: 'invalidLinks' });
        return;
      }
      const runId = crypto.randomUUID();
      const batch = {
        runId,
        state: 'running',
        items: parsed.urls.map((url, index) => ({
          id: String(index + 1),
          jobId: `batch:${runId}:${index + 1}`,
          url,
          state: 'queued',
          progress: 0
        }))
      };
      await replaceBatch(batch);
      await advanceBatch(runId);
      sendResponse({ success: true });
    })().catch(error => sendResponse({ success: false, error: error.message, errorKey: 'downloadFailed' }));
    return true;
  }

  if (message.action === 'pauseBatch') {
    pauseBatch().then(batch => sendResponse({ batch }));
    return true;
  }

  if (message.action === 'resumeBatch') {
    resumeBatch().then(batch => sendResponse({ batch }));
    return true;
  }

  if (message.action === 'stopBatch') {
    stopBatch().then(batch => sendResponse({ batch }));
    return true;
  }
});

// Restore pending filenames only after every wake listener above is
// registered synchronously. Chrome queues events until the worker finishes
// its initial evaluation, so the onDeterminingFilename listener below is in
// place before any download's filename can be determined.
await restorePendingFilenames();
