import { ManifestStore, activeBatchItems, parseBatchUrls, sanitizeFilename } from '../utils/core.js';
import { hasOffscreenDocument } from '../utils/offscreen.js';
import { batchReport, errorStatus, redact } from '../utils/diagnostics.js';

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

async function previousBatch() {
  const { lastBatchReport } = await chrome.storage.local.get('lastBatchReport');
  if (!lastBatchReport) return null;
  return { ...lastBatchReport, state: 'idle', archived: true,
    items: lastBatchReport.items.map(item => ['complete', 'error', 'canceled'].includes(item.state)
      ? item : { ...item, state: 'canceled' }) };
}

async function saveBatchReport(batch) {
  try {
    await chrome.storage.local.set({ lastBatchReport: batchReport(batch, chrome.runtime.getManifest().version) });
    delete batch.storageError;
  } catch (error) {
    batch.storageError = redact(error.message);
  }
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
    const stateKey = () => `${batch.state}:${batch.items.map(item => item.state).join(',')}`;
    const before = stateKey();
    const value = mutation(batch);
    const after = stateKey();
    if (before !== after) await saveBatchReport(batch);
    await chrome.storage.session.set({ batch });
    return { batch, value };
  });
  batchMutations = operation.catch(() => {});
  return operation;
}

function replaceBatch(batch) {
  const operation = batchMutations.then(async () => {
    const old = await getBatch();
    if (['running', 'paused'].includes(old?.state)) throw new Error(chrome.i18n.getMessage('batchAlreadyActive'));
    await clearBatchJobs(old);
    await saveBatchReport(batch);
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
    item.error = job.error;
    item.errorDetails = job.errorDetails;
    return { runId: batch.runId, advance: batch.state === 'running' && ['complete', 'error'].includes(job.state) };
  });
  if (!updated?.value?.advance) return;
  void continueBatch(updated.value.runId).catch(() => {});
}

async function setJob(jobId, job) {
  if (typeof jobId === 'string' && jobId.startsWith('batch:')) {
    const batch = await getBatch();
    if (!['running', 'paused'].includes(batch?.state) ||
        !batch.items.some(item => item.jobId === jobId)) return;
  }
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

let offscreenSetup = null;

function ensureOffscreenDocument() {
  if (!offscreenSetup) {
    offscreenSetup = (async () => {
      if (await hasOffscreenDocument(chrome, 'offscreen/offscreen.html')) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['BLOBS', 'DOM_PARSER'],
        justification: 'Resolve authorized COOL video sources and combine DASH fragments.'
      });
    })().finally(() => { offscreenSetup = null; });
  }
  return offscreenSetup;
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
  if (jobId && !['running', 'paused'].includes(current?.value)) {
    await cancelOffscreenJob(jobId);
  } else if (current?.value === 'paused') {
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
    await setJob(item.jobId, errorStatus(error, 'dispatch'));
  }
}

