import { ManifestStore, sanitizeFilename } from '../utils/core.js';
import { hasOffscreenDocument } from '../utils/offscreen.js';

const manifests = new ManifestStore();
const jobs = new Map();
const downloads = new Map();
const storageKey = tabId => `manifest:${tabId}`;
const jobKey = tabId => `job:${tabId}`;
const downloadKey = downloadId => `download:${downloadId}`;

async function setJob(tabId, job) {
  jobs.set(tabId, job);
  await chrome.storage.session.set({ [jobKey(tabId)]: job });
}

async function getJob(tabId) {
  if (jobs.has(tabId)) return jobs.get(tabId);
  const stored = await chrome.storage.session.get(jobKey(tabId));
  const job = stored[jobKey(tabId)] || null;
  if (job) jobs.set(tabId, job);
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

chrome.webRequest.onBeforeRequest.addListener(details => {
  const url = new URL(details.url);
  if (url.pathname.endsWith('/manifest.mpd')) setManifest(details.tabId, details.url);
}, { urls: ['https://*.dlc.ntu.edu.tw/*manifest.mpd*'] });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') deleteManifest(tabId);
});

chrome.tabs.onRemoved.addListener(tabId => deleteManifest(tabId));

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
  const download = await getDownload(delta.id);
  if (!download) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: download.url });
    await setJob(download.tabId, delta.state.current === 'complete'
      ? { state: 'complete', progress: 100 }
      : { state: 'error', error: delta.error?.current || 'Browser download was interrupted.' });
    downloads.delete(delta.id);
    await chrome.storage.session.remove(downloadKey(delta.id));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background' && message.action === 'progress') {
    setJob(message.tabId, message.status);
    return;
  }

  if (message.target === 'background' && message.action === 'ready') {
    (async () => {
      await setJob(message.tabId, { state: 'saving', progress: 100 });
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: false
      });
      await setDownload(downloadId, { url: message.url, tabId: message.tabId });
      sendResponse({ success: true });
    })().catch(async error => {
      await chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: message.url });
      await setJob(message.tabId, { state: 'error', error: error.message });
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
      await ensureOffscreenDocument();
      await setJob(message.tabId, { state: 'preparing', progress: 0 });
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'download',
        tabId: message.tabId,
        manifestUrl,
        filename: sanitizeFilename(message.title)
      });
      sendResponse({ success: true });
    })().catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
