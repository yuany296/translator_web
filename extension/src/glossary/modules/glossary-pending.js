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
  async function loadGlossary(source = "auto") {
    // "auto": try server, fall back to chrome.storage
    // "server": try server only
    // "storage": chrome.storage only
    if (source !== "storage") {
      const result = await runtime.loadGlossaryFromServer();
      if (result.ok) return;
    }
    if (source === "server") return;
    try {
      const stored = await runtime.storageGet([
        runtime.glossaryCore.STORAGE_KEY,
        runtime.glossaryCore.LEGACY_STORAGE_KEY
      ]);
      const source = stored[runtime.glossaryCore.STORAGE_KEY] ??
        stored[runtime.glossaryCore.LEGACY_STORAGE_KEY];
      runtime.glossary = runtime.glossaryCore.normalizeGlossary(source);
      if (stored[runtime.glossaryCore.STORAGE_KEY] === undefined && source !== undefined) {
        await runtime.storageSet({ [runtime.glossaryCore.STORAGE_KEY]: runtime.glossary });
      }
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
      return [entry.source, entry.target, entry.note, entry.scopeLabel, entry.scopeKey]
        .some(value => String(value || "").toLocaleLowerCase().includes(query));
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
    const scopeCell = document.createElement("td");
    scopeCell.textContent = entry.scope === "work"
      ? `本书 · ${entry.scopeLabel || entry.scopeKey}` : "全局";
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
    row.append(enabledCell, scopeCell, sourceCell, targetCell, noteCell, actionsCell);
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
    runtime.scopeInput.value = entry?.scope === "work" ? "series" : "global";
    runtime.scopeKeyInput.value = entry?.scopeKey || "";
    runtime.scopeLabelInput.value = entry?.scopeLabel || "";
    runtime.sourceInput.value = entry ? entry.source : "";
    runtime.targetInput.value = entry ? entry.target : "";
    runtime.noteInput.value = entry ? entry.note : "";
    runtime.enabledInput.checked = entry ? entry.enabled : true;
    runtime.updateScopeFields();
    runtime.termDialog.showModal();
    runtime.sourceInput.focus();
  }
  runtime.openEditor = openEditor;
  function updateScopeFields() {
    const series = runtime.scopeInput.value === "series";
    runtime.seriesScopeFields.classList.toggle("hidden", !series);
    runtime.scopeKeyInput.required = series;
  }
  runtime.updateScopeFields = updateScopeFields;
  async function saveEditor(event) {
    event.preventDefault();
    const id = String(runtime.termIdInput.value || "");
    const source = String(runtime.sourceInput.value || "").trim();
    const target = String(runtime.targetInput.value || "").trim();
    const scope = runtime.scopeInput.value === "series" ? "work" : "global";
    const scopeKey = scope === "work" ? runtime.scopeKeyInput.value.trim() : "";
    const stored = await runtime.storageGet(["mt_translation_config_v1"]);
    const translation = stored.mt_translation_config_v1 || {};
    const sourceLanguage = entryLanguage(id, "sourceLanguage")
      || (translation.sourceLanguage === "auto" ? "ko" : translation.sourceLanguage) || "ko";
    const targetLanguage = entryLanguage(id, "targetLanguage") || translation.targetLanguage || "zh-CN";
    const duplicate = runtime.glossary.entries.find(entry =>
      entry.source === source && entry.sourceLanguage === sourceLanguage
      && entry.targetLanguage === targetLanguage && entry.scope === scope
      && entry.scopeKey === scopeKey && entry.id !== id);
    if (duplicate) {
      runtime.setStatus(`原文术语“${source}”已存在`, true);
      runtime.sourceInput.focus();
      return;
    }
    const nextEntry = runtime.glossaryCore.normalizeGlossaryEntry({
      id: id || runtime.createTermId(),
      source,
      target,
      sourceLanguage,
      targetLanguage,
      note: runtime.noteInput.value,
      enabled: runtime.enabledInput.checked,
      scope,
      scopeKey,
      scopeLabel: runtime.scopeLabelInput.value
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
  function entryLanguage(id, key) {
    return runtime.glossary.entries.find(entry => entry.id === id)?.[key] || "";
  }
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
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    // Validate extension
    if (!["json", "csv", "db", "sqlite", "sqlite3"].includes(ext)) {
      runtime.fileInput.value = "";
      runtime.setStatus("不支持的文件格式。请选择 JSON、CSV 或 SQLite 数据库文件。", true);
      return;
    }
    runtime.importBtn.disabled = true;
    try {
      if (ext === "db" || ext === "sqlite" || ext === "sqlite3") {
        await runtime.importGlossaryDbFile({ target: { files: [file] } });
      } else {
        const text = await file.text();
        const imported = ext === "csv"
          ? runtime.parseCsvGlossary(text)
          : runtime.glossaryCore.normalizeGlossary(JSON.parse(text)).entries;
        if (!imported.length) throw new Error("文件中没有有效术语");
        // Upsert: merge by source, keeping existing IDs
        const mergeKey = entry => `${entry.scope}\u0000${entry.scopeKey}\u0000${entry.source}`;
        const merged = new Map(runtime.glossary.entries.map(e => [mergeKey(e), e]));
        for (const entry of imported) {
          const key = mergeKey(entry);
          const prev = merged.get(key);
          merged.set(key, { ...entry, id: prev ? prev.id : (entry.id || runtime.createTermId()) });
        }
        const result = Array.from(merged.values()).slice(0, runtime.glossaryCore.MAX_ENTRIES);
        await runtime.persistEntries(result, `已导入 ${imported.length} 条，合并后共 ${result.length} 条`);
      }
      // Reload from server to get canonical data
      await runtime.loadGlossary("server");
    } catch (error) {
      runtime.setStatus(`导入失败：${runtime.getErrorMessage(error)}`, true);
    } finally {
      runtime.importBtn.disabled = false;
      runtime.fileInput.value = "";
    }
  }
  runtime.importGlossaryFile = importGlossaryFile;
}
