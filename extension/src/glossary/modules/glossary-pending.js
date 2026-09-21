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
      }, `本话已忽略 ${sources.length} 条`, `正在忽略本话的 ${sources.length} 条候选…`);
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
      }], "", `正在加入“${source}”…`);
      return;
    }
    const scope = button.dataset.action === "ignore-global" ? "global" : "chapter";
    await runtime.runPendingAction({
      type: "IGNORE_TERM_CANDIDATE",
      chapterKey,
      source: candidateSource,
      scope
    }, scope === "global" ? `已永久忽略“${candidateSource}”` : `本话已忽略“${candidateSource}”`,
      `正在忽略“${candidateSource}”…`);
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
      ? `将加入「${[...libraries][0]}」` : "", `正在加入 ${entries.length} 条…`);
  }
  runtime.confirmAllFilledCandidates = confirmAllFilledCandidates;
  async function confirmPendingEntries(entries, hint = "", pendingMessage = "正在加入…") {
    await runtime.runPendingAction({
      type: "CONFIRM_TERM_CANDIDATES",
      entries
    }, `已加入 ${entries.length} 条正式术语${hint ? `（${hint}）` : ""}`, pendingMessage);
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
    }, `已永久忽略 ${entries.length} 条候选`, `正在永久忽略 ${entries.length} 条候选…`);
  }
  runtime.ignoreAllPendingCandidates = ignoreAllPendingCandidates;
  async function resetProcessedEvidence() {
    if (!window.confirm("重置所有章节的“已处理”标记？之后重新翻译的章节会再次进行术语提取。")) {
      return;
    }
    await runtime.runPendingAction({
      type: "RESET_TERM_DISCOVERY_PROCESSED"
    }, "已重置全部章节的已处理标记，重新翻译章节后会自动重新提取", "正在重置已处理标记…");
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
    }, `已恢复“${button.dataset.source}”，后续出现时会重新发现`, `正在恢复“${button.dataset.source}”…`);
  }
  runtime.handleIgnoredClick = handleIgnoredClick;
  function formatElapsed(startedAt) {
    const seconds = Math.max(0, Math.round((Date.now() - (Number(startedAt) || 0)) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`;
  }
  runtime.formatElapsed = formatElapsed;
  /**
   * 最近一次自动提取怎么了。术语没收集到时，「提取器在线」这句是没用的——
   * 必须说清是失败（带原因）、被跳过、还在跑，还是提取到的东西全被去重掉了。
   */
  function describeLastDiscovery(last) {
    if (!last || !(last.at || last.startedAt)) {
      return "";
    }
    const when = new Date(Number(last.at || last.startedAt) || 0).toLocaleTimeString();
    if (last.outcome === "running") {
      // 请求挂住时这里会一直停在「正在提取（已 N 分钟）」——一眼看出是卡住而不是没触发。
      const budget = Number(last.budgetMs) > 0
        ? `，本次预算最多约 ${Math.round(Number(last.budgetMs) / 60000)} 分钟` : "";
      return `正在提取（已 ${formatElapsed(last.startedAt || last.at)}${budget}）`;
    }
    if (last.outcome === "failed") {
      const label = last.reason === "timeout" ? "上次提取超时" : "上次提取失败";
      return `${label}（${when}）：${last.error || "提取器不可用"}`;
    }
    if (last.outcome === "skipped") {
      const reasons = {
        disabled: "自动发现已关闭",
        already_processed: "这一章已经提取过，没有新段落",
        cooldown: "提取器冷却中（上次失败后不立即重试）",
        throttled: "同一页 30 秒内只提取一次"
      };
      return `上次跳过（${when}）：${reasons[last.reason] || last.reason || "未说明原因"}`;
    }
    // 「跑了一部分」：分段超时/失败时最容易被误当成「模型不行」。缺的那些段落没被标记
    // 已处理，30 秒后会自动补跑（手机版尤其常见：整章提取跑在 Service Worker 里）。
    if (last.outcome === "partial") {
      const chunks = Number(last.totalChunks) > 0 ? `（共 ${last.totalChunks} 段）` : "";
      return `上次提取（${when}）有 ${Number(last.failedChunks) || 1} 段没跑完${chunks}，`
        + "已保留已提取的候选，稍后会自动补跑剩下的段落";
    }
    if (last.outcome === "added") {
      const dropped = Number(last.dropped?.invalidKind || 0) + Number(last.dropped?.notInSource || 0)
        + Number(last.dropped?.schema || 0) + Number(last.dropped?.noJson || 0);
      // 模型给了却被判掉的条数：说清「是模型没给」还是「给了被丢」，这是「术语老漏」
      // 最常见、也最容易被误判成「提取器不行」的一种。
      const droppedText = dropped > 0
        ? `，另有 ${dropped} 条被丢弃（kind 非法 ${Number(last.dropped?.invalidKind || 0)}、`
          + `原文里找不到 ${Number(last.dropped?.notInSource || 0)}）`
        : "";
      const unknown = Number(last.dropped?.unknownKind || 0);
      const unknownText = unknown > 0 ? `，${unknown} 条自造 kind 已按专有名词保留` : "";
      return Number(last.added) > 0
        ? `上次提取（${when}）新增 ${last.added} 条候选${droppedText}${unknownText}`
        : `上次提取（${when}）返回 ${Number(last.returned) || 0} 条，都不是新候选（可能已在术语库里或被忽略）${droppedText}${unknownText}`;
    }
    return "";
  }
  runtime.describeLastDiscovery = describeLastDiscovery;
  /**
   * 后台可能很久不回话（典型场景：整章术语提取挂在 LLM 上游，最长 10 分钟）。
   * 以前这里会一直静默等下去，按钮看上去就是「点不动」；现在点下去先给「正在…」，
   * 超时就把原因说出来——用户至少知道是该等还是该重试。
   */
  const pendingActionTimeoutMs = (() => {
    const override = Number(globalThis.__MT_PENDING_ACTION_TIMEOUT_MS);
    return Number.isFinite(override) && override > 0 ? override : 20000;
  })();
  runtime.pendingActionTimeoutMs = pendingActionTimeoutMs;
  function withPendingTimeout(promise, timeoutMs = pendingActionTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("后台没有响应（可能正在跑整章术语提取），稍后重试")),
        timeoutMs
      );
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); }
      );
    });
  }
  runtime.withPendingTimeout = withPendingTimeout;
  async function runPendingAction(message, successMessage, pendingMessage = "正在提交…") {
    runtime.setPendingStatus(pendingMessage, false);
    try {
      const response = await withPendingTimeout(runtime.sendRuntimeMessage(message));
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
