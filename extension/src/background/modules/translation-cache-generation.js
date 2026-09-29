/**
 * 译文缓存代次（generation）管理。
 *
 * 起因：2026-09-21 的供应商流式截尾事故把 `游乐设施` 这类被截尾的值写进了
 * canonical 译文指纹缓存，而 `CACHE_TTL_MS` 是 7 天。指纹缓存的命中路径
 * （translation-cache-lookup.js）会直接渲染、不再请求模型，因此翻译护栏和
 * 官方译文库的修复都救不了浏览器里的旧值。
 *
 * 处理办法：换代次前缀让旧值不可读（background-state.js 的
 * `CANONICAL_TRANSLATION_CACHE_PREFIX`），再由这里把退役前缀的键真正删掉，
 * 避免它们继续占用 storage 配额直到 TTL 到期。
 *
 * 代价很小：`handleTranslateTextBlocks` 先读官方译文库，只有库里没有的源文
 * 才会因为换代次重新请求一次。
 */
export function installTranslationCacheGeneration(runtime) {
  function retiredPrefixes() {
    const list = runtime.RETIRED_TRANSLATION_CACHE_PREFIXES;
    return Array.isArray(list) ? list.map(prefix => String(prefix || "")).filter(Boolean) : [];
  }

  // 幂等：一个 service worker 生命周期内只真正扫一次；失败后允许下次重试。
  let prunePromise = null;
  function pruneRetiredTranslationCache() {
    if (prunePromise) return prunePromise;
    prunePromise = (async () => {
      const prefixes = retiredPrefixes();
      if (prefixes.length === 0) return { ok: true, removed: 0 };
      const store = await runtime.storageGet(null);
      const keys = Object.keys(store || {}).filter(key => prefixes.some(prefix => key.startsWith(prefix)));
      if (keys.length === 0) return { ok: true, removed: 0 };
      await runtime.storageRemove(keys);
      console.info(`[MangaTranslator] pruned ${keys.length} retired translation cache entries`);
      return { ok: true, removed: keys.length };
    })().catch(error => {
      prunePromise = null;
      const message = typeof runtime.getErrorMessage === "function" ? runtime.getErrorMessage(error) : String(error);
      console.warn("[MangaTranslator] prune retired translation cache failed:", message);
      return { ok: false, removed: 0, error: message };
    });
    return prunePromise;
  }
  runtime.pruneRetiredTranslationCache = pruneRetiredTranslationCache;

  /**
   * 只读体检：退役前缀是否真的清空了、当前代次有多少条、以及有多少条
   * 短到可疑的译文（截尾值的典型形状）。短译文本身不是证据，所以只作采样
   * 供人眼确认，不做任何自动删除。
   */
  async function auditTranslationCache() {
    const prefixes = retiredPrefixes();
    const canonicPrefix = String(runtime.CANONICAL_TRANSLATION_CACHE_PREFIX || "");
    const ocrPrefix = String(runtime.OCR_CACHE_PREFIX || "");
    const ttlMs = Number(runtime.CACHE_TTL_MS) || 0;
    const now = Date.now();
    const report = {
      retiredRemaining: 0,
      canonicalTranslation: 0,
      ocr: 0,
      otherCacheKeys: 0,
      stale: 0,
      suspects: []
    };
    try {
      const store = await runtime.storageGet(null);
      for (const key of Object.keys(store || {})) {
        if (prefixes.some(prefix => key.startsWith(prefix))) report.retiredRemaining += 1;
        else if (canonicPrefix && key.startsWith(canonicPrefix)) report.canonicalTranslation += 1;
        else if (ocrPrefix && key.startsWith(ocrPrefix)) report.ocr += 1;
        else if (runtime.TRANSLATION_CACHE_KEY_RE.test(key)) report.otherCacheKeys += 1;
        else continue;
        const entry = store[key];
        const timestamp = Number(entry && entry.timestamp) || 0;
        if (ttlMs > 0 && (!timestamp || now - timestamp > ttlMs)) report.stale += 1;
        if (!canonicPrefix || !key.startsWith(canonicPrefix)) continue;
        const text = String(entry && entry.value && entry.value.translatedText || "").trim();
        if (text && text.length <= 4 && report.suspects.length < 20) {
          report.suspects.push({ length: text.length, translatedText: text });
        }
      }
      return { ok: true, ...report };
    } catch (error) {
      const message = typeof runtime.getErrorMessage === "function" ? runtime.getErrorMessage(error) : String(error);
      return { ok: false, error: message, ...report };
    }
  }
  runtime.auditTranslationCache = auditTranslationCache;

  /** service worker 控制台一行体检：__mtCacheAudit() */
  function exposeConsoleHelper() {
    try {
      const scope = typeof globalThis === "undefined" ? null : globalThis;
      if (!scope || scope.__mtCacheAudit) return;
      scope.__mtCacheAudit = () => auditTranslationCache();
      scope.__mtPruneCache = () => pruneRetiredTranslationCache();
    } catch {
      // 控制台助手只是便利设施，注册失败不影响缓存代次本身
    }
  }
  runtime.exposeTranslationCacheConsoleHelper = exposeConsoleHelper;
  exposeConsoleHelper();
}
