export async function hasOffscreenDocument(chromeApi, path) {
  const contexts = await chromeApi.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chromeApi.runtime.getURL(path)]
  });
  return contexts.length > 0;
}
