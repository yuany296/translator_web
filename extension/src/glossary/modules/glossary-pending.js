export function installGlossaryPending(runtime) {
  function renderIgnoredTerms() {
    runtime.ignoredPanel.classList.toggle("hidden", runtime.ignoredStore.sources.length === 0);
    runtime.ignoredRows.replaceChildren(...runtime.ignoredStore.sources.map(item => {
      const row = document.createElement("div");
      row.className = "ignored-row";
      const source = document.createElement("span");
      source.textContent = item.source;
      const button = runtime.createActionButton("恢复", "restore");
      button.dataset.source = item.source;
      row.append(source, button);
      return row;
    }));
  }
  runtime.renderIgnoredTerms = renderIgnoredTerms;
  /** 候选卡所在章节当前指向的术语库（选择框优先，其次章节记录）。 */
  function libraryIdForCard(card) {
    const control = card.closest(".pending-chapter")?.querySelector(".chapter-library-select");
    return control ? control.value : "";
  }
  runtime.libraryIdForCard = libraryIdForCard;
  async function handlePendingCandidateClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    if (button.dataset.action === "ignore-chapter-all") {
      const chapterEl = event.target.closest(".pending-chapter");
      const chapterKey = chapterEl ? String(chapterEl.dataset.chapterKey || "") : "";
      const chapter = runtime.pendingStore.chapters.find(item => item.key === chapterKey);
      const sources = chapter ? chapter.candidates.map(candidate => candidate.source) : [];
      if (sources.length === 0) {
        return;
      }
      await runtime.runPendingAction({
        type: "IGNORE_TERM_CANDIDATES",
        entries: sources.map(source => ({ chapterKey, source })),
        scope: "chapter"
      }, `本话已忽略 ${sources.length} 条`);
      return;
    }
    if (button.dataset.action === "ai-extract" || button.dataset.action === "new-library") {
      // 这两个按钮自带点击处理（AI 提取、按网址建库），不进入忽略/确认逻辑。
      return;
    }
    const card = event.target.closest(".candidate-card");
    if (!card) {
      return;
    }
    const candidateSource = card.dataset.source;
    const chapterKey = card.dataset.chapterKey;
    if (button.dataset.action === "confirm") {
      const source = card.querySelector(".candidate-source-input").value.trim();
      const target = card.querySelector(".candidate-target").value.trim();
      const note = card.querySelector(".candidate-note").value.trim();
      if (!source) {
        runtime.setPendingStatus("原文术语不能为空", true);
        card.querySelector(".candidate-source-input").focus();
        return;
      }
      if (!target) {
        runtime.setPendingStatus(`请先填写“${source}”的固定译文`, true);
        card.querySelector(".candidate-target").focus();
        return;
      }
      await runtime.confirmPendingEntries([{
        candidateSource,
        source,
        target,
        note,
        chapterKey,
        libraryId: libraryIdForCard(card)
      }]);
      return;
    }
    const scope = button.dataset.action === "ignore-global" ? "global" : "chapter";
    await runtime.runPendingAction({
      type: "IGNORE_TERM_CANDIDATE",
      chapterKey,
      source: candidateSource,
      scope
    }, scope === "global" ? `已永久忽略“${candidateSource}”` : `本话已忽略“${candidateSource}”`);
  }
  runtime.handlePendingCandidateClick = handlePendingCandidateClick;
  async function confirmAllFilledCandidates() {
    const entries = Array.from(runtime.pendingChapters.querySelectorAll(".candidate-card")).map(card => ({
      candidateSource: card.dataset.source,
      source: card.querySelector(".candidate-source-input").value.trim(),
      target: card.querySelector(".candidate-target").value.trim(),
      note: card.querySelector(".candidate-note").value.trim(),
      chapterKey: card.dataset.chapterKey,
      libraryId: libraryIdForCard(card)
    })).filter(entry => entry.source && entry.target);
    if (entries.length === 0) {
      runtime.setPendingStatus("没有已填写译名的候选术语", true);
      return;
    }
    const libraries = new Set(entries.map(entry => runtime.libraryLabel(entry.libraryId) || runtime.glossaryCore.DEFAULT_LIBRARY_NAME));
    await runtime.confirmPendingEntries(entries, libraries.size === 1
      ? `将加入「${[...libraries][0]}」` : "");
  }
  runtime.confirmAllFilledCandidates = confirmAllFilledCandidates;
  async function confirmPendingEntries(entries, hint = "") {
    await runtime.runPendingAction({
      type: "CONFIRM_TERM_CANDIDATES",
      entries
    }, `已加入 ${entries.length} 条正式术语${hint ? `（${hint}）` : ""}`);
  }
  runtime.confirmPendingEntries = confirmPendingEntries;
  async function ignoreAllPendingCandidates() {
    // 只忽略当前详情页范围内的候选：进了某个库，别把别的库的候选一起忽略掉。
    const chapters = runtime.scopedPendingChapters();
    const entries = chapters.flatMap(chapter => chapter.candidates.map(candidate => ({
      chapterKey: chapter.key,
      source: candidate.source
    })));
    if (entries.length === 0) {
      runtime.setPendingStatus("没有可忽略的候选术语", true);
      return;
    }
    if (!window.confirm(`永久忽略全部 ${entries.length} 条候选？可在「永久忽略项」中恢复。`)) {
      return;
    }
    await runtime.runPendingAction({
      type: "IGNORE_TERM_CANDIDATES",
      entries,
      scope: "global"
    }, `已永久忽略 ${entries.length} 条候选`);
  }
  runtime.ignoreAllPendingCandidates = ignoreAllPendingCandidates;
  async function resetProcessedEvidence() {
    if (!window.confirm("重置所有章节的“已处理”标记？之后重新翻译的章节会再次进行术语提取。")) {
      return;
    }
    await runtime.runPendingAction({
      type: "RESET_TERM_DISCOVERY_PROCESSED"
    }, "已重置全部章节的已处理标记，重新翻译章节后会自动重新提取");
  }
  runtime.resetProcessedEvidence = resetProcessedEvidence;
  async function handleIgnoredClick(event) {
    const button = event.target.closest("button[data-action='restore']");
    if (!button) {
      return;
    }
    await runtime.runPendingAction({
      type: "RESTORE_IGNORED_TERM",
      source: button.dataset.source
    }, `已恢复“${button.dataset.source}”，后续出现时会重新发现`);
  }
  runtime.handleIgnoredClick = handleIgnoredClick;
  async function runPendingAction(message, successMessage) {
    try {
      const response = await runtime.sendRuntimeMessage(message);
      if (!response || !response.ok) {
        throw new Error(response && response.error || "操作失败");
      }
      runtime.setPendingStatus(successMessage, false);
      await Promise.all([runtime.loadGlossary(), runtime.loadTermDiscoveryState(false)]);
    } catch (error) {
      runtime.setPendingStatus(`操作失败：${runtime.getErrorMessage(error)}`, true);
    }
  }
  runtime.runPendingAction = runPendingAction;
  async function loadGlossary(source = "auto") {
    // "auto": try server, fall back to chrome.storage
    // "server": try server only
    // "storage": chrome.storage only
    let serverFailed = false;
    if (source !== "storage") {
      const result = await runtime.loadGlossaryFromServer();
      if (result.ok) return;
      serverFailed = true;
    }
    if (source === "server") return;
    try {
      const stored = await runtime.storageGet([
        runtime.glossaryCore.STORAGE_KEY,
        runtime.glossaryCore.LEGACY_STORAGE_KEY
      ]);
      const raw = stored[runtime.glossaryCore.STORAGE_KEY] ??
        stored[runtime.glossaryCore.LEGACY_STORAGE_KEY];
      runtime.glossary = runtime.glossaryCore.normalizeGlossary(raw);
      if (stored[runtime.glossaryCore.STORAGE_KEY] === undefined && raw !== undefined) {
        await runtime.storageSet({ [runtime.glossaryCore.STORAGE_KEY]: runtime.glossary });
      }
      runtime.renderGlossary();
      runtime.renderLibraryPanel();
      runtime.refreshPendingLibraryControls();
      if (serverFailed) {
        // 服务离线时看到的是浏览器里那份副本，很容易被当成「数据都没了」——把话说清楚。
        runtime.setStatus(
          `本地服务离线：现在显示浏览器里保存的副本（${runtime.glossary.entries.length} 条术语）。`
          + "SQLite 词库里的数据没有丢，服务恢复后刷新这一页就会同步回来。", true);
      }
    } catch (error) {
      runtime.setStatus(`读取术语库失败：${runtime.getErrorMessage(error)}`, true);
    }
  }
  runtime.loadGlossary = loadGlossary;
  const pendingStatusText = document.getElementById("pendingStatusText");
  runtime.pendingStatusText = pendingStatusText;
  const ignoredPanel = document.getElementById("ignoredPanel");
  runtime.ignoredPanel = ignoredPanel;
  const ignoredRows = document.getElementById("ignoredRows");
  runtime.ignoredRows = ignoredRows;
  let pendingStore = runtime.termDiscoveryCore.normalizePendingStore(null);
  runtime.pendingStore = pendingStore;
  let ignoredStore = runtime.termDiscoveryCore.normalizeIgnoredStore(null);
  runtime.ignoredStore = ignoredStore;
}
