export function installContent28(runtime) {
  function rememberLocalResult(targetKey, result) {
    runtime.state.localResultCache.set(targetKey, result);
    if (runtime.state.localResultCache.size <= runtime.MAX_LOCAL_RESULT_CACHE) {
      return;
    }
    const firstKey = runtime.state.localResultCache.keys().next().value;
    if (firstKey) {
      runtime.state.localResultCache.delete(firstKey);
    }
  }
  runtime.rememberLocalResult = rememberLocalResult;
  function rememberEmbeddedImageCache(targetKey, dataUrl) {
    runtime.state.embeddedImageCache.set(targetKey, dataUrl);
    if (runtime.state.embeddedImageCache.size <= runtime.MAX_EMBEDDED_IMAGE_CACHE) {
      return;
    }
    const firstKey = runtime.state.embeddedImageCache.keys().next().value;
    if (firstKey) {
      runtime.state.embeddedImageCache.delete(firstKey);
    }
  }
  runtime.rememberEmbeddedImageCache = rememberEmbeddedImageCache;
  function getPayloadCache(targetKey) {
    const entry = runtime.state.payloadCacheByTargetKey.get(targetKey);
    if (!entry || typeof entry !== "object") {
      return null;
    }
    if (Date.now() - Number(entry.timestamp || 0) > runtime.PAYLOAD_CACHE_TTL_MS) {
      runtime.state.payloadCacheByTargetKey.delete(targetKey);
      return null;
    }
    return entry.payload || null;
  }
  runtime.getPayloadCache = getPayloadCache;
}
