/**
 * canonical 译文缓存的批量查询。
 *
 * 原先每个 canonical 都要 `await getCache()` 一次：一页 30 个气泡就是 30 次
 * chrome.storage 往返，全部串行发生在 LLM 请求之前，是每页固定开销。
 * 这里先把指纹与缓存键一次性算好，再用一次批量读取拿回命中的译文。
 */
export function installTranslationCacheLookup(runtime) {
  async function lookupCanonicalTranslationCache({ items, force = false, fingerprintArgs = {} } = {}) {
    const list = Array.isArray(items) ? items : [];
    const entries = list.map(item => {
      const translationFingerprint = runtime.buildCanonicalTranslationFingerprint({
        originalText: item && item.original_text,
        ...fingerprintArgs
      });
      return {
        item,
        translationFingerprint,
        cacheKey: `${runtime.CANONICAL_TRANSLATION_CACHE_PREFIX}${translationFingerprint}`,
        cached: null
      };
    });
    if (force || entries.length === 0) return entries;
    let cachedByKey = new Map();
    try {
      cachedByKey = await runtime.getCacheMany(entries.map(entry => entry.cacheKey));
    } catch (error) {
      // 缓存是可选加速层：批量读失败就当作全部未命中，不能挡住翻译。
      console.warn("[MangaTranslator] Batch cache lookup failed; translating anyway.", runtime.getErrorMessage(error));
      return entries;
    }
    return entries.map(entry => ({
      ...entry,
      cached: cachedByKey.get(entry.cacheKey) || null
    }));
  }
  runtime.lookupCanonicalTranslationCache = lookupCanonicalTranslationCache;
}
