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

const templateAttributeNames = ['initialization', 'media', 'timescale', 'duration', 'startNumber'];

function readTemplateValues(template) {
  return Object.fromEntries(templateAttributeNames
    .filter(name => template?.hasAttribute(name))
    .map(name => [name, template.getAttribute(name)]));
}

export function mergeTemplateValues(parent = {}, own = {}) {
  const values = { ...parent, ...own };
  return {
    initialization: values.initialization,
    media: values.media,
    timescale: Number(values.timescale || 1),
    duration: Number(values.duration),
    startNumber: Number(values.startNumber || 1)
  };
}

function templateAttributes(parent, own) {
  if (!parent && !own) throw new Error('No DASH SegmentTemplate found.');
  if (child(own || parent, 'SegmentTimeline') || (parent && own && child(parent, 'SegmentTimeline'))) {
    throw new Error('SegmentTimeline videos are not supported yet.');
  }
  return mergeTemplateValues(readTemplateValues(parent), readTemplateValues(own));
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
        ...templateAttributes(inheritedTemplate, child(representation, 'SegmentTemplate'))
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
