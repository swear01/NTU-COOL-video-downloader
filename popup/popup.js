const button = document.getElementById('download');
const progress = document.getElementById('progress');
const status = document.getElementById('status');
const title = document.getElementById('title');
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = t('extensionName');
title.textContent = t('extensionName');
button.textContent = t('downloadVideo');
status.textContent = t('lookingForVideo');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

function show(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function render(job) {
  if (!job) return;
  if (job.state === 'preparing') show(t('preparingDownload'));
  if (job.state === 'downloading') {
    progress.hidden = false;
    progress.value = job.progress;
    show(t('downloadingFragments', String(job.progress)));
  }
  if (job.state === 'processing') show(t('combiningAudioVideo'));
  if (job.state === 'saving') show('');
  if (job.state === 'complete') show('');
  if (job.state === 'error') show(job.errorKey ? t(job.errorKey) : job.error || t('downloadFailed'), true);
  button.disabled = !['complete', 'error'].includes(job.state);
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ action: 'getStatus', tabId: tab.id });
  button.disabled = !response.found;
  if (!response.found) show(t('noNativeVideo'), true);
  else if (!response.job) show(t('videoFound'));
  if (response.found) render(response.job);
}

button.addEventListener('click', async () => {
  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  show(t('preparingDownload'));
  const response = await chrome.runtime.sendMessage({
    action: 'startDownload',
    tabId: tab.id,
    title: tab.title
  });
  if (!response.success) show(response.errorKey ? t(response.errorKey) : response.error || t('downloadFailed'), true);
});

await refresh();
setInterval(refresh, 500);
