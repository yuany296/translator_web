export function installGlossaryTermsView(runtime) {
  function matchesActiveLibrary(entry) {
    return !runtime.activeLibraryId || entry.libraryId === runtime.activeLibraryId;
  }
  runtime.matchesActiveLibrary = matchesActiveLibrary;
  function renderGlossary() {
    const query = String(runtime.searchInput.value || "").trim().toLocaleLowerCase();
    const scoped = runtime.glossary.entries.filter(matchesActiveLibrary);
    const filtered = scoped.filter(entry => {
      if (!query) {
        return true;
      }
      return [entry.source, entry.target, entry.note, entry.scopeLabel, entry.scopeKey,
        runtime.glossaryCore.getLibraryName(runtime.glossary, entry.libraryId)]
        .some(value => String(value || "").toLocaleLowerCase().includes(query));
    });
    const enabledCount = scoped.filter(entry => entry.enabled).length;
    const libraryName = runtime.glossaryCore.getLibraryName(runtime.glossary, runtime.activeLibraryId);
    const scopeLabel = runtime.activeLibraryId ? `「${libraryName}」共 ${scoped.length} 条` : `共 ${runtime.glossary.entries.length} 条`;
    runtime.countText.textContent = query
      ? `${scopeLabel}，匹配 ${filtered.length} 条，启用 ${enabledCount} 条`
      : `${scopeLabel}，启用 ${enabledCount} 条`;
    runtime.termRows.replaceChildren(...filtered.map(runtime.createTermRow));
    runtime.emptyState.textContent = scoped.length === 0
      ? (runtime.activeLibraryId ? "这个术语库还没有术语，点击“新增术语”开始建立词库。" : "暂无术语，点击“新增术语”开始建立词库。")
      : "没有匹配当前搜索条件的术语。";
    runtime.emptyState.classList.toggle("hidden", filtered.length !== 0);
  }
  runtime.renderGlossary = renderGlossary;
  function createTermRow(entry) {
    const row = document.createElement("tr");
    row.dataset.termId = entry.id;
    row.dataset.libraryId = entry.libraryId;
    // 复选框多选单元格（批量操作），由 glossary-batch-actions 模块提供。
    if (runtime.createTermSelectCell) {
      row.append(runtime.createTermSelectCell(entry));
    }
    const enabledCell = document.createElement("td");
    const enabledToggle = document.createElement("input");
    enabledToggle.type = "checkbox";
    enabledToggle.checked = entry.enabled;
    enabledToggle.dataset.action = "toggle";
    enabledToggle.setAttribute("aria-label", `启用 ${entry.source}`);
    enabledCell.append(enabledToggle);
    const libraryCell = document.createElement("td");
    const library = runtime.glossaryCore.getLibrary(runtime.glossary, entry.libraryId);
    libraryCell.textContent = library ? library.name : entry.libraryId;
    if (library && library.enabled === false) {
      libraryCell.classList.add("muted");
      libraryCell.textContent = `${libraryCell.textContent}（已停用）`;
    }
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
    row.append(enabledCell, libraryCell, scopeCell, sourceCell, targetCell, noteCell, actionsCell);
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
  function fillLibraryOptions(select, selectedId) {
    const target = selectedId || runtime.glossaryCore.DEFAULT_LIBRARY_ID;
    select.replaceChildren(...runtime.glossary.libraries.map(library => {
      const option = document.createElement("option");
      option.value = library.id;
      option.textContent = library.enabled === false ? `${library.name}（已停用）` : library.name;
      option.selected = library.id === target;
      return option;
    }));
    select.value = runtime.glossary.libraries.some(library => library.id === target)
      ? target : runtime.glossaryCore.DEFAULT_LIBRARY_ID;
  }
  runtime.fillLibraryOptions = fillLibraryOptions;
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
    fillLibraryOptions(runtime.libraryInput, entry ? entry.libraryId : runtime.activeLibraryId);
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
    const libraryId = runtime.libraryInput.value || runtime.glossaryCore.DEFAULT_LIBRARY_ID;
    const stored = await runtime.storageGet(["mt_translation_config_v1"]);
    const translation = stored.mt_translation_config_v1 || {};
    const sourceLanguage = entryLanguage(id, "sourceLanguage")
      || (translation.sourceLanguage === "auto" ? "ko" : translation.sourceLanguage) || "ko";
    const targetLanguage = entryLanguage(id, "targetLanguage") || translation.targetLanguage || "zh-CN";
    const duplicate = runtime.glossary.entries.find(entry =>
      entry.source === source && entry.sourceLanguage === sourceLanguage
      && entry.targetLanguage === targetLanguage && entry.scope === scope
      && entry.scopeKey === scopeKey && entry.libraryId === libraryId && entry.id !== id);
    if (duplicate) {
      runtime.setStatus(`“${runtime.glossaryCore.getLibraryName(runtime.glossary, libraryId)}”里已有原文术语“${source}”`, true);
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
      scopeLabel: runtime.scopeLabelInput.value,
      libraryId
    }, 0, runtime.glossary.libraries);
    if (!nextEntry) {
      runtime.setStatus("原文术语和固定译文不能为空", true);
      return;
    }
    const nextEntries = id ? runtime.glossary.entries.map(entry => entry.id === id ? nextEntry : entry) : [nextEntry, ...runtime.glossary.entries];
    const countInLibrary = nextEntries.filter(entry => entry.libraryId === libraryId).length;
    if (countInLibrary > runtime.glossaryCore.MAX_ENTRIES_PER_LIBRARY) {
      runtime.setStatus(`术语库「${runtime.glossaryCore.getLibraryName(runtime.glossary, libraryId)}」最多保存 ${runtime.glossaryCore.MAX_ENTRIES_PER_LIBRARY} 条`, true);
      return;
    }
    if (nextEntries.length > runtime.glossaryCore.MAX_TOTAL_ENTRIES) {
      runtime.setStatus(`全部术语库合计最多保存 ${runtime.glossaryCore.MAX_TOTAL_ENTRIES} 条`, true);
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
    let importSummary = "";
    // 导入前选定的目标库（见 glossary-import-picker.js）：显式指定时优先级最高，
    // 覆盖文件内自带的库名归属；「按文件内归属」则维持原行为。
    const importTarget = runtime.consumePendingImportTarget?.() || null;
    try {
      if (ext === "db" || ext === "sqlite" || ext === "sqlite3") {
        if (importTarget && importTarget.mode === "library") {
          runtime.setStatus("数据库(.db)导入按文件自带的库归属执行，无法指定目标术语库", true);
        }
        await runtime.importGlossaryDbFile({ target: { files: [file] } });
      } else {
        const text = await file.text();
        const parsed = ext === "csv" ? null : runtime.glossaryCore.normalizeGlossary(JSON.parse(text));
        const imported = ext === "csv"
          ? runtime.parseCsvGlossary(text)
          : parsed.entries;
        if (!imported.length) throw new Error("文件中没有有效术语");
        // JSON 里带的术语库定义先并入现有库，导入的条目才能保住归属。
        // mergeImportedLibraries 是 async：漏掉 await 会拿到 Promise，后面 .map 直接抛错，整个导入功能失效。
        const libraries = await (parsed
          ? runtime.mergeImportedLibraries(parsed.libraries)
          : runtime.mergeImportedLibraries([]));
        const libraryIdByName = new Map(libraries.map(library => [library.name.toLocaleLowerCase(), library.id]));
        // JSON 用自带的 libraryId；CSV 只带库名。凡是有库名的条目一律按名归属（未建则自动建库），
        // 不能再用 "libraryId 是否为空" 判断——归一化总会把 libraryId 填成默认库，判断会永远跳过。
        // JSON 用自带的 libraryId；CSV 只带库名。凡是有库名的条目一律按名归属（未建则自动建库），
        // 不能再用 "libraryId 是否为空" 判断——归一化总会把 libraryId 填成默认库，判断会永远跳过。
        // 用户在导入前显式指定了目标库时则跳过按名归位：目标库优先级最高，
        // 也不为文件里的库名额外建库（一书一库时避免多出无关的库）。
        if (importTarget && importTarget.mode === "library" && importTarget.libraryId) {
          for (const entry of imported) entry.libraryId = importTarget.libraryId;
        } else {
          for (const entry of imported) {
            const name = String(entry.library || "").trim();
            if (!name) continue;
            entry.libraryId = libraryIdByName.get(name.toLocaleLowerCase())
              || (await runtime.ensureLibraryByName(name)).id;
          }
        }
        // Upsert: merge by 库 + 范围 + 原文，保留已有 ID
        const mergeKey = entry => `${entry.libraryId}\u0000${entry.scope}\u0000${entry.scopeKey}\u0000${entry.source}`;
        const merged = new Map(runtime.glossary.entries.map(e => [mergeKey(e), e]));
        for (const entry of imported) {
          const key = mergeKey(entry);
          const prev = merged.get(key);
          merged.set(key, { ...entry, id: prev ? prev.id : (entry.id || runtime.createTermId()) });
        }
        const result = Array.from(merged.values()).slice(0, runtime.glossaryCore.MAX_TOTAL_ENTRIES);
        importSummary = `已导入 ${imported.length} 条，合并后共 ${result.length} 条`;
        await runtime.persistEntries(result, importSummary);
      }
      // 服务器在线时用服务端权威数据刷新；离线/失败时保留导入环节自己写好的状态，
      // 不能让服务端的"加载失败"覆盖掉"已导入 N 条"或"数据库导入失败"这类真实结果。
      const statusBeforeReload = runtime.statusText.textContent;
      const statusBeforeReloadError = runtime.statusText.dataset.error === "true";
      const reload = await runtime.loadGlossaryFromServer();
      if (!reload || reload.ok !== true) {
        runtime.setStatus(statusBeforeReload, statusBeforeReloadError);
      }
    } catch (error) {
      runtime.setStatus(`导入失败：${runtime.getErrorMessage(error)}`, true);
    } finally {
      runtime.importBtn.disabled = false;
      runtime.fileInput.value = "";
    }
  }
  runtime.importGlossaryFile = importGlossaryFile;
  const countText = document.getElementById("countText");
  runtime.countText = countText;
  const termRows = document.getElementById("termRows");
  runtime.termRows = termRows;
  const emptyState = document.getElementById("emptyState");
  runtime.emptyState = emptyState;
  const termDialog = document.getElementById("termDialog");
  runtime.termDialog = termDialog;
  const termForm = document.getElementById("termForm");
  runtime.termForm = termForm;
  const dialogTitle = document.getElementById("dialogTitle");
  runtime.dialogTitle = dialogTitle;
  const termIdInput = document.getElementById("termIdInput");
  runtime.termIdInput = termIdInput;
  const scopeInput = document.getElementById("scopeInput");
  runtime.scopeInput = scopeInput;
  const scopeKeyInput = document.getElementById("scopeKeyInput");
  runtime.scopeKeyInput = scopeKeyInput;
  const scopeLabelInput = document.getElementById("scopeLabelInput");
  runtime.scopeLabelInput = scopeLabelInput;
  const seriesScopeFields = document.getElementById("seriesScopeFields");
  runtime.seriesScopeFields = seriesScopeFields;
  const libraryInput = document.getElementById("libraryInput");
  runtime.libraryInput = libraryInput;
  const sourceInput = document.getElementById("sourceInput");
  runtime.sourceInput = sourceInput;
  const targetInput = document.getElementById("targetInput");
  runtime.targetInput = targetInput;
  const noteInput = document.getElementById("noteInput");
  runtime.noteInput = noteInput;
  const enabledInput = document.getElementById("enabledInput");
  runtime.enabledInput = enabledInput;
  const searchInput = document.getElementById("searchInput");
  runtime.searchInput = searchInput;
  const importBtn = document.getElementById("importBtn");
  runtime.importBtn = importBtn;
  const fileInput = document.getElementById("fileInput");
  runtime.fileInput = fileInput;
  let activeLibraryId = "";
  runtime.activeLibraryId = activeLibraryId;
}
