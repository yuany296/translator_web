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
    close.type = "button"; close.textContent = "×";
    close.addEventListener("click", () => { panel.hidden = true; });
    header.append(title, close);
    const status = document.createElement("div");
    status.className = "mt-novel-revision-status";
    const search = document.createElement("input");
    search.type = "search"; search.className = "mt-novel-revision-search";
    search.placeholder = "搜索原文或译文…";
    search.addEventListener("input", () => filterRevisionCards());
    const body = document.createElement("div");
    body.className = "mt-novel-revision-body";
    panel.append(header, status, search, body);
    document.documentElement.appendChild(panel);
    state.revisionPanel = panel;
    state.revisionPanelBody = body;
    state.revisionPanelStatus = status;
    state.revisionPanelSearch = search;
    return panel;
  }

  function filterRevisionCards() {
    const state = runtime.getNovelState();
    const body = state.revisionPanelBody;
    const query = (state.revisionPanelSearch?.value || "").trim().toLowerCase();
    let total = 0;
    let visible = 0;
    for (const card of body.querySelectorAll(".mt-novel-revision-card")) {
      total += 1;
      const source = card.querySelector(".mt-novel-revision-source");
      const editor = card.querySelector("textarea");
      const haystack = `${source?.textContent || ""} ${editor?.value || ""}`.toLowerCase();
      const match = !query || haystack.includes(query);
      card.hidden = !match;
      visible += match ? 1 : 0;
    }
    body.querySelector(".mt-novel-revision-empty")?.remove();
    if (query && total > 0 && visible === 0) {
      const hint = document.createElement("div");
      hint.className = "mt-novel-revision-empty";
      hint.textContent = `没有匹配「${state.revisionPanelSearch.value.trim()}」的段落`;
      body.appendChild(hint);
    }
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
    if (source && translation) { source.hidden = false; translation.hidden = true; }
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
    card.dataset.itemId = item.id;
    const badge = document.createElement("span");
    badge.className = "mt-novel-version-status";
    badge.dataset.status = versionStatus(state, snapshot, item, fingerprint);
    badge.textContent = badge.dataset.status;
    const source = document.createElement("div");
    source.className = "mt-novel-revision-source";
    source.textContent = item.original_text;    const editor = document.createElement("textarea");
    editor.value = state.translations.get(item.id) || snapshot?.activeVersion?.translatedText || "";
    const instruction = document.createElement("input");
    instruction.placeholder = "给 AI 的单轮修订指令（可选）";
    const actions = document.createElement("div");
    actions.className = "mt-novel-revision-actions";
    const run = async (button, task, anchorId = "") => {
      button.disabled = true;
      try {
        await task();
        await renderRevisionPanel(chapter, anchorId);
      } catch (error) {
        state.revisionPanelStatus.textContent = runtime.getErrorMessage(error);
      } finally {
        button.disabled = false;
      }
    };
    actions.append(
      actionButton("保存修改", button => run(button, () => submitEdit(chapter, item, editor.value), item.id)),
      actionButton("重新翻译", button => run(button, () => requestAiRevision(chapter, item), item.id)),
      actionButton("AI 修订", button => run(button, () => requestAiRevision(chapter, item, instruction.value), item.id)),
      actionButton("删除", button => run(button, () => deleteTranslation(chapter, item), item.id))
    );
    const term = createTermSection(item, source, editor);
    const termBtn = actionButton("＋ 术语", () => {
      term.section.hidden = !term.section.hidden;
      if (!term.section.hidden) {
        const selected = editor.value.slice(editor.selectionStart || 0, editor.selectionEnd || 0).trim();
        if (selected) term.targetInput.value = selected;
        term.status.textContent = selected ? "已填入译文框中选中的文字，可提取韩文原文或直接填写" : "可在下方译文框中选中文字，或直接填写固定译文";
      }
    });
    const versions = document.createElement("div");
    versions.className = "mt-novel-version-list";
    for (const version of snapshot?.recentVersions || []) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `${version.source}${version.pinned ? " · pinned" : ""} · ${new Date(version.createdAt).toLocaleString()}`;
      row.append(label, actionButton("选择", button => run(button, () => selectVersion(chapter, item, version.versionId), item.id)),
        actionButton("固定", button => run(button, () => selectVersion(chapter, item, version.versionId, true), item.id)));
      versions.appendChild(row);
    }
    card.append(badge, source, editor, instruction, actions, termBtn, term.section, versions);
    return card;
  }

  function createTermSection(item, sourceEl, editor) {
    const section = document.createElement("div");
    section.className = "mt-novel-revision-term";
    section.hidden = true;
    const sourceInput = document.createElement("input");
    sourceInput.className = "mt-term-source";
    sourceInput.maxLength = 120; sourceInput.placeholder = "韩文原文（AI 提取后自动填入，可修改）";
    const targetInput = document.createElement("input");
    targetInput.className = "mt-term-target";
    targetInput.maxLength = 120; targetInput.placeholder = "固定译文";
    const noteInput = document.createElement("input");
    noteInput.className = "mt-term-note";
    noteInput.maxLength = 240; noteInput.placeholder = "备注（可选）";
    const status = document.createElement("div");
    status.className = "mt-novel-revision-term-status";
    const actions = document.createElement("div");
    actions.className = "mt-novel-revision-term-actions";
    const extractBtn = actionButton("提取韩文原文", () => void extractTerm());
    const confirmBtn = actionButton("加入术语表", () => void confirmTerm());
    confirmBtn.className = "mt-primary";
    const cancelBtn = actionButton("取消", () => { section.hidden = true; });
    actions.append(extractBtn, confirmBtn, cancelBtn);
    section.append(sourceInput, targetInput, noteInput, status, actions);
    function selectedText() {
      const start = editor.selectionStart || 0;
      const end = editor.selectionEnd || 0;
      return start === end ? "" : editor.value.slice(start, end).trim();
    }
    async function extractTerm() {
      const selected = targetInput.value.trim() || selectedText();
      if (!selected) { status.textContent = "请先填写固定译文，或在译文框中选中文字"; return; }
      targetInput.value = selected;
      extractBtn.disabled = true;
      status.textContent = "正在提取韩文原文…";
      try {
        const response = await runtime.sendRuntimeMessage({
          type: "EXTRACT_TERM_FROM_CONTEXT",
          sourceText: String(sourceEl.textContent || "").trim(),
          translatedText: editor.value.trim(),
          selectedText: selected,
          targetLanguage: runtime.getTargetLanguage?.() || "zh-CN"
        });
        if (!response || !response.ok) throw new Error(response && response.error || "提取失败");
        sourceInput.value = response.term;
        status.textContent = response.foundInSource
          ? "已提取韩文原文，请核对"
          : "提取结果未能与原文完全匹配，请核对后修正";
      } catch (error) {
        status.textContent = `${runtime.getErrorMessage(error)}（可手动填写原文）`;
      } finally {
        extractBtn.disabled = false;
      }
    }
    async function confirmTerm() {
      const source = sourceInput.value.trim();
      const target = targetInput.value.trim() || selectedText();
      if (!source || !target) {
        status.textContent = "原文术语和固定译文都不能为空";
        return;
      }
      targetInput.value = target;
      confirmBtn.disabled = true;
      try {
        const response = await runtime.sendRuntimeMessage({
          type: "CONFIRM_TERM_CANDIDATES",
          entries: [{ source, target, note: noteInput.value.trim() }]
        });
        if (!response || !response.ok) throw new Error(response && response.error || "加入失败");
        status.textContent = response.serverSynced === false
          ? `已加入本地术语表，但未能同步到服务（${response.serverError || "本地服务不可用"}）`
          : "已加入术语表（已同步服务端）";
        window.setTimeout(() => { section.hidden = true; }, 1200);
      } catch (error) {
        status.textContent = `加入失败：${runtime.getErrorMessage(error)}`;
      } finally {
        confirmBtn.disabled = false;
      }
    }
    return { section, targetInput, status };
  }

  function revisionCardContentTop(card, body) {
    return card.getBoundingClientRect().top - body.getBoundingClientRect().top + (body.scrollTop || 0);
  }

  function visibleRevisionAnchor(body) {
    const scrollTop = body.scrollTop || 0;
    for (const card of body.querySelectorAll(".mt-novel-revision-card")) {
      if (!card.hidden && revisionCardContentTop(card, body) + card.offsetHeight > scrollTop) {
        return card.dataset.itemId || "";
      }
    }
    return "";
  }

  function restoreRevisionAnchor(body, anchor) {
    if (!anchor) return;
    let target = null;
    for (const card of body.querySelectorAll(".mt-novel-revision-card")) {
      if (card.dataset.itemId === anchor) { target = card; break; }
    }
    if (!target || target.hidden) return;
    body.scrollTop = Math.max(0, revisionCardContentTop(target, body) - 8);
  }

  async function renderRevisionPanel(chapter, anchorId = "") {
    const state = runtime.getNovelState();
    const body = state.revisionPanelBody;
    const anchor = anchorId || visibleRevisionAnchor(body);
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
    filterRevisionCards();
    restoreRevisionAnchor(body, anchor);
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
