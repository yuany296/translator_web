import scanner from "./webpage-scanner.js";
import {
  completePartialWebpageBatch, isUsableWebpageTranslation
} from "./webpage-batches.js";
import {
  createWebpageNodeStateStore, shouldApplyTranslation, shouldRestoreNode, isNodeModifiedByPage
} from "./webpage-node-state.js";
import { applyWebpageTranslation, cleanupWebpageEntry, updateWebpageProgress } from "./webpage-renderer.js";

export function installWebpageTranslate(runtime) {
  function getWebpageState() {
    if (!runtime.state.webpage) {
      runtime.state.webpage = {
        nodeStore: createWebpageNodeStateStore(), savedKeys: new Set(), showTranslation: false,
        working: false, generation: 0, taskId: "", taskUrl: "",
        pageKey: runtime.normalizeTranslationCacheUrl(), cacheStatus: "none",
        cacheCheckedKey: "", cacheAnalysisPending: false, cacheBadgeUntil: 0,
        partialFailure: false, errorMessage: "", progressPanel: null, active: false,
        progressHideTimer: 0, controller: null, session: null, pageFault: null,
        progress: { scanned: 0, cached: 0, completed: 0, queued: 0, pending: 0, failed: 0, status: "idle" }
      };
    }
    return runtime.state.webpage;
  }
  runtime.getWebpageState = getWebpageState;
  runtime.collectWebpageTextNodes = scanner.collectWebpageTextNodes;
  runtime.normalizeWebpageText = scanner.normalizeCandidateText;
  runtime.buildWebpageContainerSignature = scanner.buildWebpageContainerSignature;
  runtime.buildWebpageNeighborContext = scanner.buildWebpageNeighborContext;

  /** Enrich entries with v3 cache identity (bindingKey primary, translationKey
   * cross-page reuse, legacy occurrence-index id for dual-read). */
  function enrichEntries(entries, pageKey, identityState = {}) {
    const containers = identityState.containers || new Map();
    const globalOccurrences = identityState.globalOccurrences || new Map();
    return entries.map(entry => {
      const normalized = runtime.normalizeTranslationCacheText(entry.text);
      const sourceHash = runtime.computeTranslationCacheHash(normalized);
      const containerSignature = runtime.buildWebpageContainerSignature(entry.node);
      let perContainer = containers.get(containerSignature);
      if (!perContainer) {
        perContainer = new Map();
        containers.set(containerSignature, perContainer);
      }
      const localIndex = perContainer.get(sourceHash) || 0;
      perContainer.set(sourceHash, localIndex + 1);
      const occurrenceIndex = globalOccurrences.get(sourceHash) || 0;
      globalOccurrences.set(sourceHash, occurrenceIndex + 1);
      const bindingKey = runtime.buildWebpageBindingKey({ pageKey, sourceHash, containerSignature, localIndex });
      const neighbor = runtime.buildWebpageNeighborContext(entry.node);
      const contextFingerprint = runtime.buildWebpageContextFingerprint?.({
        ...neighbor, semanticRegion: containerSignature
      }) || "";
      const resolvedSourceLanguage = runtime.resolveSourceLanguage?.(entry.text) || "auto";
      const targetLanguage = runtime.getTargetLanguage?.() || "zh-CN";
      const translationKey = runtime.buildWebpageTranslationKey({
        normalized, sourceLanguage: resolvedSourceLanguage, targetLanguage, contextFingerprint
      });
      const id = runtime.buildWebpageRecordIdFromBinding({
        bindingKey, sourceHash, sourceLanguage: resolvedSourceLanguage, targetLanguage
      });
      const legacySegmentKey = runtime.computeTranslationCacheHash(
        `${pageKey}\u0000${sourceHash}\u0000${occurrenceIndex}`
      );
      return {
        ...entry, normalized, sourceHash, occurrenceIndex, localIndex,
        containerSignature, contextFingerprint, bindingKey, translationKey,
        segmentKey: bindingKey, legacySegmentKey, resolvedSourceLanguage,
        targetLanguage, pageKey, id, legacyId: runtime.buildWebpageCacheRecordId(
          pageKey, legacySegmentKey, sourceHash, resolvedSourceLanguage
        )
      };
    });
  }
  runtime.enrichWebpageEntries = enrichEntries;

  function isGenerationStale(state, generation) {
    return generation !== state.generation || state.taskUrl !== location.href;
  }

  function cancelCurrentTask(state) {
    if (state.taskId) {
      void runtime.sendRuntimeMessage({ type: "CANCEL_TRANSLATION_TASK", taskId: state.taskId }).catch(() => {});
      state.taskId = "";
    }
    state.generation += 1;
    runtime.stopWebpageScheduler?.();
  }  runtime.cancelWebpageTranslationTask = cancelCurrentTask;

  // ---------- cache / record I/O ----------

  /** Lazy write a legacy hit under the new bindingKey id, keeping all versions. */
  async function migrateWebpageRecordToEntry(record, entry) {
    if (!record || !entry || record.id === entry.id) return null;
    const migrated = {
      ...record,
      id: entry.id, recordId: entry.id, recordKey: entry.id,
      pageKey: entry.pageKey || record.pageKey,
      segmentKey: entry.segmentKey || entry.id,
      bindingKey: entry.bindingKey, translationKey: entry.translationKey,
      containerSignature: entry.containerSignature,
      contextFingerprint: entry.contextFingerprint || record.contextFingerprint,
      textIndex: entry.index, domAnchor: `${entry.node.parentElement?.tagName || ""}`
    };    return runtime.saveTranslationCacheRecords([migrated]);
  }
  runtime.migrateWebpageRecordToEntry = migrateWebpageRecordToEntry;

  async function sendWebpageTranslationBatch(keys, options = {}) {
    const result = new Map();
    const items = keys.map((value, index) => ({ id: `webpage-${index}`, original_text: value }));
    try {
      const response = await runtime.sendRuntimeMessage({
        type: "TRANSLATE_TEXT_BLOCKS", mode: "webpage", items,
        sourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
        targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
        force: options.force === true, taskId: options.taskId || ""
      });
      if (response?.cancelled === true) return { ok: false, cancelled: true, translations: result, errors: [] };
      const byId = new Map((response?.translations || []).map(row => [String(row.id), row.translated_text]));
      keys.forEach((value, index) => {
        const translated = byId.get(`webpage-${index}`);
        if (isUsableWebpageTranslation(translated)) result.set(value, String(translated));
      });
      return {
        ok: response?.ok !== false,
        partial: response?.partial === true || result.size < keys.length,
        translations: result,
        errors: response?.errors?.length ? response.errors : (response?.error ? [{ error: String(response.error) }] : [])
      };
    } catch (error) {
      return { ok: false, translations: result, errors: [{ error: runtime.getErrorMessage(error) }] };
    }
  }

  /** ������Ӧֻ��ȱʧ������һ�Σ��ٴ�ȱʧ�ż�Ϊ��ʵ����ʧ�ܡ� */
  async function translateWebpageBatchWithRetry(keys, options) {
    const first = await sendWebpageTranslationBatch(keys, options);
    return completePartialWebpageBatch(keys, first, missing => sendWebpageTranslationBatch(missing, options));
  }
  runtime.translateWebpageBatchWithRetry = translateWebpageBatchWithRetry;

  async function saveWebpageSegmentRecords(session, segments, translations, options = {}) {
    const state = getWebpageState();
    const fingerprint = options.fingerprint || await runtime.getTranslationConfigFingerprint("webpage", typeof location !== "undefined" ? location.href : "");
    const candidates = segments.filter(segment => translations.has(segment.sourceText)
      && !state.savedKeys.has(segment.segmentKey));
    if (!candidates.length) return { ok: true, saved: 0 };
    const records = candidates.map(segment => {
      const base = {
        id: segment.segmentKey, mode: "webpage", pageKey: session.pageKey, normalizedUrl: session.pageKey,
        segmentKey: segment.segmentKey, bindingKey: segment.bindingKey,
        translationKey: segment.translationKey, containerSignature: segment.containerSignature,
        contextFingerprint: segment.contextFingerprint,
        domAnchor: `${segment.node.parentElement?.tagName || ""}`,
        sourceText: segment.sourceText, normalizedSourceText: segment.normalized,
        sourceHash: segment.sourceHash, rawSourceHash: runtime.computeTranslationCacheHash(segment.sourceText),
        normalizedSourceHash: segment.sourceHash,
        configuredSourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
        resolvedSourceLanguage: segment.resolvedSourceLanguage,
        targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
        translationConfigFingerprint: fingerprint
      };
      const translated = String(translations.get(segment.sourceText));
      return runtime.buildTranslationCacheRecord("webpage", base, translated, [], { fingerprint });
    }).filter(Boolean);
    const saved = await runtime.saveTranslationCacheRecords(records);
    if (saved?.ok) {
      candidates.forEach(segment => {
        state.savedKeys.add(segment.segmentKey);
        segment.status.persistence = "pending-save";
      });
      // SQLite ��ʽ���ύ���첽��β��ʧ��ֻ��Ǵ����棬����������ʾ������
      void Promise.all(candidates.map(segment => {
        // ���ȶ����ݵĶβ��ύ��ʽ�⣬����� recordKey ����������þܾ�
        if (!segment.segmentKey) return Promise.resolve({ ok: false, pending: false, skipped: true });
        const translated = String(translations.get(segment.sourceText));
        const operation = runtime.createTranslationOperation("commit_translation", segment.segmentKey, {
          mode: "webpage", scopeKey: session.pageKey, segmentKey: segment.segmentKey,
          bindingKey: segment.bindingKey, translationKey: segment.translationKey,
          pageKey: session.pageKey, rawSourceText: segment.sourceText,
          normalizedSourceText: segment.normalized,
          rawSourceHash: runtime.computeTranslationCacheHash(segment.sourceText),
          normalizedSourceHash: segment.sourceHash,
          configuredSourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
          resolvedSourceLanguage: segment.resolvedSourceLanguage,
          targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
          translatedText: translated, source: "api", configFingerprint: fingerprint
        });
        return runtime.commitTranslationOperation(operation);
      })).then(commits => commits.forEach((commit, index) => {
        const segment = candidates[index];
        if (segment) segment.status.persistence = commit?.ok === true
          ? "saved" : commit?.pending === true ? "pending-save" : "failed";
      })).finally(() => runtime.refreshWebpageUi?.());
    }
    return saved;
  }
  runtime.saveWebpageSegmentRecords = saveWebpageSegmentRecords;

  function canApply(entry, generation) {
    const state = getWebpageState();
    return shouldApplyTranslation({
      isConnected: entry.node.isConnected, currentValue: entry.node.nodeValue,
      sourceText: entry.text, generation, currentGeneration: state.generation,
      pageKey: entry.pageKey || state.pageKey, currentPageKey: state.pageKey,
      wantsTranslation: state.showTranslation === true
    });
  }

  /**
   * Apply batch results to a session. Translation state advances even when
   * the display is showing source (background keeps translating); rendering
   * only happens when visibility is "translated" and the node still matches.
   */
  function applyWebpageEntriesToSession(session, generation, entries, translations) {
    const state = getWebpageState();
    let applied = 0;
    for (const entry of entries) {
      const translated = translations.get(entry.text);
      if (!translated) continue;
      const segment = session && session.segments.get(entry.id);
      if (segment) {
        segment.translatedText = String(translated);
        segment.status.translation = "done";
        segment.unchanged = String(translated).trim() === String(entry.text || "").trim();
      }
      if (session) {
        session.bindings.set(entry.node, {
          originalText: entry.text, translatedText: String(translated),
          sourceHash: entry.sourceHash, generation: session.generation,
          pageKey: session.pageKey, segmentKey: entry.id
        });
      }
      if (!canApply(entry, generation)) {
        if (segment) segment.status.rendering = "skipped";
        continue;
      }
      if (applyWebpageTranslation(runtime, state, entry, translated, {
        sourceHash: entry.sourceHash, generation, pageKey: session?.pageKey || state.pageKey
      })) {
        applied += 1;
        if (segment) segment.status.rendering = "rendered";
      } else if (segment) {
        segment.status.rendering = "skipped";
      }
    }
    if (applied) {
      state.showTranslation = true;
      runtime.updateFloatingBallState?.();
    }
    return applied;
  }
  runtime.applyWebpageEntriesToSession = applyWebpageEntriesToSession;

  // ---------- controller entry ----------

  async function translateWebpage(options = {}) {
    const state = getWebpageState();
    // taskUrl 提前更新：消息失败被吞时 settle 的 stale 判定仍以当前 URL 为准
    state.taskUrl = location.href;
    // 1. 控制器入口：开启持续翻译并显示译文
    if (state.controller?.mode !== "continuous") {
      const updated = await runtime.setWebpageTabMode("continuous");
      if (updated) state.controller = updated;
    }
    if (state.controller?.visibility !== "translated") {
      const updated = await runtime.setWebpageTabVisibility("translated");
      if (updated) state.controller = updated;
    }
    state.showTranslation = true;
    state.active = true;
    const pageKey = runtime.normalizeTranslationCacheUrl();
    state.pageKey = pageKey;
    // 2. 同一会话翻译中不重复建任务；切换取消后 scheduler 可能仍 stopped，复用任务时恢复调度
    if (state.working && state.session?.pageKey === pageKey
      && state.session?.generation === state.generation) {
      runtime.startWebpageScheduler?.();
      return { ok: false, reused: true, error: "网页翻译进行中" };
    }
    // 新任务取代旧任务：取消未发送任务并递增 generation
    cancelCurrentTask(state);
    const generation = state.generation;
    const session = runtime.getOrCreateWebpageSession(pageKey, generation);
    session.active = true;
    state.session = session;
    state.taskId = `web-${Date.now()}-${generation}`;
    void runtime.reportWebpagePageKey(pageKey).then(updated => {
      if (updated) {
        state.controller = updated;
        runtime.updateFloatingBallState?.();
      }
    }).catch(() => {});
    // 3. 可视区优先调度；后续动态新增内容由观察器交给调度器
    runtime.activateWebpageObserver?.();
    return runtime.startWebpageViewportTranslation({ session, generation, force: options.force === true });
  }
  runtime.translateWebpage = translateWebpage;

  function showWebpageTranslations() {
    const state = getWebpageState();
    // 先声明显示意图:canApply 的 wantsTranslation 守卫依赖它,否则从原文切回译文会被全部跳过。
    state.showTranslation = true;
    let shown = 0;
    const entries = [];
    state.nodeStore.forEach((node, item) => entries.push({ node, item }));
    for (const { node, item } of entries) {
      if (!item || node.nodeValue !== item.originalText) continue;
      const entry = { node, text: item.originalText };
      if (!canApply(entry, item.generation)) continue;
      if (applyWebpageTranslation(runtime, state, entry, item.translatedText, item)) shown += 1;
    }
    const session = state.session;
    if (session) {
      for (const [node, binding] of session.bindings.entries()) {
        if (!node.isConnected || node.nodeValue !== binding.originalText) continue;
        const entry = { node, text: binding.originalText, sourceHash: binding.sourceHash, pageKey: binding.pageKey };
        if (!canApply(entry, binding.generation)) continue;
        if (applyWebpageTranslation(runtime, state, entry, binding.translatedText, binding)) {
          shown += 1;
          const segment = session.segments.get(binding.segmentKey);
          if (segment) segment.status.rendering = "rendered";
        }      }
    }    state.showTranslation = shown > 0;
    if (shown) {
      void runtime.setWebpageTabVisibility("translated").then(updated => {
        if (updated) {
          state.controller = updated;
          runtime.updateFloatingBallState?.();
        }
      }).catch(() => {});
    }
    runtime.updateFloatingBallState?.();
    return { ok: true, shown };
  }
  runtime.showWebpageTranslations = showWebpageTranslations;

  /** 显示原文只切换显示，不停止后台翻译，也不删除缓存。 */
  function restoreWebpageTranslation() {
    const state = getWebpageState();
    state.showTranslation = false;
    state.nodeStore.prune();
    let restored = 0;
    const entries = [];
    state.nodeStore.forEach((node, entry) => entries.push({ node, entry }));
    for (const { node, entry } of entries) {
      if (isNodeModifiedByPage(entry, node.nodeValue)) {
        cleanupWebpageEntry(node, entry, () => false);
        state.nodeStore.release(node);
        continue;
      }
      if (cleanupWebpageEntry(node, entry, (candidate, value) => shouldRestoreNode({
        isConnected: candidate.isConnected, currentValue: candidate.nodeValue,
        translatedText: value.translatedText
      }))) restored += 1;
    }
    const session = state.session;
    if (session) {
      for (const segment of session.segments.values()) {
        if (segment.status.rendering === "rendered") segment.status.rendering = "restored";
      }
    }
    void runtime.setWebpageTabVisibility("source").then(updated => {
      if (updated) {
        state.controller = updated;
        runtime.updateFloatingBallState?.();
      }
    }).catch(() => {});
    runtime.updateFloatingBallState?.();
    return { ok: true, restored };
  }
  runtime.restoreWebpageTranslation = restoreWebpageTranslation;

  /** 菜单独立动作：停止持续翻译（后台仍保留已显示译文，页面回到原文状态）。 */
  async function stopWebpageContinuousTranslation() {
    const state = getWebpageState();
    cancelCurrentTask(state);
    state.active = false;
    state.showTranslation = false;
    runtime.deactivateWebpageObserver?.();
    const updated = await runtime.setWebpageTabMode("off");
    if (updated) state.controller = updated;
    runtime.clearAllWebpageNodeLoading?.();
    runtime.updateFloatingBallState?.();
    return { ok: true };
  }
  runtime.stopWebpageContinuousTranslation = stopWebpageContinuousTranslation;

  function refreshWebpageDisplayMode() {
    const state = getWebpageState();
    if (!state.showTranslation) return;
    state.nodeStore.forEach((node, entry) => cleanupWebpageEntry(node, entry,
      () => node.nodeValue === entry.translatedText));
    state.nodeStore.forEach((node, entry) => {
      if (node.nodeValue !== entry.originalText) return;
      applyWebpageTranslation(runtime, state, { node, text: entry.originalText }, entry.translatedText, entry);
    });
  }
  runtime.refreshWebpageDisplayMode = refreshWebpageDisplayMode;
}
