export function installGlossaryTermsView(runtime) {
  function matchesActiveLibrary(entry) {
    return !runtime.activeLibraryId || entry.libraryId === runtime.activeLibraryId;
  }
  runtime.matchesActiveLibrary = matchesActiveLibrary;
  function renderGlossary() {
    // 搜索词按库各记各的（见 glossary-search）：这里只读当前库那一份，绝不直接读输入框。
    const query = String(runtime.currentSearchQuery() || "").trim().toLocaleLowerCase();
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
    const scopeLabel = runtime.activeLibraryId
      ? `「${libraryName}」共 ${scoped.length} 条`
      : `「全部术语」共 ${scoped.length} 条`;
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
  /** 表格里可以直接改的三格之一：原文 / 固定译文 / 备注（回车或离开格子即存，Esc 还原）。 */
  function createCellInput(entry, field) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cell-input";
    input.value = field === "note" ? (entry.note || "") : entry[field];
    input.dataset.action = "edit-cell";
    input.dataset.field = field;
    input.dataset.termId = entry.id;
    input.maxLength = field === "note" ? 240 : 120;
    input.setAttribute("aria-label", `${field === "source" ? "原文术语" : field === "target" ? "固定译文" : "备注"} ${entry.source}`);
    return input;
  }
  runtime.createCellInput = createCellInput;
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
    libraryCell.className = "col-library";
    const library = runtime.glossaryCore.getLibrary(runtime.glossary, entry.libraryId);
    libraryCell.textContent = library ? library.name : entry.libraryId;
    if (library && library.enabled === false) {
      libraryCell.classList.add("muted");
      libraryCell.textContent = `${libraryCell.textContent}（已停用）`;
    }
    const sourceCell = document.createElement("td");
    sourceCell.className = "col-source";
    sourceCell.append(createCellInput(entry, "source"));
    // 「术语范围」已从界面移除，但旧数据里按本书生效的条目仍然生效，用角标交代清楚。
    if (entry.scope === "work") {
      const badge = document.createElement("span");
      badge.className = "badge scope-badge";
      badge.textContent = "本书";
      badge.title = `本书范围：${entry.scopeLabel || entry.scopeKey}（只在这一本书里生效）`;
      sourceCell.append(badge);
    }
    const targetCell = document.createElement("td");
    targetCell.append(createCellInput(entry, "target"));
    const noteCell = document.createElement("td");
    noteCell.className = "note";
    noteCell.append(createCellInput(entry, "note"));
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    // 编辑不再走弹窗、也不再需要按钮：原文/译文/备注三格直接改，启用是行首的开关。
    actions.append(runtime.createActionButton("删除", "delete", "danger"));
    actionsCell.append(actions);
    row.append(enabledCell, libraryCell, sourceCell, targetCell, noteCell, actionsCell);
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
  /**
   * 「新增术语」弹窗只收三样：原文、译文、备注（用户要求）。
   * 进哪个库由「你现在在哪个库的页面」决定；启用与否在表格里用开关控制；
   * 库里已有的术语不用弹窗，直接在表格三格里改。
   */
  function openEditor() {
    const libraryId = runtime.glossaryCore.normalizeLibraryId(runtime.activeLibraryId);
    if (!libraryId) {
      runtime.setStatus("先在总览页点进一个术语库，再新增术语", true);
      return;
    }
    runtime.dialogTitle.textContent = "新增术语";
    runtime.dialogHint.textContent = `会加入「${runtime.glossaryCore.getLibraryName(runtime.glossary, libraryId)}」。已有的术语直接在表格里点原文、译文、备注就能改。`;
    runtime.sourceInput.value = "";
    runtime.targetInput.value = "";
    runtime.noteInput.value = "";
    runtime.termDialog.showModal();
    runtime.sourceInput.focus();
  }
  runtime.openEditor = openEditor;
  async function saveEditor(event) {
    event.preventDefault();
    const source = String(runtime.sourceInput.value || "").trim();
    const target = String(runtime.targetInput.value || "").trim();
    const note = String(runtime.noteInput.value || "").trim();
    const libraryId = runtime.glossaryCore.normalizeLibraryId(runtime.activeLibraryId);
    if (!libraryId) {
      runtime.setStatus("先在总览页点进一个术语库，再新增术语", true);
      return;
    }
    const libraryName = runtime.glossaryCore.getLibraryName(runtime.glossary, libraryId);
    if (!source || !target) {
      runtime.setStatus("原文术语和固定译文不能为空", true);
      return;
    }
    const stored = await runtime.storageGet(["mt_translation_config_v1"]);
    const translation = stored.mt_translation_config_v1 || {};
    const sourceLanguage = (translation.sourceLanguage === "auto" ? "ko" : translation.sourceLanguage) || "ko";
    const targetLanguage = translation.targetLanguage || "zh-CN";
    const duplicate = runtime.glossary.entries.find(entry =>
      entry.libraryId === libraryId && entry.source === source
      && entry.sourceLanguage === sourceLanguage && entry.targetLanguage === targetLanguage
      && entry.scope === "global" && !entry.scopeKey);
    if (duplicate) {
      runtime.setStatus(`「${libraryName}」里已有原文术语“${source}”`, true);
      runtime.sourceInput.focus();
      return;
    }
    // 新增的术语一律全局生效（范围已从界面去掉），启用。
    const nextEntry = runtime.glossaryCore.normalizeGlossaryEntry({
      id: runtime.createTermId(),
      source,
      target,
      sourceLanguage,
      targetLanguage,
      note,
      enabled: true,
      scope: "global",
      scopeKey: "",
      scopeLabel: "",
      libraryId
    }, 0, runtime.glossary.libraries);
    if (!nextEntry) {
      runtime.setStatus("原文术语和固定译文不能为空", true);
      return;
    }
    const nextEntries = [nextEntry, ...runtime.glossary.entries];
    const countInLibrary = nextEntries.filter(entry => entry.libraryId === libraryId).length;
    if (countInLibrary > runtime.glossaryCore.MAX_ENTRIES_PER_LIBRARY) {
      runtime.setStatus(`术语库「${libraryName}」最多保存 ${runtime.glossaryCore.MAX_ENTRIES_PER_LIBRARY} 条`, true);
      return;
    }
    if (nextEntries.length > runtime.glossaryCore.MAX_TOTAL_ENTRIES) {
      runtime.setStatus(`全部术语库合计最多保存 ${runtime.glossaryCore.MAX_TOTAL_ENTRIES} 条`, true);
      return;
    }
    await runtime.persistEntries(nextEntries, `已新增“${source}”`);
    runtime.termDialog.close();
  }
  runtime.saveEditor = saveEditor;
  /** 表格内改一格：回车 / 离开格子即存，Esc 还原（不写库）。 */
  async function saveCellEdit(input) {
    const row = input.closest("tr[data-term-id]");
    const entry = runtime.glossary.entries.find(item => item.id === row?.dataset.termId);
    if (!entry) {
      return;
    }
    const field = input.dataset.field;
    const value = String(input.value || "").trim();
    const current = field === "note" ? (entry.note || "") : entry[field];
    if (value === current) {
      return;
    }
    const nextEntry = { ...entry, [field]: value };
    const revert = () => {
      input.value = current;
    };
    if (!nextEntry.source || !nextEntry.target) {
      runtime.setStatus("原文术语和固定译文不能为空", true);
      revert();
      return;
    }
    const duplicate = runtime.glossary.entries.find(item => item.id !== entry.id
      && item.libraryId === nextEntry.libraryId && item.scope === nextEntry.scope
      && item.scopeKey === nextEntry.scopeKey && item.source === nextEntry.source
      && item.sourceLanguage === nextEntry.sourceLanguage && item.targetLanguage === nextEntry.targetLanguage);
    if (duplicate) {
      runtime.setStatus(`「${runtime.glossaryCore.getLibraryName(runtime.glossary, entry.libraryId)}」里已有原文术语“${nextEntry.source}”`, true);
      revert();
      return;
    }
    await runtime.persistEntries(
      runtime.glossary.entries.map(item => item.id === entry.id ? nextEntry : item),
      `已更新“${nextEntry.source}”`
    );
  }
  runtime.saveCellEdit = saveCellEdit;
  function handleCellChange(event) {
    if (event.target?.dataset?.action !== "edit-cell") {
      return;
    }
    void saveCellEdit(event.target);
  }
  runtime.handleCellChange = handleCellChange;
  function handleCellKeydown(event) {
    const input = event.target;
    if (input?.dataset?.action !== "edit-cell") {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // 浏览器里 blur 会触发 change（统一走保存）；测试里的假 DOM 没有 blur，直接存。
      if (typeof input.blur === "function") {
        input.blur();
      } else {
        void saveCellEdit(input);
      }
      return;
    }
    if (event.key === "Escape") {
      const row = input.closest("tr[data-term-id]");
      const entry = runtime.glossary.entries.find(item => item.id === row?.dataset.termId);
      if (entry) {
        input.value = input.dataset.field === "note" ? (entry.note || "") : entry[input.dataset.field];
      }
    }
  }
  runtime.handleCellKeydown = handleCellKeydown;
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
  /** 导入结果写到「看得见」的那条状态行：从总览页导入时用户停在列表页，详情页那条是看不见的。 */
  function reportImportStatus(message, isError) {
    runtime.setStatus(message, isError);
    if (runtime.activeView !== "detail") runtime.setLibraryStatus(message, isError);
  }
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
        const kind = ext === "csv" ? "csv" : "json";
        // 去向零弹窗：左侧选中了库就进那个库；「显示全部」时 CSV 按文件名建库、JSON 按自带归属。
        const target = runtime.resolveImportTarget({ fileName: file.name, kind });
        const text = await file.text();
        const parsed = kind === "json" ? runtime.glossaryCore.normalizeGlossary(JSON.parse(text)) : null;
        const imported = kind === "csv" ? runtime.parseCsvGlossary(text) : parsed.entries;
        if (!imported.length) throw new Error("文件中没有有效术语");
        let targetName = "";
        if (target.mode === "attribution") {
          // JSON 是本扩展的备份格式，自带库结构：先把库定义并入，再按库名把条目归并到本机的库里。
          // mergeImportedLibraries 是 async：漏掉 await 会拿到 Promise，整个导入功能失效。
          const libraries = await runtime.mergeImportedLibraries(parsed.libraries);
          runtime.realignImportedEntries(imported, parsed.libraries, libraries);
        } else {
          const libraryId = target.mode === "library"
            ? target.libraryId
            : (await runtime.ensureLibraryForImport(target.name)).id;
          for (const entry of imported) {
            entry.libraryId = libraryId;
          }
          targetName = runtime.glossaryCore.getLibraryName(runtime.glossary, libraryId);
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
        const summary = targetName
          ? `已导入 ${imported.length} 条到「${targetName}」，合并后共 ${result.length} 条`
          : `已导入 ${imported.length} 条（按文件自带的术语库归属），合并后共 ${result.length} 条`;
        await runtime.persistEntries(result, summary);
        reportImportStatus(summary, false);
      }
      // 服务器在线时用服务端权威数据刷新；离线/失败时保留导入环节自己写好的状态，
      // 不能让服务端的"加载失败"覆盖掉"已导入 N 条"或"数据库导入失败"这类真实结果。
      const statusBeforeReload = runtime.statusText.textContent;
      const statusBeforeReloadError = runtime.statusText.dataset.error === "true";
      const reload = await runtime.loadGlossaryFromServer();
      if (!reload || reload.ok !== true) {
        reportImportStatus(statusBeforeReload, statusBeforeReloadError);
      }
    } catch (error) {
      reportImportStatus(`导入失败：${runtime.getErrorMessage(error)}`, true);
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
  const dialogHint = document.getElementById("dialogHint");
  runtime.dialogHint = dialogHint;
  const sourceInput = document.getElementById("sourceInput");
  runtime.sourceInput = sourceInput;
  const targetInput = document.getElementById("targetInput");
  runtime.targetInput = targetInput;
  const noteInput = document.getElementById("noteInput");
  runtime.noteInput = noteInput;
  const searchInput = document.getElementById("searchInput");
  runtime.searchInput = searchInput;
  const importBtn = document.getElementById("importBtn");
  runtime.importBtn = importBtn;
  const fileInput = document.getElementById("fileInput");
  runtime.fileInput = fileInput;
  let activeLibraryId = "";
  runtime.activeLibraryId = activeLibraryId;
}
