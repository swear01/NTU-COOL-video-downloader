import { batchProgress, parseBatchUrls } from '../utils/core.js';

const urls = document.getElementById('urls');
const start = document.getElementById('start');
const pause = document.getElementById('pause');
const stop = document.getElementById('stop');
const progress = document.getElementById('progress');
const error = document.getElementById('error');
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
let batch = null;

document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = t('batchTitle');
document.getElementById('title').textContent = t('batchTitle');
urls.placeholder = t('batchPlaceholder');
urls.setAttribute('aria-label', t('batchPlaceholder'));
start.textContent = t('start');
pause.textContent = t('pause');
stop.textContent = t('stop');
progress.setAttribute('aria-label', t('overallProgress'));

function render(next) {
  batch = next;
  const state = batch?.state || 'idle';
  const running = state === 'running';
  const paused = state === 'paused';
  const active = running || paused;
  progress.value = batchProgress(batch?.items || []);
  urls.disabled = active;
  start.disabled = running || (!paused && !urls.value.trim());
  pause.disabled = !running;
  stop.disabled = !active;
  const failed = batch?.items?.filter(item => item.state === 'error').length || 0;
  error.textContent = batch?.errorKey
    ? t(batch.errorKey)
    : state === 'complete' && failed > 0 ? t('batchFailed', String(failed)) : '';
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ action: 'getBatchStatus' });
  if (!urls.value && response.batch?.items?.length) {
    urls.value = response.batch.items.map(item => item.url).join('\n');
  }
  render(response.batch);
}

urls.addEventListener('input', () => {
  urls.classList.remove('invalid');
  error.textContent = '';
  if (!batch || !['running', 'paused'].includes(batch.state)) start.disabled = !urls.value.trim();
});

start.addEventListener('click', async () => {
  if (batch?.state === 'paused') {
    await chrome.runtime.sendMessage({ action: 'resumeBatch' });
    return refresh();
  }
  const parsed = parseBatchUrls(urls.value);
  if (parsed.urls.length === 0 || parsed.invalid.length > 0) {
    urls.classList.add('invalid');
    error.textContent = t('invalidLinks');
    return;
  }
  const granted = await chrome.permissions.request({ origins: ['https://cool.ntu.edu.tw/*'] });
  if (!granted) {
    error.textContent = t('permissionDenied');
    return;
  }
  await chrome.runtime.sendMessage({ action: 'startBatch', urls: parsed.urls });
  await refresh();
});

pause.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'pauseBatch' });
  await refresh();
});

stop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stopBatch' });
  progress.value = 0;
  await refresh();
});

await refresh();
setInterval(refresh, 500);
