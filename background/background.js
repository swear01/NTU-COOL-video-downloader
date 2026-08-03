import { ManifestStore, parseBatchUrls, sanitizeFilename } from '../utils/core.js';
import { hasOffscreenDocument } from '../utils/offscreen.js';

const manifests = new ManifestStore();
const jobs = new Map();
const downloads = new Map();
const filenames = new Map();
const storageKey = tabId => `manifest:${tabId}`;
const jobKey = jobId => `job:${jobId}`;
const downloadKey = downloadId => `download:${downloadId}`;
const batchAlarm = itemId => `batch-discovery:${itemId}`;
const batchJob = itemId => `batch:${itemId}`;
let advancingBatch = null;

async function getBatch() {
  return (await chrome.storage.session.get('batch')).batch || null;
}

async function setBatch(batch) {
  await chrome.storage.session.set({ batch });
}

async function updateBatchJob(jobId, job) {
  if (typeof jobId !== 'string' || !jobId.startsWith('batch:')) return;
  const batch = await getBatch();
  const item = batch?.items.find(candidate => batchJob(candidate.id) === jobId);
  if (!item) return;
  item.state = job.state;
  item.progress = job.progress || 0;
  item.errorKey = job.errorKey;
  await setBatch(batch);
  if (batch.state === 'running' && ['complete', 'error'].includes(job.state)) await advanceBatch();
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
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'download',
    ...(jobId ? { jobId } : { tabId }),
    manifestUrl,
    filename: sanitizeFilename(title)
  });
}

async function startBatchItem(batch, item) {
  item.state = 'downloading';
  item.progress = 0;
  await setBatch(batch);
  try {
    await dispatchDownload({
      jobId: batchJob(item.id),
      manifestUrl: item.manifestUrl,
      title: item.title
    });
  } catch (error) {
    await setJob(batchJob(item.id), {
      state: 'error', error: error.message, errorKey: 'downloadFailed'
    });
  }
}

async function advanceBatch() {
  if (advancingBatch) return advancingBatch;
  advancingBatch = (async () => {
    while (true) {
      const batch = await getBatch();
      if (!batch || batch.state !== 'running') return;
      if (batch.items.some(item => ['opening', 'preparing', 'downloading', 'processing', 'saving'].includes(item.state))) return;
      const item = batch.items.find(candidate => candidate.state === 'queued');
      if (!item) {
        batch.state = 'complete';
        await setBatch(batch);
        return;
      }
      if (item.manifestUrl) {
        await startBatchItem(batch, item);
        return;
      }
      item.state = 'opening';
      item.progress = 0;
      await setBatch(batch);
      try {
        const tab = await chrome.tabs.create({ url: item.url, active: false });
        const latest = await getBatch();
        const latestItem = latest?.items.find(candidate => candidate.id === item.id);
        if (!latestItem || latest.state === 'idle') {
          await chrome.tabs.remove(tab.id);
          return;
        }
        latestItem.tabId = tab.id;
        await setBatch(latest);
        chrome.alarms.create(batchAlarm(item.id), { delayInMinutes: 0.5 });
        return;
      } catch {
        item.state = 'error';
        item.errorKey = 'downloadFailed';
        await setBatch(batch);
      }
    }
  })().finally(() => { advancingBatch = null; });
  return advancingBatch;
}

async function handleBatchManifest(tabId, manifestUrl) {
  const batch = await getBatch();
  const item = batch?.items.find(candidate => candidate.state === 'opening' && candidate.tabId === tabId);
  if (!item) return;
  await chrome.alarms.clear(batchAlarm(item.id));
  const tab = await chrome.tabs.get(tabId);
  item.title = tab?.title || chrome.i18n.getMessage('untitledVideo');
  item.manifestUrl = manifestUrl;
  item.tabId = null;
  item.state = 'queued';
  await setBatch(batch);
  await chrome.tabs.remove(tabId);
  if (batch.state === 'running') await advanceBatch();
}

