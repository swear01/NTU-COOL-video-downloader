import { buildSegments, parseIsoDuration, selectTracks } from './core.js';

function child(element, name) {
  return Array.from(element.children).find(item => item.localName === name) || null;
}

function children(element, name) {
  return Array.from(element.children).filter(item => item.localName === name);
}

function resolveBase(parentBase, element) {
  const base = child(element, 'BaseURL')?.textContent.trim();
  return base ? new URL(base, parentBase).href : parentBase;
}

function templateAttributes(template) {
  if (!template) throw new Error('No DASH SegmentTemplate found.');
  if (child(template, 'SegmentTimeline')) throw new Error('SegmentTimeline videos are not supported yet.');
  return {
    initialization: template.getAttribute('initialization'),
    media: template.getAttribute('media'),
    timescale: Number(template.getAttribute('timescale') || 1),
    duration: Number(template.getAttribute('duration')),
    startNumber: Number(template.getAttribute('startNumber') || 1)
  };
}

export function parseMpd(xml, manifestUrl) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Invalid DASH manifest.');

  const mpd = document.documentElement;
  const period = child(mpd, 'Period');
  if (!period) throw new Error('No DASH period found.');

  const duration = parseIsoDuration(
    mpd.getAttribute('mediaPresentationDuration') || period.getAttribute('duration')
  );
  const mpdBase = resolveBase(manifestUrl, mpd);
  const periodBase = resolveBase(mpdBase, period);
  const representations = [];

  for (const adaptation of children(period, 'AdaptationSet')) {
    const adaptationBase = resolveBase(periodBase, adaptation);
    const inheritedTemplate = child(adaptation, 'SegmentTemplate');
    for (const representation of children(adaptation, 'Representation')) {
      const mimeType = representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || '';
      const kind = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : null;
      if (!kind) continue;
      representations.push({
        id: representation.getAttribute('id'),
        kind,
        width: Number(representation.getAttribute('width') || 0),
        height: Number(representation.getAttribute('height') || 0),
        bandwidth: Number(representation.getAttribute('bandwidth') || 0),
        baseUrl: resolveBase(adaptationBase, representation),
        ...templateAttributes(child(representation, 'SegmentTemplate') || inheritedTemplate)
      });
    }
  }

  const selected = selectTracks(representations);
  return {
    duration,
    video: { ...selected.video, segments: buildSegments(selected.video, duration, selected.video.baseUrl) },
    audio: { ...selected.audio, segments: buildSegments(selected.audio, duration, selected.audio.baseUrl) }
  };
}
