/**
 * Novel translation cache integration.
 *
 * Flow: extract paragraphs -> normalize -> hash -> query IndexedDB by
 * (workId, chapterId, sourceHash) with the current translation-config
 * fingerprint -> reuse exact and stale-config hits -> API only the missing ->
 * auto-save records. Cache status on page load drives the novel ball state
 * (cached / partial / idle) without calling the API.
 */
import sharedUtils from "../../shared/utils.js";

export function installNovelCache(runtime) {
  function buildRecordId(workId, chapterId, sourceText, paragraphKey = "") {
    const normalized = runtime.normalizeTranslationCacheText(sourceText);
    return runtime.buildNovelCacheRecordId(
      workId, chapterId, runtime.computeTranslationCacheHash(normalized), paragraphKey,
      runtime.resolveSourceLanguage?.(sourceText) || "auto"
    );
  }

  function classify(record, fingerprint) {
    return runtime.classifyTranslationCacheMatch(record, fingerprint);
  }

  function isUsableMatch(match) {
    return match === "exact" || match === "stale-config";
  }

  async function applyCachedNovelTranslations(chapter, state, options = {}) {
    if (!chapter || !state) return { hit: 0, total: 0 };
    const targetLanguage = runtime.getTargetLanguage?.() || "zh-CN";
    const items = chapter.paragraphs.filter(item => {
      const sourceLanguage = runtime.resolveSourceLanguage?.(item.original_text) || "auto";
      return !state.translations.has(item.id) && (sourceLanguage === "auto" || sourceLanguage !== targetLanguage);
    });
    if (!items.length || options.force) return { hit: 0, total: 0 };
    const ids = items.map(item => buildRecordId(
      chapter.seriesId, chapter.chapterId, item.original_text, item.paragraphKey
    ));
    const records = await runtime.getTranslationCacheRecords(ids);
    const fingerprint = await runtime.getTranslationConfigFingerprint("novel", typeof location !== "undefined" ? location.href : "");
    let hit = 0;
    let stale = 0;
    items.forEach((item, index) => {
      const match = classify(records.get(ids[index]), fingerprint);
      if (!isUsableMatch(match)) return;
      // 旧译文缺少对话引号时直接就地修补,不重译。
      const translated = sharedUtils.restoreDialogueQuotes(
        item.original_text,
        String(records.get(ids[index]).translatedText).trim()
      );
      state.translations.set(item.id, translated);
      // 命中缓存即按"显示译文"意图渲染:首次点击时 state.showTranslation 尚未翻转,
      // 显式传 true 让缓存段落与随后到达的流式译文保持一致,立即可见。
      runtime.renderNovelTranslation?.(item.node, translated, true, item.id);
      hit += 1;
      if (match === "stale-config") stale += 1;
    });
    return { hit, total: items.length, stale };
  }
  runtime.applyCachedNovelTranslations = applyCachedNovelTranslations;

  async function saveNovelCacheRecords(chapter, state, options = {}) {
    if (!chapter || !state) return { ok: true, saved: 0 };
    const translatedItems = chapter.paragraphs.filter(item => {
      const translated = state.translations.get(item.id);
      return translated && String(translated).trim();
    });
    if (!translatedItems.length) return { ok: true, saved: 0 };
    const fingerprint = await runtime.getTranslationConfigFingerprint("novel", typeof location !== "undefined" ? location.href : "");
    const entries = translatedItems.map(item => {
      const normalized = runtime.normalizeTranslationCacheText(item.original_text);
      const sourceHash = runtime.computeTranslationCacheHash(normalized);
      return {
        item, normalized, sourceHash,
        id: runtime.buildNovelCacheRecordId(
          chapter.seriesId, chapter.chapterId, sourceHash, item.paragraphKey,
          runtime.resolveSourceLanguage?.(item.original_text) || "auto"
        )
      };
    });
    const existingRecords = options.force
      ? await runtime.getTranslationCacheRecords(entries.map(entry => entry.id))
      : null;
    const records = [];
    for (const entry of entries) {
      const { item, normalized, sourceHash, id } = entry;
      const translated = String(state.translations.get(item.id)).trim();
      const base = {
        id,
        mode: "novel",
        workId: chapter.seriesId,
        chapterId: chapter.chapterId,
        paragraphIndex: item.index,
        paragraphKey: item.paragraphKey,
        domAnchor: item.domAnchor,
        rawSourceHash: item.rawSourceHash,
        normalizedSourceHash: item.normalizedSourceHash,
        configuredSourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
        resolvedSourceLanguage: runtime.resolveSourceLanguage?.(item.original_text) || "auto",
        targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
        sourceText: item.original_text,
        normalizedSourceText: normalized,
        sourceHash,
        translationConfigFingerprint: fingerprint
      };
      if (options.force) {
        const existing = existingRecords.get(id);
        const next = existing
          ? runtime.retranslateCacheRecord(existing, translated, { fingerprint })
          : runtime.buildTranslationCacheRecord("novel", base, translated, [], { fingerprint });
        if (next) records.push(next);
      } else if (!state.cacheSavedIds.has(item.id)) {
        records.push(runtime.buildTranslationCacheRecord("novel", base, translated, [], { fingerprint }));
      }
    }
    if (!records.length) return { ok: true, saved: 0 };
    const saved = await runtime.saveTranslationCacheRecords(records);
    if (saved && saved.ok) {
      for (const entry of entries) state.cacheSavedIds.add(entry.item.id);
    }
    return saved;
  }
  runtime.saveNovelCacheRecords = saveNovelCacheRecords;

  async function analyzeNovelCacheStatus() {
    const state = runtime.getNovelState();
    const surface = runtime.findKakaoNovelSurface();
    if (!surface) {
      state.cacheStatus = "none";
      return { total: 0, hit: 0 };
    }
    const chapter = runtime.extractKakaoNovelChapter(surface);
    if (!chapter) return { total: 0, hit: 0 };
    // 缓存覆盖必须按「屏」判定:KakaoPage 是分屏阅读,一章被拆成多屏,
    // 首屏命中完整缓存不代表后面几屏也有。此前只用章节 key,首屏判定一次后
    // 就不再重算,翻到没译过的屏仍显示「缓存已有完整译文」。
    const key = `${chapter.scopeKey}:${chapter.chapterId}:${runtime.novelSurfaceSignature?.(surface) || ""}`;
    if (state.cacheCheckedKey === key) return { total: 0, hit: 0, skipped: true };
    const targetLanguage = runtime.getTargetLanguage?.() || "zh-CN";
    const items = chapter.paragraphs.filter(item => {
      const sourceLanguage = runtime.resolveSourceLanguage?.(item.original_text) || "auto";
      return sourceLanguage === "auto" || sourceLanguage !== targetLanguage;
    });
    const ids = items.map(item => buildRecordId(
      chapter.seriesId, chapter.chapterId, item.original_text, item.paragraphKey
    ));
    const records = await runtime.getTranslationCacheRecords(ids);
    const fingerprint = await runtime.getTranslationConfigFingerprint("novel", typeof location !== "undefined" ? location.href : "");
    let hit = 0;
    let stale = 0;
    ids.forEach(id => {
      const match = classify(records.get(id), fingerprint);
      if (isUsableMatch(match)) hit += 1;
      if (match === "stale-config") stale += 1;
    });
    state.cacheCheckedKey = key;
    state.cacheStatus = !items.length ? "none" : hit >= items.length ? "cached" : hit > 0 ? "partial" : "none";
    state.cacheBadgeUntil = state.cacheStatus === "cached" ? Date.now() + 3500 : 0;
    state.cacheStaleCount = stale;
    runtime.updateFloatingBallState?.();
    return { total: items.length, hit, stale };
  }
  runtime.analyzeNovelCacheStatus = analyzeNovelCacheStatus;
}
