export function installNovelRevisionPanel(runtime) {
  function recordKey(chapter, item) {
    const normalized = runtime.normalizeTranslationCacheText(item.original_text);
    return runtime.buildNovelCacheRecordId(
      chapter.seriesId, chapter.chapterId,
      runtime.computeTranslationCacheHash(normalized), item.paragraphKey,
      runtime.resolveSourceLanguage?.(item.original_text) || "auto"
    );
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

  function ensurePanel() {
    const state = runtime.getNovelState();
    if (state.revisionPanel?.isConnected) return state.revisionPanel;
    const panel = document.createElement("aside");
    panel.className = "mt-novel-revision-panel";
    panel.dataset.mangaTranslatorOverlay = "true";
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "管理当前章节译文";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.addEventListener("click", () => { panel.hidden = true; });
    header.append(title, close);
    const status = document.createElement("div");
    status.className = "mt-novel-revision-status";
    const body = document.createElement("div");
    body.className = "mt-novel-revision-body";
    panel.append(header, status, body);
    document.documentElement.appendChild(panel);
    state.revisionPanel = panel;
    state.revisionPanelBody = body;
    state.revisionPanelStatus = status;
    return panel;
  }

  function versionStatus(state, snapshot, item, fingerprint) {
    if (state.pendingParagraphs.has(item.id)) return "pending";
    const active = snapshot?.activeVersion;
    if (active?.source === "manual") return "manual";
    if (active?.pinned) return "pinned";
    if (active?.configFingerprint && active.configFingerprint !== fingerprint) return "stale";
    return "current";
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
      previousTranslation: chapter.paragraphs.slice(Math.max(0, index - 3), index)
        .map(candidate => state.translations.get(candidate.id) || "").filter(Boolean).join("\n"),
      beforeText: chapter.paragraphs.slice(Math.max(0, index - 3), index)
        .map(candidate => candidate.original_text).join("\n"),
      afterText: chapter.paragraphs.slice(index + 1, index + 4)
        .map(candidate => candidate.original_text).join("\n"),
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
      if (translated) {
        state.translations.set(item.id, translated);
        runtime.renderNovelTranslation(item.node, translated, true);
      }
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
    if (!window.confirm("确定删除这一段的正式译文吗？服务端会保留可审计的软删除记录。")) return null;
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
    if (source && translation) {
      source.hidden = false;
      translation.hidden = true;
    }
    return result;
  }

  function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => void action(button));
    return button;
  }

  async function renderCard(chapter, item, fingerprint) {
    const state = runtime.getNovelState();
    const key = recordKey(chapter, item);
    const snapshot = state.translationSnapshots.get(key);
    const card = document.createElement("section");
    card.className = "mt-novel-revision-card";
    const badge = document.createElement("span");
    badge.className = "mt-novel-version-status";
    badge.dataset.status = versionStatus(state, snapshot, item, fingerprint);
    badge.textContent = badge.dataset.status;
    const source = document.createElement("div");
    source.className = "mt-novel-revision-source";
    source.textContent = item.original_text;
    const editor = document.createElement("textarea");
    editor.value = state.translations.get(item.id) || snapshot?.activeVersion?.translatedText || "";
    const instruction = document.createElement("input");
    instruction.placeholder = "给 AI 的单轮修订指令（可选）";
    const actions = document.createElement("div");
    actions.className = "mt-novel-revision-actions";
    const run = async (button, task) => {
      button.disabled = true;
      try {
        await task();
        await renderRevisionPanel(chapter);
      } catch (error) {
        state.revisionPanelStatus.textContent = runtime.getErrorMessage(error);
      } finally {
        button.disabled = false;
      }
    };
    actions.append(
      actionButton("保存修改", button => run(button, () => submitEdit(chapter, item, editor.value))),
      actionButton("重新翻译", button => run(button, () => requestAiRevision(chapter, item))),
      actionButton("AI 修订", button => run(button, () => requestAiRevision(chapter, item, instruction.value))),
      actionButton("删除", button => run(button, () => deleteTranslation(chapter, item)))
    );
    const versions = document.createElement("div");
    versions.className = "mt-novel-version-list";
    for (const version of snapshot?.recentVersions || []) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `${version.source}${version.pinned ? " · pinned" : ""} · ${new Date(version.createdAt).toLocaleString()}`;
      row.append(label,
        actionButton("选择", button => run(button, () => selectVersion(chapter, item, version.versionId))),
        actionButton("固定", button => run(button, () => selectVersion(chapter, item, version.versionId, true))));
      versions.appendChild(row);
    }
    card.append(badge, source, editor, instruction, actions, versions);
    return card;
  }

  async function renderRevisionPanel(chapter) {
    const state = runtime.getNovelState();
    const body = state.revisionPanelBody;
    body.replaceChildren();
    const keys = chapter.paragraphs.map(item => recordKey(chapter, item));
    const service = await runtime.syncTranslationService(keys);
    state.translationSnapshots = new Map((service.records || []).map(record => [record.recordKey, record]));
    const fingerprint = await runtime.getTranslationConfigFingerprint("novel");
    state.revisionPanelStatus.textContent = service.pendingConflicts?.length
      ? `有 ${service.pendingConflicts.length} 个离线操作因版本变化未应用，请按最新译文重新确认`
      : service.ok
        ? "SQLite 在线；所有正式版本以本地服务为准"
      : "本地服务未启动；编辑将进入待提交队列";
    for (const item of chapter.paragraphs.filter(candidate => state.translations.has(candidate.id))) {
      body.appendChild(await renderCard(chapter, item, fingerprint));
    }
  }

  async function openNovelRevisionPanel() {
    const chapter = runtime.extractKakaoNovelChapter(runtime.reconcileKakaoNovelReader());
    if (!chapter) return { ok: false, error: "当前页面不是可管理的小说章节" };
    const panel = ensurePanel();
    panel.hidden = false;
    await renderRevisionPanel(chapter);
    return { ok: true };
  }
  runtime.openNovelRevisionPanel = openNovelRevisionPanel;
}
