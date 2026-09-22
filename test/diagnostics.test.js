import test from 'node:test';
import assert from 'node:assert/strict';
import { batchReport, errorStatus, formatError } from '../utils/diagnostics.js';

test('keeps actionable errors while excluding signed URLs and runtime objects from reports', () => {
  const failure = errorStatus(Object.assign(new Error('HTTP 404 https://user:pass@media.example/video.m4s?token=secret#key'),
    { httpStatus: 404, resource: 'https://media.example/video.m4s?token=secret', track: 'video', segment: 295, attempts: 3 }), 'segments');
  const report = batchReport({ runId: 'one', state: 'complete', items: [{ id: '1',
    url: 'https://cool.ntu.edu.tw/courses/1/modules/items/2', title: 'Lecture',
    manifestUrl: 'https://media.example/manifest.mpd?secret', downloadId: 7, ...failure }] }, '1.2.2');
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /token|secret|pass|manifestUrl|downloadId/);
  assert.match(formatError(report.items[0], () => 'Download failed'), /Download failed\nHTTP 404/);
  assert.equal(report.items[0].errorDetails.segment, 295);
  assert.equal(report.items[0].errorDetails.stage, 'segments');
});

test('diagnostics tolerate missing errors and preserve zero-valued fields', () => {
  assert.equal(errorStatus(null, 'dispatch').error, 'Unknown error');
  assert.equal(errorStatus(undefined, 'dispatch').errorDetails.stage, 'dispatch');
  assert.match(formatError({ errorDetails: { attempts: 0 } }), /attempts: 0/);
});


test('persists the retry selection without retaining a mutable array reference', () => {
  const retryIds = ['22'];
  const report = batchReport({ runId: 'retry', state: 'complete', retryIds, items: [] }, '1.2.7');
  assert.deepEqual(report.retryIds, ['22']);
  retryIds.push('30');
  assert.deepEqual(report.retryIds, ['22']);
});
