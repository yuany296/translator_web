export function installNovelRevisionPanel(runtime) {
  function recordKey(chapter, item) {
    const normalized = runtime.normalizeTranslationCacheText(item.original_text);
    return runtime.buildNovelCacheRecordId(chapter.seriesId, chapter.chapterId,
      runtime.computeTranslationCacheHash(normalized), item.paragraphKey,
      runtime.resolveSourceLanguage?.(item.original_text) || "auto");
  }

  function recordPayload(chapter, item, translatedText, source, options = {}) {
    return {
      mode: "novel", scopeKey: chapter.scopeKey, segmentKey: item.paragraphKey,
      workId: chapter.seriesId, chapterId: chapter.chapterId,
      rawSourceText: item.original_text,
      normalizedSourceText: runtime.normalizeTranslationCacheText(item.original_text),
      rawSourceHash: item.rawSourceHash, normalizedSourceHash: item.normalizedSourceHash,
      configuredSourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
      resolvedSourceLanguage: runtime.resolveSourceLanguage?.(item.original_text) || "auto",
      targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
      translatedText, source, configFingerprint: options.fingerprint || "",
      revisionInstruction: options.instruction || "", pinned: options.pinned === true
    };
  }

  function findParagraph(chapter, itemId) {
    return chapter.paragraphs.find(item => item.id === itemId) || null;
  }

  async function submitEdit(chapter, item, translatedText, options = {}) {
    const state = runtime.getNovelState();
    const key = recordKey(chapter, item);
    const snapshot = state.translationSnapshots?.get(key);
    const operation = runtime.createTranslationOperation(options.type || "edit", key,
      recordPayload(chapter, item, translatedText, options.source || "manual", options), {
        recordId: snapshot?.recordId,
        expectedRecordRevision: snapshot?.recordRevision,
        baseActiveVersionId: snapshot?.activeVersionId
      });
    const result = await runtime.commitTranslationOperation(operation);
    if (result.conflict) {
      const official = String(result.record?.activeVersion?.translatedText || "");
      if (result.record) state.translationSnapshots.set(key, result.record);
      if (official) {
        state.translations.set(item.id, official);
        runtime.renderNovelTranslation(item.node, official, true);
      }
      throw new Error(`译文已在其他标签页更新：${result.error || "请确认最新版本后重试"}`);
    }
    state.translations.set(item.id, translatedText);
    runtime.renderNovelTranslation(item.node, translatedText, true);
    item.node.dataset.mtNovelStatus = result.pending ? "pending" : options.source || "manual";
    if (result.pending) state.pendingParagraphs.add(item.id);
    else {
      state.pendingParagraphs.delete(item.id);
      if (result.record) state.translationSnapshots.set(key, result.record);
    }
    return result;
  }

  async function requestAiRevision(chapter, item, instruction = "") {
    const status = await runtime.ensureTranslationServiceOnline([recordKey(chapter, item)]);
    if (!status.ok) throw new Error(status.error || "本地服务未启动");
    const state = runtime.getNovelState();
    const index = chapter.paragraphs.indexOf(item);
    const response = await runtime.sendRuntimeMessage({
      type: "TRANSLATE_NOVEL_CHUNK", taskId: `revision-${crypto.randomUUID()}`,
      scopeKey: chapter.scopeKey, seriesId: chapter.seriesId,
      chapterId: chapter.chapterId, chapterTitle: chapter.chapterTitle,
      chapterOrder: chapter.chapterOrder,
      sourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
      targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
      previousTranslation: chapter.paragraphs.slice(Math.max(0, index - 3), index).map(candidate => state.translations.get(candidate.id) || "").filter(Boolean).join("\n"),
      beforeText: chapter.paragraphs.slice(Math.max(0, index - 3), index).map(candidate => candidate.original_text).join("\n"),
      afterText: chapter.paragraphs.slice(index + 1, index + 4).map(candidate => candidate.original_text).join("\n"),
      revisionInstruction: instruction,
      force: true,
      items: [{ id: item.id, index: item.index, kind: item.kind, original_text: item.original_text }]
    });
    const translated = String(response?.translations?.[0]?.translated_text || "").trim();
    if (!response?.ok || !translated) throw new Error(response?.error || "AI 修订未返回译文");
    const fingerprint = await runtime.getTranslationConfigFingerprint("novel");
    return submitEdit(chapter, item, translated, {
      type: "commit_translation", source: instruction ? "ai_revision" : "retranslate",
      instruction, fingerprint
    });
  }

  async function selectVersion(chapter, item, versionId, pinned = false) {
    const state = runtime.getNovelState();
    const key = recordKey(chapter, item);
    const snapshot = state.translationSnapshots.get(key);
    const operation = runtime.createTranslationOperation("select_version", key, {
      versionId, pinned
    }, {
      recordId: snapshot?.recordId,
      expectedRecordRevision: snapshot?.recordRevision,
      baseActiveVersionId: snapshot?.activeVersionId
    });
    const result = await runtime.commitTranslationOperation(operation);
    if (result.conflict) {
      if (result.record) state.translationSnapshots.set(key, result.record);
      throw new Error(`活动版本已变化：${result.error || "请确认最新版本后重试"}`);
    }
    if (result.record) {
      state.translationSnapshots.set(key, result.record);
      const translated = String(result.record.activeVersion?.translatedText || "");
      if (translated) { state.translations.set(item.id, translated); runtime.renderNovelTranslation(item.node, translated, true); }
    } else if (result.pending) {
      const preview = snapshot?.recentVersions?.find(version => version.versionId === versionId);
      if (preview?.translatedText) {
        state.translations.set(item.id, preview.translatedText);
        runtime.renderNovelTranslation(item.node, preview.translatedText, true);
        state.pendingParagraphs.add(item.id);
      }
    }
    return result;
  }

  async function deleteTranslation(chapter, item) {
    const state = runtime.getNovelState();
    const key = recordKey(chapter, item);
    const snapshot = state.translationSnapshots.get(key);
    if (!snapshot) throw new Error("找不到正式译文记录");
    const operation = runtime.createTranslationOperation("delete", key, {}, {
      recordId: snapshot.recordId,
      expectedRecordRevision: snapshot.recordRevision,
      baseActiveVersionId: snapshot.activeVersionId
    });
    const result = await runtime.commitTranslationOperation(operation);
    if (result.conflict) {
      if (result.record) state.translationSnapshots.set(key, result.record);
      throw new Error(`译文已在其他标签页更新：${result.error || "请重新确认删除"}`);
    }
    state.translations.delete(item.id);
    const source = item.node.querySelector?.(":scope > .mt-novel-source");
    const translation = item.node.querySelector?.(":scope > .mt-novel-translation");
    if (source && translation) { source.hidden = false; translation.hidden = true; }
    return result;
  }

  function snapshotItems(chapter) {
    const state = runtime.getNovelState();
    return chapter.paragraphs
      .filter(item => state.translations.has(item.id))
      .map(item => {
        const key = recordKey(chapter, item);
        const snapshot = state.translationSnapshots?.get(key);
        return {
          id: item.id, paragraphKey: item.paragraphKey, index: item.index,
          kind: item.kind, originalText: item.original_text,
          translatedText: state.translations.get(item.id) || snapshot?.activeVersion?.translatedText || "",
          recordKey: key, snapshot
        };
      });
  }

  async function buildChapterSnapshot() {
    const chapter = runtime.extractKakaoNovelChapter(runtime.reconcileKakaoNovelReader());
    if (!chapter) return { ok: false, error: "当前页面未识别为可管理的小说章节" };
    const state = runtime.getNovelState();
    const keys = chapter.paragraphs.map(item => recordKey(chapter, item));
    const service = await runtime.syncTranslationService(keys);
    if (service.records) {
      state.translationSnapshots = new Map(service.records.map(record => [record.recordKey, record]));
    }
    const fingerprint = await runtime.getTranslationConfigFingerprint("novel");
    return {
      ok: true, fingerprint,
      service: { ok: service.ok, pendingConflicts: service.pendingConflicts?.length || 0 },
      chapter: {
        seriesId: chapter.seriesId, chapterId: chapter.chapterId,
        scopeKey: chapter.scopeKey, chapterTitle: chapter.chapterTitle,
        seriesTitle: chapter.seriesTitle, chapterOrder: chapter.chapterOrder
      },
      items: snapshotItems(chapter)
    };
  }

  function performAction(action, payload) {
    const chapter = runtime.extractKakaoNovelChapter(runtime.reconcileKakaoNovelReader());
    if (!chapter) throw new Error("当前页面未识别为可管理的小说章节");
    const item = findParagraph(chapter, payload?.itemId);
    if (!item) throw new Error("找不到指定段落");
    switch (action) {
      case "edit":
        return submitEdit(chapter, item, payload.translatedText, { source: "manual" });
      case "retranslate":
        return requestAiRevision(chapter, item);
      case "aiRevise":
        return requestAiRevision(chapter, item, payload.instruction || "");
      case "selectVersion":
        return selectVersion(chapter, item, payload.versionId, payload.pinned === true);
      case "delete":
        return deleteTranslation(chapter, item);
      default:
        throw new Error(`未知操作：${action}`);
    }
  }

  runtime.getNovelRevisionSnapshot = buildChapterSnapshot;
  runtime.performNovelRevisionAction = performAction;
}