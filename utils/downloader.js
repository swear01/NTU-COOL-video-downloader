import { AdaptiveConcurrency } from './core.js';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function downloadAdaptive(tasks, onData, onProgress = () => {}) {
  const controller = new AdaptiveConcurrency();
  const queue = tasks.map(task => ({ ...task, attempts: 0 }));
  let active = 0;
  let completed = 0;
  let windowBytes = 0;
  let windowCompleted = 0;
  let windowStarted = performance.now();
  let stopped = false;
  const requests = new Set();

  return new Promise((resolve, reject) => {
    const pump = () => {
      if (stopped) return;
      if (completed === tasks.length) return resolve();
      while (active < controller.value && queue.length) run(queue.shift());
    };

    const stop = error => {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      for (const request of requests) request.abort();
      reject(error);
    };

    const run = async task => {
      active += 1;
      const request = new AbortController();
      const timeout = setTimeout(() => request.abort(), 30000);
      requests.add(request);
      try {
        const response = await fetch(task.url, { signal: request.signal });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.throttled = response.status === 429 || response.status === 503;
          throw error;
        }
        const buffer = await response.arrayBuffer();
        await onData(task, buffer);
        completed += 1;
        windowCompleted += 1;
        windowBytes += buffer.byteLength;

        if (windowCompleted >= 16) {
          const elapsed = Math.max(performance.now() - windowStarted, 1) / 1000;
          controller.observe({ throughput: windowBytes / elapsed, completed: windowCompleted, errors: 0 });
          windowBytes = 0;
          windowCompleted = 0;
          windowStarted = performance.now();
        }
        onProgress({ completed, total: tasks.length, concurrency: controller.value });
      } catch (error) {
        if (stopped) return;
        task.attempts += 1;
        controller.observe({ throughput: 0, completed: 0, errors: 1, throttled: error.throttled });
        if (task.attempts >= 3) return stop(error);
        await sleep(error.throttled ? 1000 * task.attempts : 250 * task.attempts);
        if (!stopped) queue.unshift(task);
      } finally {
        clearTimeout(timeout);
        requests.delete(request);
        active -= 1;
        pump();
      }
    };

    pump();
  });
}
