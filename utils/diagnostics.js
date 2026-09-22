export function redact(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s<>"']+/g, value => {
    try {
      const url = new URL(value);
      return url.origin + url.pathname;
    } catch {
      return '[URL]';
    }
  }).slice(0, 2048);
}

export function errorStatus(error, stage) {
  error ??= new Error('Unknown error');
  return {
    state: 'error', errorKey: 'downloadFailed', error: redact(error.message || error),
    errorDetails: {
      stage: error.stage || stage,
      code: error.code || (error.httpStatus ? 'http_error' : 'exception'),
      httpStatus: error.httpStatus,
      resource: error.resource && redact(error.resource),
      track: error.track,
      segment: error.segment,
      attempts: error.attempts,
      occurredAt: new Date().toISOString()
    }
  };
}

export function formatError(item, translate = key => key) {
  if (!item) return '';
  const summary = item.errorKey ? translate(item.errorKey) : '';
  const message = redact(item.error);
  const details = item.errorDetails;
  return [summary, message !== summary && message,
    details && Object.entries(details).filter(([, value]) => value != null)
      .map(([key, value]) => `${key}: ${redact(value)}`).join('\n')
  ].filter(Boolean).join('\n');
}

function reportError(item) {
  return {
    errorKey: item.errorKey, error: redact(item.error),
    errorDetails: item.errorDetails && Object.fromEntries(Object.entries(item.errorDetails)
      .map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]))
  };
}

export function batchReport(batch, version) {
  return {
    version, runId: batch.runId, state: batch.state, updatedAt: new Date().toISOString(),
    ...(batch.retryIds ? { retryIds: [...batch.retryIds] } : {}),
    items: batch.items.map(item => ({
      id: item.id, url: redact(item.url), title: redact(item.title), state: item.state,
      progress: item.progress, retryCount: item.retryCount || 0,
      ...reportError(item),
      lastError: item.lastError && reportError(item.lastError)
    }))
  };
}
