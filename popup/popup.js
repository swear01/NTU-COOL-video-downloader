const button = document.getElementById('download');
const progress = document.getElementById('progress');
const status = document.getElementById('status');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

function show(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function render(job) {
  if (!job) return;
  if (job.state === 'preparing') show('Preparing download…');
  if (job.state === 'downloading') {
    progress.hidden = false;
    progress.value = job.progress;
    show(`Downloading fragments… ${job.progress}%`);
  }
  if (job.state === 'processing') show('Combining audio and video…');
  if (job.state === 'saving') show('Sending file to browser downloads…');
  if (job.state === 'complete') show('Sent to browser downloads.');
  if (job.state === 'error') show(job.error || 'Download failed.', true);
  button.disabled = !['complete', 'error'].includes(job.state);
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ action: 'getStatus', tabId: tab.id });
  button.disabled = !response.found;
  if (!response.found) show('No native NTU COOL video found. Refresh the video page and try again.', true);
  else if (!response.job) show('Video found.');
  render(response.job);
}

button.addEventListener('click', async () => {
  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  show('Preparing download…');
  const response = await chrome.runtime.sendMessage({
    action: 'startDownload',
    tabId: tab.id,
    title: tab.title
  });
  if (!response.success) show(response.error || 'Download failed.', true);
});

await refresh();
setInterval(refresh, 500);
