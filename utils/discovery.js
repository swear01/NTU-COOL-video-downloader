import { parseBatchUrls } from './core.js';

const videoOrigin = 'https://cool-video.dlc.ntu.edu.tw';

export async function discoverVideo(url, signal) {
  const parsed = parseBatchUrls(url);
  if (parsed.urls.length !== 1 || parsed.invalid.length || new URL(url).username || new URL(url).password) {
    throw new Error('Invalid COOL video page URL.');
  }
  let stage = 'page';
  const request = async (resource, options = {}) => {
    const response = await fetch(resource, { ...options, credentials: 'include', cache: 'no-store', signal });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} while resolving video source.`), {
      httpStatus: response.status, resource
    });
    return response;
  };
  try {
    const page = await request(url);
    const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
    const form = [...doc.forms].find(candidate => {
      let action;
      try { action = new URL(candidate.getAttribute('action') || '', page.url); }
      catch { return false; }
      return action.origin === videoOrigin && /^\/ltiv1p1\/launch\/videos\/\d+$/.test(action.pathname);
    });
    if (!form) throw Object.assign(new Error('No native COOL video authorization form. Check login and course access.'), {
      code: 'authorization_form_missing'
    });
    const body = new URLSearchParams();
    for (const input of form.querySelectorAll('input[name]')) body.append(input.name, input.value);
    stage = 'authorization';
    const launch = await request(new URL(form.getAttribute('action'), page.url).href, { method: 'POST', body });
    const player = new URL(launch.url);
    if (player.origin !== videoOrigin || !/^\/courses\/\d+\/videos\/\d+$/.test(player.pathname)) {
      throw Object.assign(new Error('COOL video authorization did not reach a player. Check login and course access.'), {
        code: 'authorization_failed'
      });
    }
    stage = 'metadata';
    const metadata = await (await request(`${videoOrigin}/api${player.pathname}/view`)).json();
    let source;
    try { source = new URL(metadata?.sourceUri); }
    catch {
      throw Object.assign(new Error('COOL returned an unsupported video source.'), { code: 'unsupported_source' });
    }
    const trustedHost = source.hostname === 'dlc.ntu.edu.tw' || source.hostname.endsWith('.dlc.ntu.edu.tw');
    if (source.protocol !== 'https:' || !trustedHost ||
        source.username || source.password || !source.pathname.endsWith('/manifest.mpd')) {
      throw Object.assign(new Error('COOL returned an unsupported video source.'), { code: 'unsupported_source' });
    }
    return { manifestUrl: source.href, title: metadata.title || doc.title };
  } catch (error) {
    if (stage === 'metadata' && error instanceof SyntaxError) {
      error = Object.assign(new Error('COOL returned invalid video metadata. Check login and course access.'), {
        code: 'invalid_metadata'
      });
    }
    error.stage = `discovery_${stage}`;
    throw error;
  }
}
