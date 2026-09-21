/**
 * 按块（气泡）翻译的旧批次入口：从 translation-provider.js 移出，避免那个文件超过行数门禁。
 *
 * 行为与原来一致，唯二改动：
 *   1. 缓存查询改成一次 `getCacheMany`（原先每个块一次 `await getCache`，N 个块 = N 次 storage 往返）；
 *   2. 缓存写在 `setCacheMany` 里批量完成。
 */
export function installTranslationBlockBatch(runtime) {
  function buildBlockTranslationCacheKey(sourceImageId, item, model, baseUrl, glossaryFingerprint = "") {
    const text = runtime.normalizeTextForLocalPaddle(item && item.original_text);
    const box = item && item.rawBox ? item.rawBox : item || {};
    const bbox = [box.left ?? box.x, box.top ?? box.y, box.width ?? box.w, box.height ?? box.h].map(value => Math.round(Number(value || 0) * 10) / 10).join(",");
    return `${runtime.CACHE_PREFIX}block:${runtime.hashString([sourceImageId || "unknown-image", text, bbox, model || "", baseUrl || "", glossaryFingerprint || ""].join("|"))}`;
  }
  runtime.buildBlockTranslationCacheKey = buildBlockTranslationCacheKey;

  async function requestOpenAICompatibleTextTranslations({
    items,
    apiKey,
    baseUrl,
    model,
    sourceImageId = "",
    glossary = null,
    glossaryFingerprint = ""
  }) {
    const result = new Map();
    const entries = (Array.isArray(items) ? items : []).map(item => ({
      item,
      cacheKey: buildBlockTranslationCacheKey(sourceImageId, item, model, baseUrl, glossaryFingerprint)
    }));
    let cachedByKey = new Map();
    try {
      cachedByKey = await runtime.getCacheMany(entries.map(entry => entry.cacheKey));
    } catch (error) {
      // 缓存是可选加速层：批量读失败当全未命中，不能挡住翻译。
      console.warn("[MangaTranslator] Block cache lookup failed; translating anyway.", runtime.getErrorMessage(error));
    }
    const uncachedItems = [];
    for (const entry of entries) {
      const cached = cachedByKey.get(entry.cacheKey);
      if (cached && typeof cached.translatedText === "string" && cached.translatedText.trim()) {
        result.set(entry.item.id, cached.translatedText.trim());
      } else {
        uncachedItems.push(entry.item);
      }
    }
    if (uncachedItems.length === 0) {
      return result;
    }
    const endpoint = runtime.buildOpenAICompatibleEndpoint(baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL);
    const body = {
      model: model || runtime.DEFAULT_TRANSLATION_MODEL, temperature: 0,
      messages: [
        { role: "system", content: "You are a manga dialogue translator. Translate grouped OCR blocks into the requested target language, obey every supplied glossary mapping, and return JSON only." },
        { role: "user", content: runtime.buildOpenAICompatibleTranslationPrompt(uncachedItems, glossary) }
      ],
      response_format: { type: "json_object" }
    };
    let payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, body);
    if (!payload) {
      const fallbackBody = { ...body };
      delete fallbackBody.response_format;
      payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, fallbackBody);
    }
    const text = runtime.extractOpenAIMessageText(payload).trim();
    const parsed = runtime.parseModelJson(text);
    const rows = parsed && Array.isArray(parsed.translations) ? parsed.translations : [];
    const cacheWrites = [];
    const cacheKeyById = new Map(entries.map(entry => [String(entry.item.id), entry.cacheKey]));
    for (const row of rows) {
      const id = String(row && row.id ? row.id : "").trim();
      const translatedText = String(row && row.translated_text ? row.translated_text : "").trim();
      if (!id || !translatedText) continue;
      result.set(id, translatedText);
      const cacheKey = cacheKeyById.get(id);
      if (cacheKey) cacheWrites.push([cacheKey, { translatedText }]);
    }
    if (cacheWrites.length > 0) {
      await runtime.setCacheMany(cacheWrites);
    }
    return result;
  }
  runtime.requestOpenAICompatibleTextTranslations = requestOpenAICompatibleTextTranslations;
}
