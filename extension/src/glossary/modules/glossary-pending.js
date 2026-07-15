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
  async function handlePendingCandidateClick(event) {
    const button = event.target.closest("button[data-action]");
    const card = event.target.closest(".candidate-card");
    if (!button || !card) {
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
        note
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
      note: card.querySelector(".candidate-note").value.trim()
    })).filter(entry => entry.source && entry.target);
    if (entries.length === 0) {
      runtime.setPendingStatus("没有已填写译名的候选术语", true);
      return;
    }
    await runtime.confirmPendingEntries(entries);
  }
  runtime.confirmAllFilledCandidates = confirmAllFilledCandidates;
  async function confirmPendingEntries(entries) {
    await runtime.runPendingAction({
      type: "CONFIRM_TERM_CANDIDATES",
      entries
    }, `已加入 ${entries.length} 条正式术语`);
  }
  runtime.confirmPendingEntries = confirmPendingEntries;
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
  async function loadGlossary() {
    try {
      const stored = await runtime.storageGet([runtime.glossaryCore.STORAGE_KEY]);
      runtime.glossary = runtime.glossaryCore.normalizeGlossary(stored[runtime.glossaryCore.STORAGE_KEY]);
      runtime.renderGlossary();
    } catch (error) {
      runtime.setStatus(`读取术语库失败：${runtime.getErrorMessage(error)}`, true);
    }
  }
  runtime.loadGlossary = loadGlossary;
  function renderGlossary() {
    const query = String(runtime.searchInput.value || "").trim().toLocaleLowerCase();
    const filtered = runtime.glossary.entries.filter(entry => {
      if (!query) {
        return true;
      }
      return [entry.source, entry.target, entry.note].some(value => String(value || "").toLocaleLowerCase().includes(query));
    });
    const enabledCount = runtime.glossary.entries.filter(entry => entry.enabled).length;
    runtime.countText.textContent = query ? `共 ${runtime.glossary.entries.length} 条，匹配 ${filtered.length} 条，启用 ${enabledCount} 条` : `共 ${runtime.glossary.entries.length} 条，启用 ${enabledCount} 条`;
    runtime.termRows.replaceChildren(...filtered.map(runtime.createTermRow));
    runtime.emptyState.textContent = runtime.glossary.entries.length === 0 ? "暂无术语，点击“新增术语”开始建立词库。" : "没有匹配当前搜索条件的术语。";
    runtime.emptyState.classList.toggle("hidden", filtered.length !== 0);
  }
  runtime.renderGlossary = renderGlossary;
  function createTermRow(entry) {
    const row = document.createElement("tr");
    row.dataset.termId = entry.id;
    const enabledCell = document.createElement("td");
    const enabledToggle = document.createElement("input");
    enabledToggle.type = "checkbox";
    enabledToggle.checked = entry.enabled;
    enabledToggle.dataset.action = "toggle";
    enabledToggle.setAttribute("aria-label", `启用 ${entry.source}`);
    enabledCell.append(enabledToggle);
    const sourceCell = document.createElement("td");
    sourceCell.textContent = entry.source;
    const targetCell = document.createElement("td");
    targetCell.textContent = entry.target;
    const noteCell = document.createElement("td");
    noteCell.className = "note";
    noteCell.textContent = entry.note || "—";
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(runtime.createActionButton("编辑", "edit"), runtime.createActionButton("删除", "delete", "danger"));
    actionsCell.append(actions);
    row.append(enabledCell, sourceCell, targetCell, noteCell, actionsCell);
    return row;
  }
  runtime.createTermRow = createTermRow;
  function createActionButton(label, action, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    if (className) {
      button.className = className;
    }
    return button;
  }
  runtime.createActionButton = createActionButton;
  function openEditor(entry = null) {
    runtime.dialogTitle.textContent = entry ? "编辑术语" : "新增术语";
    runtime.termIdInput.value = entry ? entry.id : "";
    runtime.sourceInput.value = entry ? entry.source : "";
    runtime.targetInput.value = entry ? entry.target : "";
    runtime.noteInput.value = entry ? entry.note : "";
    runtime.enabledInput.checked = entry ? entry.enabled : true;
    runtime.termDialog.showModal();
    runtime.sourceInput.focus();
  }
  runtime.openEditor = openEditor;
  async function saveEditor(event) {
    event.preventDefault();
    const id = String(runtime.termIdInput.value || "");
    const source = String(runtime.sourceInput.value || "").trim();
    const target = String(runtime.targetInput.value || "").trim();
    const duplicate = runtime.glossary.entries.find(entry => entry.source === source && entry.id !== id);
    if (duplicate) {
      runtime.setStatus(`原文术语“${source}”已存在`, true);
      runtime.sourceInput.focus();
      return;
    }
    const nextEntry = runtime.glossaryCore.normalizeGlossaryEntry({
      id: id || runtime.createTermId(),
      source,
      target,
      note: runtime.noteInput.value,
      enabled: runtime.enabledInput.checked
    });
    if (!nextEntry) {
      runtime.setStatus("原文术语和固定译文不能为空", true);
      return;
    }
    const nextEntries = id ? runtime.glossary.entries.map(entry => entry.id === id ? nextEntry : entry) : [nextEntry, ...runtime.glossary.entries];
    if (nextEntries.length > runtime.glossaryCore.MAX_ENTRIES) {
      runtime.setStatus(`术语库最多保存 ${runtime.glossaryCore.MAX_ENTRIES} 条`, true);
      return;
    }
    await runtime.persistEntries(nextEntries, id ? "术语已更新" : "术语已新增");
    runtime.termDialog.close();
  }
  runtime.saveEditor = saveEditor;
  async function handleRowClick(event) {
    const button = event.target.closest("button[data-action]");
    const row = event.target.closest("tr[data-term-id]");
    if (!button || !row) {
      return;
    }
    const entry = runtime.glossary.entries.find(item => item.id === row.dataset.termId);
    if (!entry) {
      return;
    }
    if (button.dataset.action === "edit") {
      runtime.openEditor(entry);
      return;
    }
    if (button.dataset.action === "delete" && confirm(`确定删除术语“${entry.source}”吗？`)) {
      await runtime.persistEntries(runtime.glossary.entries.filter(item => item.id !== entry.id), "术语已删除");
    }
  }
  runtime.handleRowClick = handleRowClick;
  async function handleRowToggle(event) {
    if (event.target.dataset.action !== "toggle") {
      return;
    }
    const row = event.target.closest("tr[data-term-id]");
    if (!row) {
      return;
    }
    const nextEntries = runtime.glossary.entries.map(entry => entry.id === row.dataset.termId ? {
      ...entry,
      enabled: event.target.checked
    } : entry);
    await runtime.persistEntries(nextEntries, event.target.checked ? "术语已启用" : "术语已停用");
  }
  runtime.handleRowToggle = handleRowToggle;
  async function importGlossaryFile() {
    const file = runtime.fileInput.files && runtime.fileInput.files[0];
    runtime.fileInput.value = "";
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const imported = file.name.toLocaleLowerCase().endsWith(".csv") ? runtime.parseCsvGlossary(text) : runtime.glossaryCore.normalizeGlossary(JSON.parse(text)).entries;
      if (imported.length === 0) {
        throw new Error("文件中没有有效术语");
      }
      const merged = new Map(runtime.glossary.entries.map(entry => [entry.source, entry]));
      for (const entry of imported) {
        const existing = merged.get(entry.source);
        merged.set(entry.source, {
          ...entry,
          id: existing ? existing.id : entry.id || runtime.createTermId()
        });
      }
      await runtime.persistEntries(Array.from(merged.values()).slice(0, runtime.glossaryCore.MAX_ENTRIES), `已导入 ${imported.length} 条术语（同名原文已更新）`);
    } catch (error) {
      runtime.setStatus(`导入失败：${runtime.getErrorMessage(error)}`, true);
    }
  }
  runtime.importGlossaryFile = importGlossaryFile;
}
