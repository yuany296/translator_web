import { CONFIG_KEYS } from "../../config/schema.js";

export function installGlossaryEditor(runtime) {
  function bindEvents() {
    runtime.addBtn.addEventListener("click", () => runtime.openEditor());
    runtime.searchInput.addEventListener("input", runtime.handleSearchInput);
    // 零弹窗：点「导入文件」直接开系统文件框，去向由 glossary-import-target 按左侧选中库/文件名决定。
    runtime.importBtn.addEventListener("click", () => runtime.fileInput.click());
    runtime.fileInput.addEventListener("change", runtime.importGlossaryFile);
    runtime.exportBtn.addEventListener("click", () => runtime.openExportDialog());
    runtime.exportJsonConfirm.addEventListener("click", () => {
      runtime.exportDialog.close();
      runtime.exportGlossaryJson();
    });
    runtime.exportCsvConfirm.addEventListener("click", () => {
      runtime.exportDialog.close();
      runtime.exportGlossaryCsv();
    });
    runtime.exportCancelBtn.addEventListener("click", () => runtime.exportDialog.close());
    runtime.clearBtn.addEventListener("click", runtime.clearGlossary);
    runtime.termForm.addEventListener("submit", runtime.saveEditor);
    runtime.cancelBtn.addEventListener("click", () => runtime.termDialog.close());
    runtime.termRows.addEventListener("click", runtime.handleRowClick);
    runtime.termRows.addEventListener("change", runtime.handleRowToggle);
    // 表格内直接改原文/译文/备注：change（离开格子）提交，Enter 提交，Esc 还原。
    runtime.termRows.addEventListener("change", runtime.handleCellChange);
    runtime.termRows.addEventListener("keydown", runtime.handleCellKeydown);
    runtime.officialTabBtn.addEventListener("click", () => runtime.switchTab("official"));
    runtime.pendingTabBtn.addEventListener("click", () => runtime.switchTab("pending"));
    runtime.confirmFilledBtn.addEventListener("click", runtime.confirmAllFilledCandidates);
    runtime.ignoreAllBtn.addEventListener("click", runtime.ignoreAllPendingCandidates);
    runtime.resetProcessedBtn.addEventListener("click", runtime.resetProcessedEvidence);
    runtime.pendingChapters.addEventListener("click", runtime.handlePendingCandidateClick);
    runtime.bindPendingTargetEvents();
    runtime.ignoredRows.addEventListener("click", runtime.handleIgnoredClick);
    runtime.bindLibraryPanelEvents();
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes[runtime.glossaryCore.STORAGE_KEY]) {
        runtime.glossary = runtime.glossaryCore.normalizeGlossary(changes[runtime.glossaryCore.STORAGE_KEY].newValue);
        runtime.renderGlossary();
        runtime.renderLibraryPanel();
        runtime.refreshPendingLibraryControls();
      }
      if (changes[runtime.termDiscoveryCore.PENDING_STORAGE_KEY] ||
          changes[runtime.termDiscoveryCore.IGNORED_STORAGE_KEY] || changes[CONFIG_KEYS.runtime]) {
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
    // 切换 tab 时通知批量操作模块（批量操作只在正式术语 tab 有效）。
    runtime.handleGlossaryTabSwitch?.(runtime.activeTab);
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
  /**
   * 当前详情页范围内的待确认章节：进了某个库就只看路由到该库的章节
   * （手动指定优先 → 网址绑定匹配 → 默认术语库），「全部术语」总览才看全部。
   */
  function scopedPendingChapters() {
    const activeId = runtime.glossaryCore.normalizeLibraryId(runtime.activeLibraryId);
    return runtime.pendingStore.chapters
      .filter(chapter => chapter.candidates.length > 0)
      .filter(chapter => !activeId || runtime.effectiveLibraryId(chapter) === activeId);
  }
  runtime.scopedPendingChapters = scopedPendingChapters;
  /** 只按当前库重算「待确认」的数字与列表（换库、换视图时调用）。 */
  function renderPendingScope() {
    const chapters = scopedPendingChapters();
    const pendingCount = chapters.reduce((total, chapter) => total + chapter.candidates.length, 0);
    runtime.pendingTabBtn.textContent = `待确认（${pendingCount}）`;
    runtime.confirmFilledBtn.disabled = pendingCount === 0;
    runtime.ignoreAllBtn.textContent = pendingCount ? `永久忽略全部（${pendingCount}）` : "永久忽略全部";
    runtime.ignoreAllBtn.disabled = pendingCount === 0;
    runtime.pendingChapters.replaceChildren(...chapters.map(runtime.createPendingChapter));
    runtime.pendingEmptyState.classList.toggle("hidden", pendingCount !== 0);
    // 补译名按钮上的数字跟着候选一起变（剩下多少条还没译名）。
    runtime.renderFillButton?.();
    // 列表页每行要显示「N 条待确认」，候选或当前库一变就刷新库列表。
    runtime.renderLibraryPanel();
  }
  runtime.renderPendingScope = renderPendingScope;
  /**
   * 最近一次自动提取怎么了。术语没收集到时，「提取器在线」这句是没用的——
   * 必须说清是失败（带原因）、被跳过，还是提取到的东西全被去重掉了。
   */
  function renderPendingState(response = {}) {
    // 先记录句子级 AI 提取服务是否可用，候选卡渲染时才不会漏掉“AI 提取”按钮。
    runtime.sentenceLlmConfigured = response.sentenceLlmConfigured === true;
    renderPendingScope();
    runtime.renderIgnoredTerms();
    const enabled = response.enabled !== false;
    const stateValue = String(response.status && response.status.state || "unknown");
    const engine = String(response.status && response.status.engine || "");
    // 服务端没配 LLM 时可能报 ner（本地 NER 模型）；不上报就退回「提取器」这个中性说法。
    // none = 没配 AI 且本地模型不可用：没有兜底算法，说清「不可用」比含糊的「提取器」有用。
    const modeLabel = { ollama: "AI（Ollama）", ner: "本地模型", none: "本地模型不可用" }[engine] || "提取器";
    if (!enabled || stateValue === "disabled") {
      runtime.extractorStatus.textContent = "术语提取器：自动发现已关闭";
    } else if (engine === "none" && stateValue === "online") {
      // 「在线」但引擎是 none：服务活着，可这次提取一条候选都不会产出，得说清楚。
      runtime.extractorStatus.textContent = "术语提取器：本地模型不可用（不会产出候选）";
    } else if (stateValue === "online") {
      runtime.extractorStatus.textContent = `术语提取器：${modeLabel}在线`;
    } else if (stateValue === "offline") {
      runtime.extractorStatus.textContent = `术语提取器：${modeLabel}离线（不影响翻译）`;
    } else {
      runtime.extractorStatus.textContent = "术语提取器：等待本地服务";
    }
    // 健康探测成功会把状态翻回「在线」，所以失败原因单独挂出来，不被「在线」盖掉。
    const lastText = runtime.describeLastDiscovery?.(response.lastDiscovery) || "";
    if (lastText) {
      runtime.extractorStatus.textContent = `${runtime.extractorStatus.textContent} · ${lastText}`;
      runtime.extractorStatus.title = lastText;
    } else {
      runtime.extractorStatus.removeAttribute?.("title");
    }
  }
  runtime.renderPendingState = renderPendingState;
  function createPendingChapter(chapter) {
    const section = document.createElement("section");
    section.className = "pending-chapter";
    section.dataset.chapterKey = chapter.key;
    const heading = document.createElement("div");
    heading.className = "chapter-heading";
    const left = document.createElement("div");
    left.className = "chapter-heading-left";
    const title = document.createElement("h2");
    title.textContent = `${chapter.title || "未命名章节"}（${chapter.candidates.length}）`;
    const url = document.createElement("div");
    url.className = "chapter-url";
    url.textContent = chapter.url;
    left.append(title, url);
    const chapterActions = document.createElement("div");
    chapterActions.className = "chapter-heading-actions";
    // 本地模型只认得出「这是个人名」，给不出译名 —— 所以每一话都要能一键把空译名补齐。
    const fillable = chapter.candidates.filter(candidate => candidate.suggestedTargets.length === 0).length;
    if (fillable > 0 && runtime.sentenceLlmConfigured) {
      const chapterFill = runtime.createActionButton(`AI 补全本话译名（${fillable}）`, "ai-fill-targets");
      chapterFill.addEventListener("click", () => void runtime.fillChapterTargets?.(chapter.key));
      chapterActions.append(chapterFill);
    }
    chapterActions.append(runtime.createActionButton("忽略本话全部", "ignore-chapter-all", "danger"));
    heading.append(left, chapterActions);
    section.append(heading, runtime.buildChapterLibraryControl(chapter), ...chapter.candidates.map(candidate => runtime.createCandidateCard(chapter, candidate)));
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
    if (candidate.sentenceOnly) {
      heading.append(runtime.createBadge("看句子自行判断", "sentence"));
    }
    const grid = document.createElement("div");
    grid.className = "candidate-grid";
    const sentenceOnly = candidate.sentenceOnly === true;
    const sourceField = runtime.createCandidateField("原文术语" + (sentenceOnly ? "（留空则看句子填写）" : "（可修改）"), "candidate-source-input", sentenceOnly ? "" : candidate.source, 120);
    grid.append(sourceField, runtime.createCandidateField("固定译文", "candidate-target", candidate.suggestedTarget, 120), runtime.createCandidateField("备注（可选）", "candidate-note", candidate.note, 240));
    const sourceInput = grid.querySelector(".candidate-source-input");
    const targetInput = grid.querySelector(".candidate-target");
    const noteInput = grid.querySelector(".candidate-note");
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
    if (runtime.sentenceLlmConfigured) {
      const aiButton = runtime.createActionButton("AI 提取", "ai-extract");
      aiButton.addEventListener("click", () => void runAiExtract(aiButton, sourceInput, targetInput, noteInput, source, candidate, card));
      actions.prepend(aiButton);
    }
    card.append(heading, grid, contexts, actions);
    return card;
  }
  runtime.createCandidateCard = createCandidateCard;
  async function runAiExtract(button, sourceInput, targetInput, noteInput, source, candidate, card) {
    const context = candidate.contexts && candidate.contexts[0];
    if (!context) {
      return;
    }
    const aiTerms = card.dataset.aiTerms ? JSON.parse(card.dataset.aiTerms) : null;
    if (!aiTerms) {
      button.disabled = true;
      button.textContent = "AI 提取中…";
      try {
        const response = await runtime.sendRuntimeMessage({
          type: "EXTRACT_TERMS_FROM_SENTENCE",
          sourceText: context.originalText,
          translatedText: context.translatedText || ""
        });
        if (!response || !response.ok) {
          throw new Error(response && response.error || "提取失败");
        }
        const terms = Array.isArray(response.terms) ? response.terms : [];
        if (terms.length === 0) {
          button.textContent = "AI 提取";
          button.disabled = false;
          return;
        }
        card.dataset.aiTerms = JSON.stringify(terms);
        card.dataset.aiIndex = "0";
        fillAiTerm(sourceInput, targetInput, noteInput, source, terms, 0);
        if (terms.length > 1) {
          button.textContent = `填入下一个候选（${1}/${terms.length}）`;
        } else {
          button.textContent = "重新提取";
        }
        button.disabled = false;
      } catch (error) {
        button.textContent = "AI 提取";
        button.disabled = false;
        runtime.setPendingStatus(`AI 提取失败：${runtime.getErrorMessage(error)}`, true);
      }
    } else {
      const index = (Number(card.dataset.aiIndex) || 0) + 1;
      if (index >= aiTerms.length) {
        delete card.dataset.aiTerms;
        delete card.dataset.aiIndex;
        button.textContent = "AI 提取";
      } else {
        card.dataset.aiIndex = String(index);
        fillAiTerm(sourceInput, targetInput, noteInput, source, aiTerms, index);
        button.textContent = `填入下一个候选（${index + 1}/${aiTerms.length}）`;
      }
    }
  }
  runtime.runAiExtract = runAiExtract;
  function fillAiTerm(sourceInput, targetInput, noteInput, source, terms, index) {
    const item = terms[index];
    if (!item) return;
    sourceInput.value = item.term;
    source.textContent = item.term;
    targetInput.value = item.target || "";
    targetInput.dataset.userEdited = "false";
  }
  runtime.fillAiTerm = fillAiTerm;
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
      title: "作品/标题",
      proper_noun: "专有名词",
      latin_name: "英文名称",
      latin_title: "英文标题",
      location: "地名",
      organization: "机构",
      group: "团体"
    };
    return labels[String(kind || "")] || "专有名词";
  }
  runtime.formatCandidateKind = formatCandidateKind;

  const addBtn = document.getElementById("addBtn");
  runtime.addBtn = addBtn;
  const officialTabBtn = document.getElementById("officialTabBtn");
  runtime.officialTabBtn = officialTabBtn;
  const pendingTabBtn = document.getElementById("pendingTabBtn");
  runtime.pendingTabBtn = pendingTabBtn;
  const officialPanel = document.getElementById("officialPanel");
  runtime.officialPanel = officialPanel;
  const pendingPanel = document.getElementById("pendingPanel");
  runtime.pendingPanel = pendingPanel;
  const exportBtn = document.getElementById("exportBtn");
  runtime.exportBtn = exportBtn;
  const exportDialog = document.getElementById("exportDialog");
  runtime.exportDialog = exportDialog;
  const exportJsonConfirm = document.getElementById("exportJsonConfirm");
  runtime.exportJsonConfirm = exportJsonConfirm;
  const exportCsvConfirm = document.getElementById("exportCsvConfirm");
  runtime.exportCsvConfirm = exportCsvConfirm;
  const exportCancelBtn = document.getElementById("exportCancelBtn");
  runtime.exportCancelBtn = exportCancelBtn;
  const clearBtn = document.getElementById("clearBtn");
  runtime.clearBtn = clearBtn;
  const statusText = document.getElementById("statusText");
  runtime.statusText = statusText;
  const cancelBtn = document.getElementById("cancelBtn");
  runtime.cancelBtn = cancelBtn;
  const confirmFilledBtn = document.getElementById("confirmFilledBtn");
  runtime.confirmFilledBtn = confirmFilledBtn;
  const ignoreAllBtn = document.getElementById("ignoreAllBtn");
  runtime.ignoreAllBtn = ignoreAllBtn;
  const resetProcessedBtn = document.getElementById("resetProcessedBtn");
  runtime.resetProcessedBtn = resetProcessedBtn;
  const extractorStatus = document.getElementById("extractorStatus");
  runtime.extractorStatus = extractorStatus;
  const pendingChapters = document.getElementById("pendingChapters");
  runtime.pendingChapters = pendingChapters;
  const pendingEmptyState = document.getElementById("pendingEmptyState");
  runtime.pendingEmptyState = pendingEmptyState;
  let glossary = runtime.glossaryCore.normalizeGlossary(null);
  runtime.glossary = glossary;
  let activeTab = "official";
  runtime.activeTab = activeTab;

  document.addEventListener("DOMContentLoaded", async () => {
    runtime.bindEvents();
    await Promise.all([runtime.loadGlossary(), runtime.loadTermDiscoveryState(true)]);
  });
}
