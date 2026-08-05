import cacheCore from "../../shared/translation-cache.js";

export function installTranslationCacheClient(runtime) {
  const memoryCache = new Map();
  const MAX_MEMORY_CACHE = 120;

  function normalizeUrl(url) {
    return cacheCore.normalizePageKey(url || location.href);
  }
  runtime.normalizeTranslationCacheUrl = normalizeUrl;
  runtime.normalizeWebpagePageKey = url => cacheCore.normalizePageKey(url || location.href);
  runtime.buildWebpageBindingKey = cacheCore.buildBindingKey;
  runtime.buildWebpageTranslationKey = cacheCore.buildTranslationKey;
  runtime.buildWebpageRecordIdFromBinding = cacheCore.buildWebpageRecordIdFromBinding;
  runtime.buildWebpageContextFingerprint = cacheCore.buildContextFingerprint;

  function buildNovelRecordId(workId, chapterId, sourceHash, paragraphKey = "", sourceLanguage = "") {
    return cacheCore.buildNovelRecordId(
      workId, chapterId, sourceHash, paragraphKey,
      sourceLanguage || runtime.getConfiguredSourceLanguage?.() || "auto",
      runtime.getTargetLanguage?.() || "zh-CN"
    );
  }
  runtime.buildNovelCacheRecordId = buildNovelRecordId;
  runtime.normalizeTranslationCacheText = cacheCore.normalizeSourceText;
  runtime.computeTranslationCacheHash = cacheCore.computeSourceHash;

  function buildWebpageRecordId(pageKey, segmentKey, sourceHash, sourceLanguage = "") {
    return cacheCore.buildWebpageRecordId(
      pageKey || normalizeUrl(), segmentKey, sourceHash,
      sourceLanguage || runtime.getConfiguredSourceLanguage?.() || "auto",
      runtime.getTargetLanguage?.() || "zh-CN"
    );
  }
  runtime.buildWebpageCacheRecordId = buildWebpageRecordId;

  async function getRecord(id) {
    if (!id) return null;
    if (memoryCache.has(id)) return memoryCache.get(id);
    try {
      const response = await runtime.sendRuntimeMessage({ type: "GET_TRANSLATION_CACHE", id });
      const record = response?.record || null;
      if (record) touchMemoryCache(id, record);
      return record;
    } catch {
      return null;
    }
  }
  runtime.getTranslationCacheRecord = getRecord;

  async function getRecords(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!list.length) return new Map();
    const result = new Map();
    const missing = [];
    for (const id of list) {
      if (memoryCache.has(id)) {
        result.set(id, memoryCache.get(id));
      } else {
        missing.push(id);
      }
    }
    if (missing.length) {
      try {
        const response = await runtime.sendRuntimeMessage({ type: "GET_TRANSLATION_CACHE_BATCH", ids: missing });
        const records = response?.records || {};
        for (const id of missing) {
          const record = records[id] || null;
          if (record) {
            touchMemoryCache(id, record);
            result.set(id, record);
          }
        }
      } catch {
        // continue without cache
      }
    }
    return result;
  }
  runtime.getTranslationCacheRecords = getRecords;

  async function saveRecord(record) {
    const normalized = cacheCore.normalizeRecord(record);
    if (!normalized) return { ok: false, error: "invalid record" };
    touchMemoryCache(normalized.id, normalized);
    try {
      return await runtime.sendRuntimeMessage({ type: "SAVE_TRANSLATION_CACHE", record: normalized });
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.saveTranslationCacheRecord = saveRecord;

  async function saveRecords(records) {
    const list = (Array.isArray(records) ? records : []).map(cacheCore.normalizeRecord).filter(Boolean);
    for (const record of list) touchMemoryCache(record.id, record);
    if (!list.length) return { ok: true, saved: 0 };
    try {
      return await runtime.sendRuntimeMessage({ type: "SAVE_TRANSLATION_CACHE_BATCH", records: list });
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error), saved: 0 };
    }
  }
  runtime.saveTranslationCacheRecords = saveRecords;

  function touchMemoryCache(id, record) {
    if (!id) return;
    if (memoryCache.size >= MAX_MEMORY_CACHE) {
      const first = memoryCache.keys().next().value;
      if (first) memoryCache.delete(first);
    }
    memoryCache.set(id, record);
  }
  runtime.touchTranslationCacheMemory = touchMemoryCache;

  async function getTranslationConfigFingerprint(mode = "novel") {
    try {
      const response = await runtime.sendRuntimeMessage({ type: "GET_TRANSLATION_CONFIG_FINGERPRINT", mode });
      return String(response?.fingerprint || "");
    } catch {
      return "";
    }
  }
  runtime.getTranslationConfigFingerprint = getTranslationConfigFingerprint;

  /**
   * Dual-read webpage cache lookup, in fallback order:
   *   1. exact bindingKey id;
   *   2. legacy occurrence-index id (v1/v2 records);
   *   3. hash index query filtered by the same pageKey + source text
   *      (旧记录不删除，双读命中后惰性写入新键);
   *   4. translationKey index query for cross-page reuse.
   */
  async function getWebpageEntryRecords(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return new Map();
    const byId = new Map();
    const records = await runtime.getTranslationCacheRecords(list.map(entry => entry.id));
    const missingEntries = [];
    for (const entry of list) {
      const record = records.get(entry.id);
      if (record) byId.set(entry, record);
      else missingEntries.push(entry);
    }
    if (missingEntries.length) {
      const legacyIds = missingEntries.map(entry => entry.legacyId).filter(Boolean);
      if (legacyIds.length) {
        const legacyRecords = await runtime.getTranslationCacheRecords(legacyIds);
        for (const entry of missingEntries) {
          const record = legacyRecords.get(entry.legacyId);
          if (record) byId.set(entry, record);
        }
      }
    }
    const stillMissing = missingEntries.filter(entry => !byId.has(entry));
    if (stillMissing.length) {
      let fallback = { bySourceHash: {}, byTranslationKey: {} };
      try {
        fallback = await runtime.sendRuntimeMessage({
          type: "GET_WEBPAGE_TRANSLATION_CACHE_FALLBACKS",
          sourceHashes: [...new Set(stillMissing.map(entry => entry.sourceHash))],
          translationKeys: [...new Set(stillMissing.map(entry => entry.translationKey).filter(Boolean))]
        });
      } catch {
        // 缓存回退失败不阻塞实时翻译
      }
      for (const entry of stillMissing) {
        // 同原文哈希：同页优先，跨页同文本兜底（短词/专名避免重复翻译重复存储）
        const bySource = (fallback.bySourceHash?.[entry.sourceHash] || []).filter(record =>
          record.sourceText === entry.text || record.normalizedSourceText === entry.normalized);
        if (bySource.length) {
          const samePage = bySource.find(record => record.pageKey === entry.pageKey);
          byId.set(entry, samePage || bySource[0]);
          continue;
        }
        // translationKey 跨页面复用回退（短文本上下文指纹降低误复用）
        const cross = (fallback.byTranslationKey?.[entry.translationKey] || []).filter(record =>
          record.sourceText === entry.text || record.normalizedSourceText === entry.normalized);
        if (cross.length) byId.set(entry, cross[0]);
      }
    }
    return byId;
  }
  runtime.getWebpageEntryRecords = getWebpageEntryRecords;
  runtime.classifyTranslationCacheMatch = cacheCore.classifyCacheMatch;

  function makeVersion(text, source = "api", options = {}) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      translatedText: String(text || ""),
      source: cacheCore.SOURCES.includes(source) ? source : "api",
      createdAt: Date.now(),
      pinned: options.pinned === true,
      manual: options.manual === true,
      // API 版本必须保存生成时的配置指纹；手动版可以没有
      translationConfigFingerprint: source === "manual" ? "" : String(options.fingerprint || "")
    };
  }
  runtime.makeTranslationCacheVersion = makeVersion;

  function trimVersions(versions, max = 5) {
    const list = Array.isArray(versions) ? versions.slice() : [];
    if (list.length <= max) return list;
    const protectedOnes = list.filter(v => v.manual || v.pinned);
    const droppable = list.filter(v => !v.manual && !v.pinned);
    const keptProtected = protectedOnes.slice(0, max);
    const budget = Math.max(0, max - keptProtected.length);
    return [...droppable.slice(0, budget), ...keptProtected].sort((a, b) => b.createdAt - a.createdAt);
  }
  runtime.trimTranslationCacheVersions = trimVersions;

  function buildRecord(mode, base, translatedText, previousVersions = [], options = {}) {
    const version = makeVersion(translatedText, options.source || "api", options);
    const versions = trimVersions([version, ...(Array.isArray(previousVersions) ? previousVersions : [])], 5);
    return cacheCore.buildRecordFromVersions(mode, base, versions);
  }
  runtime.buildTranslationCacheRecord = buildRecord;

  function retranslateVersion(record, translatedText, options = {}) {
    if (!record || !Array.isArray(record.versions)) return null;
    const next = makeVersion(translatedText, options.source || "api", options);
    return cacheCore.buildRecordFromVersions(record.mode, {
      ...record,
      createdAt: record.createdAt || Date.now()
    }, trimVersions([next, ...record.versions], 5));
  }
  runtime.retranslateCacheRecord = retranslateVersion;

  async function syncTranslationService(recordKeys = []) {
    try {
      return await runtime.sendRuntimeMessage({ type: "SYNC_TRANSLATION_SERVICE", recordKeys });
    } catch (error) {
      return { ok: false, status: "offline", error: runtime.getErrorMessage(error) };
    }
  }
  runtime.syncTranslationService = syncTranslationService;

  async function ensureTranslationServiceOnline(recordKeys = []) {
    // 消息可能永久无响应（background 繁忙或消息丢失）：限时返回，避免
    // startup 卡在服务检查、working 标志永不重置
    const result = await Promise.race([
      syncTranslationService(recordKeys),
      new Promise(resolve => setTimeout(
        () => resolve({ ok: false, status: "offline", error: "本地服务检查超时" }), 10_000
      ))
    ]);
    return result?.ok === true && result?.status === "online" ? result : {
      ...result, ok: false, status: "offline",
      error: result?.error || "本地服务未启动，当前仅显示已缓存译文"
    };
  }
  runtime.ensureTranslationServiceOnline = ensureTranslationServiceOnline;

  function createTranslationOperation(type, recordKey, payload, options = {}) {
    return {
      operationId: crypto.randomUUID(), type, recordId: options.recordId || undefined,
      recordKey: String(recordKey || ""),
      expectedRecordRevision: options.expectedRecordRevision,
      baseActiveVersionId: options.baseActiveVersionId,
      payload: payload || {}, createdAt: Date.now()
    };
  }
  runtime.createTranslationOperation = createTranslationOperation;

  async function commitTranslationOperation(operation) {
    try {
      return await runtime.sendRuntimeMessage({ type: "COMMIT_TRANSLATION_OPERATION", operation });
    } catch (error) {
      return { ok: false, pending: true, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.commitTranslationOperation = commitTranslationOperation;

  async function getTranslationVersions(recordId) {
    try {
      return await runtime.sendRuntimeMessage({ type: "GET_TRANSLATION_VERSIONS", recordId });
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.getTranslationVersions = getTranslationVersions;
}
