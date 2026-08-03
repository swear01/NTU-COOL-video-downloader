import { AdaptiveConcurrency } from './core.js';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class DownloadControl {
  constructor() {
    this.state = 'running';
    this.requests = new Set();
    this.listeners = new Set();
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    for (const request of this.requests) request.abort();
    this.emit();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.emit();
  }

  cancel() {
    if (this.state === 'canceled') return;
    this.state = 'canceled';
    for (const request of this.requests) request.abort();
    this.emit();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener(this.state);
  }
}

export async function downloadAdaptive(tasks, onData, onProgress = () => {}, control = new DownloadControl()) {
  if (control.state === 'canceled') throw new Error('Download canceled.');
  const adaptive = new AdaptiveConcurrency();
  const queue = tasks.map(task => ({ ...task, attempts: 0 }));
  let active = 0;
  let completed = 0;
  let windowBytes = 0;
  let windowCompleted = 0;
  let windowStarted = performance.now();
  let stopped = false;
  const requests = new Set();

  return new Promise((resolve, reject) => {
    const finish = callback => value => {
      unsubscribe();
      callback(value);
    };
    const complete = finish(resolve);
    const fail = finish(reject);

    const pump = () => {
      if (stopped || control.state !== 'running') return;
      if (completed === tasks.length) return complete();
      while (active < adaptive.value && queue.length) run(queue.shift());
    };

    const stop = error => {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      for (const request of requests) request.abort();
      fail(error);
    };

    const unsubscribe = control.subscribe(state => {
      if (state === 'canceled') stop(new Error('Download canceled.'));
      if (state === 'running') pump();
    });

    const run = async task => {
      active += 1;
      const request = new AbortController();
      const timeout = setTimeout(() => request.abort(), 30000);
      requests.add(request);
      control.requests.add(request);
      try {
        const response = await fetch(task.url, { signal: request.signal });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.throttled = response.status === 429 || response.status === 503;
          throw error;
        }
        const buffer = await response.arrayBuffer();
        await onData(task, buffer, response.url || task.url);
        completed += 1;
        windowCompleted += 1;
        windowBytes += buffer.byteLength;

        if (windowCompleted >= 16) {
          const elapsed = Math.max(performance.now() - windowStarted, 1) / 1000;
          adaptive.observe({ throughput: windowBytes / elapsed, completed: windowCompleted, errors: 0 });
          windowBytes = 0;
          windowCompleted = 0;
          windowStarted = performance.now();
        }
        onProgress({ completed, total: tasks.length, concurrency: adaptive.value });
      } catch (error) {
        if (stopped) return;
        if (control.state === 'paused') {
          queue.unshift(task);
          return;
        }
        if (control.state === 'canceled') return stop(new Error('Download canceled.'));
        task.attempts += 1;
        adaptive.observe({ throughput: 0, completed: 0, errors: 1, throttled: error.throttled });
        if (task.attempts >= 3) return stop(error);
        await sleep(error.throttled ? 1000 * task.attempts : 250 * task.attempts);
        if (!stopped) queue.unshift(task);
      } finally {
        clearTimeout(timeout);
        requests.delete(request);
        control.requests.delete(request);
        active -= 1;
        pump();
      }
    };

    pump();
  });
}
