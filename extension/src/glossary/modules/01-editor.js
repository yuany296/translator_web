export function installGlossary01(runtime) {
  function bindEvents() {
    runtime.addBtn.addEventListener("click", () => runtime.openEditor());
    runtime.searchInput.addEventListener("input", runtime.renderGlossary);
    runtime.importBtn.addEventListener("click", () => runtime.fileInput.click());
    runtime.fileInput.addEventListener("change", runtime.importGlossaryFile);
    runtime.exportJsonBtn.addEventListener("click", runtime.exportGlossaryJson);
    runtime.exportCsvBtn.addEventListener("click", runtime.exportGlossaryCsv);
    runtime.clearBtn.addEventListener("click", runtime.clearGlossary);
    runtime.migrateBtn.addEventListener("click", runtime.migrateGlossaryToServer);
    runtime.termForm.addEventListener("submit", runtime.saveEditor);
    runtime.cancelBtn.addEventListener("click", () => runtime.termDialog.close());
    runtime.termRows.addEventListener("click", runtime.handleRowClick);
    runtime.termRows.addEventListener("change", runtime.handleRowToggle);
    runtime.officialTabBtn.addEventListener("click", () => runtime.switchTab("official"));
    runtime.pendingTabBtn.addEventListener("click", () => runtime.switchTab("pending"));
    runtime.confirmFilledBtn.addEventListener("click", runtime.confirmAllFilledCandidates);
    runtime.pendingChapters.addEventListener("click", runtime.handlePendingCandidateClick);
    runtime.ignoredRows.addEventListener("click", runtime.handleIgnoredClick);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes[runtime.glossaryCore.STORAGE_KEY]) {
        runtime.glossary = runtime.glossaryCore.normalizeGlossary(changes[runtime.glossaryCore.STORAGE_KEY].newValue);
        runtime.renderGlossary();
      }
      if (changes[runtime.termDiscoveryCore.PENDING_STORAGE_KEY] || changes[runtime.termDiscoveryCore.IGNORED_STORAGE_KEY] || changes[runtime.termDiscoveryCore.ENABLED_STORAGE_KEY]) {
        runtime.loadTermDiscoveryState(false).catch(() => undefined);
      }
    });
  }
  runtime.bindEvents = bindEvents;
  function switchTab(tab) {
    runtime.activeTab = tab === "pending" ? "pending" : "official";
    const showPending = runtime.activeTab === "pending";
    runtime.officialPanel.classList.toggle("hidden", showPending);
    runtime.pendingPanel.classList.toggle("hidden", !showPending);
    runtime.officialTabBtn.classList.toggle("active", !showPending);
    runtime.pendingTabBtn.classList.toggle("active", showPending);
    runtime.addBtn.classList.toggle("hidden", showPending);
    if (showPending) {
      runtime.loadTermDiscoveryState(true).catch(error => {
        runtime.setPendingStatus(`读取失败：${runtime.getErrorMessage(error)}`, true);
      });
    }
  }
  runtime.switchTab = switchTab;
  async function loadTermDiscoveryState(probe = false) {
    try {
      const response = await runtime.sendRuntimeMessage({
        type: "GET_TERM_DISCOVERY_STATE",
        probe
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "读取待确认术语失败");
      }
      runtime.pendingStore = runtime.termDiscoveryCore.normalizePendingStore(response.pending);
      runtime.ignoredStore = runtime.termDiscoveryCore.normalizeIgnoredStore(response.ignored);
      runtime.renderPendingState(response);
    } catch (error) {
      runtime.setPendingStatus(`读取待确认术语失败：${runtime.getErrorMessage(error)}`, true);
      throw error;
    }
  }
  runtime.loadTermDiscoveryState = loadTermDiscoveryState;
  function renderPendingState(response = {}) {
    const pendingCount = runtime.termDiscoveryCore.getPendingCount(runtime.pendingStore);
    runtime.pendingTabBtn.textContent = `待确认（${pendingCount}）`;
    runtime.pendingCountText.textContent = `最近 ${runtime.pendingStore.chapters.length} 话，共 ${pendingCount} 条待确认术语`;
    runtime.confirmFilledBtn.disabled = pendingCount === 0;
    runtime.pendingChapters.replaceChildren(...runtime.pendingStore.chapters.filter(chapter => chapter.candidates.length > 0).map(runtime.createPendingChapter));
    runtime.pendingEmptyState.classList.toggle("hidden", pendingCount !== 0);
    runtime.renderIgnoredTerms();
    const enabled = response.enabled !== false;
    const stateValue = String(response.status && response.status.state || "unknown");
    if (!enabled || stateValue === "disabled") {
      runtime.extractorStatus.textContent = "Kiwi 状态：自动发现已关闭";
    } else if (stateValue === "online") {
      runtime.extractorStatus.textContent = "Kiwi 状态：在线";
    } else if (stateValue === "offline") {
      runtime.extractorStatus.textContent = "Kiwi 状态：离线（不影响翻译）";
    } else {
      runtime.extractorStatus.textContent = "Kiwi 状态：等待本地服务";
    }
  }
  runtime.renderPendingState = renderPendingState;
  function createPendingChapter(chapter) {
    const section = document.createElement("section");
    section.className = "pending-chapter";
    section.dataset.chapterKey = chapter.key;
    const heading = document.createElement("div");
    heading.className = "chapter-heading";
    const title = document.createElement("h2");
    title.textContent = `${chapter.title || "未命名章节"}（${chapter.candidates.length}）`;
    const url = document.createElement("div");
    url.className = "chapter-url";
    url.textContent = chapter.url;
    heading.append(title, url);
    section.append(heading, ...chapter.candidates.map(candidate => runtime.createCandidateCard(chapter, candidate)));
    return section;
  }
  runtime.createPendingChapter = createPendingChapter;
  function createCandidateCard(chapter, candidate) {
    const card = document.createElement("article");
    card.className = "candidate-card";
    card.dataset.chapterKey = chapter.key;
    card.dataset.source = candidate.source;
    const heading = document.createElement("div");
    heading.className = "candidate-heading";
    const source = document.createElement("span");
    source.className = "candidate-source";
    source.textContent = candidate.source;
    heading.append(source, runtime.createBadge(runtime.formatCandidateKind(candidate.kind)), runtime.createBadge(`出现 ${candidate.occurrences} 次`));
    if (candidate.ambiguous) {
      heading.append(runtime.createBadge("可能有歧义", "warning"));
    }
    const grid = document.createElement("div");
    grid.className = "candidate-grid";
    grid.append(runtime.createCandidateField("原文术语（可修改）", "candidate-source-input", candidate.source, 120), runtime.createCandidateField("固定译文", "candidate-target", candidate.suggestedTarget, 120), runtime.createCandidateField("备注（可选）", "candidate-note", "", 240));
    const sourceInput = grid.querySelector(".candidate-source-input");
    const targetInput = grid.querySelector(".candidate-target");
    targetInput.dataset.autoSuggestion = candidate.suggestedTarget || "";
    targetInput.addEventListener("input", () => {
      targetInput.dataset.userEdited = "true";
    });
    sourceInput.addEventListener("input", () => {
      source.textContent = sourceInput.value.trim() || candidate.source;
      const suggestion = runtime.termDiscoveryCore.getSuggestedTargetForSource(sourceInput.value, candidate.contexts);
      if (targetInput.dataset.userEdited !== "true" || !targetInput.value.trim()) {
        targetInput.value = suggestion;
        targetInput.dataset.autoSuggestion = suggestion;
        targetInput.dataset.userEdited = "false";
      }
    });
    const contexts = document.createElement("div");
    contexts.className = "contexts";
    if (candidate.contexts.length === 0) {
      contexts.textContent = "暂无可展示的上下文";
    } else {
      contexts.append(...candidate.contexts.map(context => {
        const row = document.createElement("div");
        row.className = "context-row";
        row.textContent = context.translatedText ? `${context.originalText} → ${context.translatedText}` : context.originalText;
        return row;
      }));
    }
    const actions = document.createElement("div");
    actions.className = "pending-actions";
    actions.append(runtime.createActionButton("确认加入", "confirm", "primary"), runtime.createActionButton("本话忽略", "ignore-chapter"), runtime.createActionButton("永久忽略", "ignore-global", "danger"));
    card.append(heading, grid, contexts, actions);
    return card;
  }
  runtime.createCandidateCard = createCandidateCard;
  function createCandidateField(labelText, className, value, maxLength) {
    const field = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "text";
    input.className = className;
    input.maxLength = maxLength;
    input.value = value || "";
    label.append(input);
    field.append(label);
    return field;
  }
  runtime.createCandidateField = createCandidateField;
  function createBadge(text, className = "") {
    const badge = document.createElement("span");
    badge.className = `badge${className ? ` ${className}` : ""}`;
    badge.textContent = text;
    return badge;
  }
  runtime.createBadge = createBadge;
  function formatCandidateKind(kind) {
    const labels = {
      person: "人名",
      title: "韩文标题",
      proper_noun: "专有名词",
      latin_name: "英文名称",
      latin_title: "英文标题"
    };
    return labels[String(kind || "")] || "专有名词";
  }
  runtime.formatCandidateKind = formatCandidateKind;
}
