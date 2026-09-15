import { activeBatchItem, batchProgress, formatSpeed, parseBatchUrls } from '../utils/core.js';
import { batchReport, formatError } from '../utils/diagnostics.js';

const element = id => document.getElementById(id);
const urls = element('urls');
const start = element('start');
const pause = element('pause');
const stop = element('stop');
const retry = element('retry');
const error = element('error');
const fallback = element('copyText');
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
const rows = new Map();
let batch = null;
let revision = 0;
let busy = false;

function text(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = t('batchTitle');
element('title').textContent = t('batchTitle');
urls.placeholder = t('batchPlaceholder');
urls.setAttribute('aria-label', t('batchPlaceholder'));
for (const key of ['start', 'pause', 'stop', 'retry', 'copyFailed', 'copyReport', 'exportReport']) {
  element(key).textContent = t(key);
}
element('progress').setAttribute('aria-label', t('overallProgress'));
fallback.setAttribute('aria-label', t('copyFallback'));

function render(next) {
  batch = next;
  const state = batch?.state || 'idle';
  const active = ['running', 'paused'].includes(state);
  const items = batch?.items || [];
  element('progress').value = batchProgress(items);
  const current = activeBatchItem(items);
  text(element('detail'), current ? t('batchProgressDetail', [String(current.index + 1),
    String(items.length), String(Math.round(current.item.progress || 0)),
    formatSpeed(current.item.bytesPerSecond)]) : '');
  urls.readOnly = active;
  start.disabled = busy || state === 'running' || (state !== 'paused' && !urls.value.trim());
  pause.disabled = busy || state !== 'running';
  stop.disabled = busy || !active;
  const failed = items.filter(item => item.state === 'error').length;
  retry.disabled = busy || active || !failed;
  element('copyFailed').disabled = !failed;
  element('copyReport').disabled = element('exportReport').disabled = !items.length;
  text(element('summary'), (batch?.archived ? t('previousBatch') + ' · ' : '') +
    ['complete', 'error', 'canceled'].map(value =>
      `${t('state_' + value)}: ${items.filter(item => item.state === value).length}`).join(' · '));
  text(element('storageError'), batch?.storageError ? `${t('reportSaveFailed')} ${batch.storageError}` : '');
  const ids = new Set(items.map(item => item.id));
  for (const [id, row] of rows) {
    if (!ids.has(id)) { row.root.remove(); rows.delete(id); }
  }
  for (const [index, item] of items.entries()) {
    let row = rows.get(item.id);
    if (!row) {
      const root = document.createElement('details');
      const heading = document.createElement('summary');
      const link = document.createElement('p');
      const diagnostics = document.createElement('pre');
      root.append(heading, link, diagnostics);
      row = { root, heading, link, diagnostics };
      rows.set(item.id, row);
      element('results').append(root);
    }
    text(row.heading, `${index + 1}. ${item.title || item.url} · ${t('state_' + item.state) || item.state}`);
    text(row.link, item.url);
    text(row.diagnostics, formatError(item, t) || (item.lastError ?
      `${t('previousError')}\n${formatError(item.lastError, t)}` : ''));
  }
}

async function refresh() {
  const requested = revision;
  const response = await chrome.runtime.sendMessage({ action: 'getBatchStatus' });
  if (response?.success === false) throw new Error(formatError(response, t));
  if (requested !== revision) return;
  if (!urls.value && response.batch?.items?.length) urls.value = response.batch.items.map(item => item.url).join('\n');
  render(response.batch);
}

async function action(name, extra = {}) {
  const response = await chrome.runtime.sendMessage({ action: name, ...extra });
  if (!response || response.success === false) throw new Error(formatError(response, t) || t('downloadFailed'));
  await refresh();
}

function onAction(id, callback) {
  element(id).addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    error.textContent = '';
    render(batch);
    try { await callback(); }
    catch (failure) { error.textContent = failure.message; }
    finally { busy = false; render(batch); }
  });
}

urls.addEventListener('input', () => {
  urls.classList.remove('invalid');
  error.textContent = '';
  render(batch);
});

async function permission() {
  if (!await chrome.permissions.request({ origins: ['https://cool.ntu.edu.tw/*'] })) {
    throw new Error(t('permissionDenied'));
  }
}

onAction('start', async () => {
  if (batch?.state === 'paused') return action('resumeBatch');
  const parsed = parseBatchUrls(urls.value);
  if (!parsed.urls.length || parsed.invalid.length) {
    urls.classList.add('invalid');
    throw new Error(t('invalidLinks'));
  }
  await permission();
  await action('startBatch', { urls: parsed.urls });
});
onAction('pause', () => action('pauseBatch'));
onAction('stop', () => action('stopBatch'));
onAction('retry', async () => { await permission(); await action('retryBatchFailures'); });

function report() {
  return JSON.stringify(batchReport(batch, chrome.runtime.getManifest().version), null, 2);
}

async function copy(value) {
  element('notice').textContent = '';
  fallback.value = value;
  try {
    await navigator.clipboard.writeText(value);
    fallback.hidden = true;
    element('notice').textContent = t('copied');
  } catch {
    fallback.hidden = false;
    fallback.focus();
    fallback.select();
    element('notice').textContent = t('copyFallback');
  }
}
element('copyFailed').addEventListener('click', () => copy(batch.items.filter(item => item.state === 'error').map(item => item.url).join('\n')));
element('copyReport').addEventListener('click', () => copy(report()));
element('exportReport').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([report()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cool-download-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.batch) return;
  revision += 1;
  render(changes.batch.newValue || null);
});
try { await refresh(); }
catch (failure) { error.textContent = failure.message; render(batch); }
