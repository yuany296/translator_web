/**
 * 按块（气泡）翻译的旧批次入口的残留：只保留缓存键构造。
 *
 * 原先这里还有一个 `requestOpenAICompatibleTextTranslations`（整批翻译 + 批量缓存读写），
 * 从 translation-provider.js 搬出来是为了绕过行数门禁。它现在**没有任何调用方**——
 * 翻译统一走 canonical / 流式链路——却仍是 `runtime.CACHE_PREFIX`（`mt_cache_v21:`）
 * 的唯一消费者，容易被误认为还有一条活链路。已删除函数本体；缓存键构造仍被
 * tests/background_runtime.part03.test.mjs 使用，故保留。
 */
export function installTranslationBlockBatch(runtime) {
  function buildBlockTranslationCacheKey(sourceImageId, item, model, baseUrl, glossaryFingerprint = "") {
    const text = runtime.normalizeTextForLocalPaddle(item && item.original_text);
    const box = item && item.rawBox ? item.rawBox : item || {};
    const bbox = [box.left ?? box.x, box.top ?? box.y, box.width ?? box.w, box.height ?? box.h].map(value => Math.round(Number(value || 0) * 10) / 10).join(",");
    return `${runtime.CACHE_PREFIX}block:${runtime.hashString([sourceImageId || "unknown-image", text, bbox, model || "", baseUrl || "", glossaryFingerprint || ""].join("|"))}`;
  }
  runtime.buildBlockTranslationCacheKey = buildBlockTranslationCacheKey;
}
