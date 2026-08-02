import { ManifestStore, sanitizeFilename } from '../utils/core.js';

const manifests = new ManifestStore();
const jobs = new Map();
const downloads = new Map();
const storageKey = tabId => `manifest:${tabId}`;

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
  await chrome.storage.session.remove(storageKey(tabId));
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
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

chrome.downloads.onChanged.addListener(delta => {
  if (!downloads.has(delta.id) || !delta.state) return;
  const download = downloads.get(delta.id);
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'release', url: download.url });
    jobs.set(download.tabId, delta.state.current === 'complete'
      ? { state: 'complete', progress: 100 }
      : { state: 'error', error: delta.error?.current || 'Browser download was interrupted.' });
    downloads.delete(delta.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background' && message.action === 'progress') {
    jobs.set(message.tabId, message.status);
    return;
  }

  if (message.target === 'background' && message.action === 'ready') {
    chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: false })
      .then(downloadId => {
        downloads.set(downloadId, { url: message.url, tabId: message.tabId });
        jobs.set(message.tabId, { state: 'saving', progress: 100 });
      })
      .catch(error => jobs.set(message.tabId, { state: 'error', error: error.message }));
    return;
  }

  if (message.action === 'getStatus') {
    getManifest(message.tabId).then(url => sendResponse({
      found: Boolean(url),
      job: jobs.get(message.tabId) || null
    }));
    return true;
  }

  if (message.action === 'startDownload') {
    (async () => {
      const manifestUrl = await getManifest(message.tabId);
      if (!manifestUrl) throw new Error('No NTU COOL video found. Refresh the page and try again.');
      await ensureOffscreenDocument();
      jobs.set(message.tabId, { state: 'preparing', progress: 0 });
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