async function advanceBatch(runId) {
  if (advancements.has(runId)) return advancements.get(runId);
  const advancement = (async () => {
    while (true) {
      const selected = await mutateBatch(runId, batch => {
        if (batch.state !== 'running') return { action: 'stop' };
        const active = activeBatchItems(batch.items);
        if (active.length >= 2) {
          return { action: 'wait' };
        }
        const item = batch.items.find(candidate => candidate.state === 'queued');
        if (!item) {
          if (active.length) return { action: 'wait' };
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
        continue;
      }
      try {
        await ensureOffscreenDocument();
        const accepted = await mutateBatch(runId, batch =>
          ['running', 'paused'].includes(batch.state) && batch.items.some(item =>
            item.jobId === action.item.jobId && item.state === 'opening'));
        if (!accepted?.value) return;
        chrome.alarms.create(batchAlarm(action.item.jobId), { delayInMinutes: 0.5 });
        await chrome.runtime.sendMessage({ target: 'offscreen', action: 'discover',
          jobId: action.item.jobId, url: action.item.url });
        const active = await mutateBatch(runId, batch =>
          ['running', 'paused'].includes(batch.state) && batch.items.some(item =>
            item.jobId === action.item.jobId && !['error', 'canceled'].includes(item.state)));
        if (!active?.value) {
          await cancelOffscreenJob(action.item.jobId);
        }
        continue;
      } catch (error) {
        await mutateBatch(runId, batch => {
          const item = batch.items.find(candidate => candidate.jobId === action.item.jobId && candidate.state === 'opening');
          if (item) {
            Object.assign(item, errorStatus(error, 'discovery'));
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

async function handleBatchDiscovery(message) {
  const updated = await mutateBatch(null, batch => {
    if (!['running', 'paused'].includes(batch.state)) return null;
    const item = batch.items.find(candidate => candidate.state === 'opening' && candidate.jobId === message.jobId);
    if (!item) return null;
    if (message.status?.state === 'error') Object.assign(item, message.status);
    else if (typeof message.manifestUrl !== 'string' || !message.manifestUrl) {
      Object.assign(item, errorStatus({ message: 'Video source resolution returned no manifest URL.',
        code: 'missing_manifest' }, 'discovery'), { errorKey: 'discoveryFailed' });
    } else {
      item.title = message.title || chrome.i18n.getMessage('untitledVideo');
      item.manifestUrl = message.manifestUrl;
      item.state = 'queued';
    }
    return { jobId: item.jobId, runId: batch.runId, running: batch.state === 'running' };
  });
  if (!updated?.value) return;
  await chrome.alarms.clear(batchAlarm(updated.value.jobId));
  if (updated.value.running) await continueBatch(updated.value.runId);
}

async function cancelOffscreenJob(jobId) {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancel', jobId });
  } catch (error) {
    if (!error?.message?.includes('Receiving end does not exist')) {
      console.error('Failed to cancel offscreen job:', redact(error?.message || error));
    }
  }
}

async function handleBatchTimeout(jobId) {
  const updated = await mutateBatch(null, batch => {
    const item = batch.items.find(candidate => candidate.jobId === jobId && candidate.state === 'opening');
    if (!item) return null;
    Object.assign(item, errorStatus({ message: 'Video source resolution did not finish within 30 seconds.',
      code: 'discovery_timeout' }, 'discovery'), { errorKey: 'discoveryTimeout' });
    return { runId: batch.runId, running: batch.state === 'running' };
  });
  if (!updated?.value) return;
  await cancelOffscreenJob(jobId);
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
  if (details.tabId >= 0) return setManifest(details.tabId, details.url);
}, { urls: ['https://*.dlc.ntu.edu.tw/*manifest.mpd*'] });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') deleteManifest(tabId);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await deleteManifest(tabId);
  const stored = await chrome.storage.session.get('batchPageTabId');
  if (stored.batchPageTabId === tabId) await chrome.storage.session.remove('batchPageTabId');
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
    : errorStatus({ message: delta.error?.current || 'Browser download was interrupted.',
      code: delta.error?.current || 'download_interrupted' }, 'save'));
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

async function settleControls(operations) {
  const results = await Promise.allSettled(operations);
  const errors = results.filter(result => result.status === 'rejected')
    .map(result => redact(result.reason?.message || result.reason));
  if (errors.length) throw new Error(errors.join('; '));
}

async function pauseBatch() {
  const updated = await mutateBatch(null, batch => {
    if (batch.state !== 'running') return null;
    batch.state = 'paused';
    return activeBatchItems(batch.items).filter(({ item }) => item.state !== 'opening')
      .map(({ item }) => ({ ...item }));
  });
  await settleControls((updated?.value || []).map(item =>
    item.state === 'saving' && item.downloadId != null ? chrome.downloads.pause(item.downloadId)
      : chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause', jobId: item.jobId })));
  return updated?.batch || null;
}

async function resumeBatch() {
  const updated = await mutateBatch(null, batch => {
    if (batch.state !== 'paused') return null;
    batch.state = 'running';
    return { items: activeBatchItems(batch.items).filter(({ item }) => item.state !== 'opening')
      .map(({ item }) => ({ ...item })), runId: batch.runId };
  });
  try {
    await settleControls((updated?.value?.items || []).map(item =>
      item.state === 'saving' && item.downloadId != null ? chrome.downloads.resume(item.downloadId)
        : chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume', jobId: item.jobId })));
  } finally {
    if (updated?.value) void continueBatch(updated.value.runId).catch(error => {
      console.error('Failed to resume batch:', redact(error?.message || error));
    });
  }
  return updated?.batch || null;
}

async function stopBatch() {
  const updated = await mutateBatch(null, batch => {
    const items = activeBatchItems(batch.items).map(({ item }) => ({ ...item }));
    batch.state = 'idle';
    batch.items = batch.items.map(candidate => ['complete', 'error'].includes(candidate.state)
      ? candidate : { id: candidate.id, jobId: candidate.jobId, url: candidate.url,
        title: candidate.title, state: 'canceled', progress: 0,
        retryCount: candidate.retryCount, lastError: candidate.lastError });
    return items;
  });
  if (!updated) return null;
  await clearBatchJobs(updated.batch);
  await settleControls(updated.value.map(async item => {
    await chrome.alarms.clear(batchAlarm(item.jobId));
    if (item?.downloadId != null) {
      try {
        const download = await getDownload(item.downloadId);
        if (download) {
          await removePendingFilename(download.url);
          downloads.delete(item.downloadId);
          await chrome.storage.session.remove(downloadKey(item.downloadId));
          await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: download.url });
        }
      } finally {
        await chrome.downloads.cancel(item.downloadId);
      }
    } else {
      await cancelOffscreenJob(item.jobId);
    }
  }));
  return updated.batch;
}

async function retryBatchFailures() {
  const operation = batchMutations.then(async () => {
    const old = await getBatch() || await previousBatch();
    if (!old || ['running', 'paused'].includes(old.state)) throw new Error(chrome.i18n.getMessage('noFinishedBatch'));
    if (!old.items.some(item => item.state === 'error')) throw new Error(chrome.i18n.getMessage('noFailedVideos'));
    const runId = crypto.randomUUID();
    const batch = { runId, state: 'running', items: old.items.map((item, index) => {
      const retry = item.state === 'error';
      return {
        id: item.id, jobId: `batch:${runId}:${index + 1}`, url: item.url, title: item.title,
        state: retry ? 'queued' : item.state, progress: retry ? 0 : item.progress,
        retryCount: (item.retryCount || 0) + (retry ? 1 : 0),
        lastError: retry ? { error: item.error, errorKey: item.errorKey, errorDetails: item.errorDetails } : item.lastError
      };
    }) };
    const parsed = parseBatchUrls(batch.items.map(item => item.url).join('\n'));
    if (parsed.invalid.length || !parsed.urls.length) throw new Error(chrome.i18n.getMessage('invalidLinks'));
    await clearBatchJobs(old);
    await saveBatchReport(batch);
    await chrome.storage.session.set({ batch });
    return batch;
  });
  batchMutations = operation.catch(() => {});
  const batch = await operation;
  await advanceBatch(batch.runId);
  return batch;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background' && message.action === 'discovered') {
    handleBatchDiscovery(message).then(() => sendResponse({ success: true }),
      error => sendResponse({ success: false, error: redact(error.message) }));
    return true;
  }
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
      await setJob(source, errorStatus(error, 'save'));
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
      await setJob(message.tabId, { ...errorStatus(error, 'dispatch'), errorKey });
      sendResponse({ success: false, error: error.message, errorKey });
    });
    return true;
  }

  if (message.action === 'getBatchStatus') {
    getBatch().then(async batch => sendResponse({ batch: batch || await previousBatch() }))
      .catch(error => sendResponse({ success: false, error: redact(error.message) }));
    return true;
  }

  if (message.action === 'retryBatchFailures') {
    retryBatchFailures().then(batch => sendResponse({ success: true, batch }))
      .catch(error => sendResponse({ success: false, error: redact(error.message), errorKey: 'downloadFailed' }));
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
    pauseBatch().then(batch => sendResponse({ batch }))
      .catch(error => sendResponse({ success: false, error: redact(error.message) }));
    return true;
  }

  if (message.action === 'resumeBatch') {
    resumeBatch().then(batch => sendResponse({ batch }))
      .catch(error => sendResponse({ success: false, error: redact(error.message) }));
    return true;
  }

  if (message.action === 'stopBatch') {
    stopBatch().then(batch => sendResponse({ batch }))
      .catch(error => sendResponse({ success: false, error: redact(error.message) }));
    return true;
  }
});

// Service worker modules cannot use top-level await. Register wake listeners
// synchronously, then restore the pending filename state in the background.
void restorePendingFilenames();