async function handleBatchTimeout(itemId) {
  const batch = await getBatch();
  const item = batch?.items.find(candidate => candidate.id === itemId && candidate.state === 'opening');
  if (!item) return;
  if (item.tabId != null) await chrome.tabs.remove(item.tabId).catch(() => {});
  item.tabId = null;
  item.state = 'error';
  item.errorKey = 'noNativeVideo';
  await setBatch(batch);
  if (batch.state === 'running') await advanceBatch();
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
  const batch = await getBatch();
  const item = batch?.items.find(candidate => candidate.state === 'opening' && candidate.tabId === tabId);
  if (!item) return;
  await chrome.alarms.clear(batchAlarm(item.id));
  item.tabId = null;
  item.state = 'error';
  item.errorKey = 'noNativeVideo';
  await setBatch(batch);
  if (batch.state === 'running') await advanceBatch();
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
  filenames.delete(download.url);
  const source = download.jobId ?? download.tabId;
  await setJob(source, delta.state.current === 'complete'
    ? { state: 'complete', progress: 100 }
    : { state: 'error', error: delta.error?.current || 'Browser download was interrupted.', errorKey: 'downloadFailed' });
  downloads.delete(delta.id);
  await chrome.storage.session.remove(downloadKey(delta.id));
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = filenames.get(item.url);
  suggest(filename ? { filename, conflictAction: 'uniquify' } : undefined);
});

async function updateBatchDownloadId(jobId, downloadId) {
  if (!jobId) return;
  const batch = await getBatch();
  const item = batch?.items.find(candidate => batchJob(candidate.id) === jobId);
  if (!item) return;
  item.downloadId = downloadId;
  await setBatch(batch);
}

async function pauseBatch() {
  const batch = await getBatch();
  if (!batch || batch.state !== 'running') return batch;
  batch.state = 'paused';
  await setBatch(batch);
  const item = batch.items.find(candidate => ['preparing', 'downloading', 'processing', 'saving'].includes(candidate.state));
  if (item?.state === 'saving' && item.downloadId != null) await chrome.downloads.pause(item.downloadId);
  else if (item) await chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause', jobId: batchJob(item.id) });
  return batch;
}

async function resumeBatch() {
  const batch = await getBatch();
  if (!batch || batch.state !== 'paused') return batch;
  batch.state = 'running';
  await setBatch(batch);
  const item = batch.items.find(candidate => ['preparing', 'downloading', 'processing', 'saving'].includes(candidate.state));
  if (item?.state === 'saving' && item.downloadId != null) await chrome.downloads.resume(item.downloadId);
  else if (item) await chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume', jobId: batchJob(item.id) });
  else await advanceBatch();
  return batch;
}

async function stopBatch() {
  const batch = await getBatch();
  if (!batch) return null;
  const item = batch.items.find(candidate => ['opening', 'preparing', 'downloading', 'processing', 'saving'].includes(candidate.state));
  batch.state = 'idle';
  batch.items = batch.items.map(candidate => ({ id: candidate.id, url: candidate.url, state: 'queued', progress: 0 }));
  await setBatch(batch);
  if (item?.tabId != null) {
    await chrome.alarms.clear(batchAlarm(item.id));
    await chrome.tabs.remove(item.tabId).catch(() => {});
  }
  if (item?.downloadId != null) {
    const download = await getDownload(item.downloadId);
    if (download) {
      await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: download.url });
      filenames.delete(download.url);
      downloads.delete(item.downloadId);
      await chrome.storage.session.remove(downloadKey(item.downloadId));
    }
    await chrome.downloads.cancel(item.downloadId);
  } else if (item && item.state !== 'opening') {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancel', jobId: batchJob(item.id) });
  }
  return batch;
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
        const item = batch?.items.find(candidate => batchJob(candidate.id) === message.jobId);
        if (!item || batch.state === 'idle') {
          await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: message.url });
          sendResponse({ success: false });
          return;
        }
      }
      const source = message.jobId ?? message.tabId;
      await setJob(source, { state: 'saving', progress: 100 });
      filenames.set(message.url, message.filename);
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: false
      });
      const download = { url: message.url, ...(message.jobId ? { jobId: message.jobId } : { tabId: message.tabId }) };
      await setDownload(downloadId, download);
      await updateBatchDownloadId(message.jobId, downloadId);
      if (message.jobId && (await getBatch())?.state === 'paused') await chrome.downloads.pause(downloadId);
      sendResponse({ success: true });
    })().catch(async error => {
      filenames.delete(message.url);
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
      const batch = {
        state: 'running',
        items: parsed.urls.map((url, index) => ({ id: String(index + 1), url, state: 'queued', progress: 0 }))
      };
      await setBatch(batch);
      await advanceBatch();
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
