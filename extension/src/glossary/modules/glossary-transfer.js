export function installGlossaryTransfer(runtime) {
  // CSV 表头中英文都认：本扩展导出用 source/target，沉浸式翻译与中文表格导出的是 原文/译文/备注。
  // 认不出表头就当没有表头，按「前两列 = 原文/译文、第三列 = 备注」读，
  // 否则中文表头那一行会被当成一条术语导进去。
  const CSV_SOURCE_HEADERS = ["source", "原文"];
  const CSV_TARGET_HEADERS = ["target", "tgt", "译文"];
  const CSV_NOTE_HEADERS = ["note", "备注"];
  function parseCsvGlossary(text) {
    const rows = runtime.parseCsvRows(String(text || "").replace(/^\uFEFF/, ""));
    if (rows.length === 0) {
      return [];
    }
    const header = rows[0].map(cell => cell.trim().toLocaleLowerCase());
    const findColumn = aliases => header.findIndex(cell => aliases.includes(cell));
    const hasHeader = [...CSV_SOURCE_HEADERS, ...CSV_TARGET_HEADERS, ...CSV_NOTE_HEADERS]
      .some(name => header.includes(name));
    const pick = (aliases, fallback) => (hasHeader ? findColumn(aliases) : fallback);
    const sourceIndex = pick(CSV_SOURCE_HEADERS, 0);
    const targetIndex = pick(CSV_TARGET_HEADERS, 1);
    const noteIndex = pick(CSV_NOTE_HEADERS, 2);
    const sourceLanguageIndex = hasHeader ? findColumn(["source_language", "src_lng"]) : -1;
    const targetLanguageIndex = hasHeader ? findColumn(["target_language", "tgt_lng"]) : -1;
    const enabledIndex = hasHeader ? findColumn(["enabled"]) : 3;
    const scopeIndex = hasHeader ? findColumn(["scope"]) : -1;
    const scopeKeyIndex = hasHeader ? findColumn(["scope_key"]) : -1;
    const scopeLabelIndex = hasHeader ? findColumn(["scope_label"]) : -1;
    const rawEntries = (hasHeader ? rows.slice(1) : rows).map(row => ({
      id: runtime.createTermId(),
      source: row[sourceIndex],
      target: row[targetIndex],
      sourceLanguage: sourceLanguageIndex >= 0 ? row[sourceLanguageIndex] : "ko",
      targetLanguage: targetLanguageIndex >= 0 ? row[targetLanguageIndex] : "zh-CN",
      note: noteIndex >= 0 ? row[noteIndex] : "",
      enabled: enabledIndex < 0 || !/^(false|0|no|否)$/i.test(String(row[enabledIndex] || "").trim()),
      scope: scopeIndex >= 0 ? row[scopeIndex] : "global",
      scopeKey: scopeKeyIndex >= 0 ? row[scopeKeyIndex] : "",
      scopeLabel: scopeLabelIndex >= 0 ? row[scopeLabelIndex] : ""
    }));
    // CSV 的 library（库名）列已废弃：导入去向由「左侧选中的库 / 文件名」决定，这里不再读取。
    return runtime.glossaryCore.normalizeGlossary(rawEntries).entries;
  }
  runtime.parseCsvGlossary = parseCsvGlossary;
  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
        else if (char === '"') { quoted = false; }
        else { cell += char; }
      } else if (char === '"') { quoted = true; }
      else if (char === ",") {
        row.push(cell);
        cell = "";
      } else if (char === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (char !== "\r") {
        cell += char;
      }
    }
    row.push(cell);
    if (row.some(value => value !== "")) {
      rows.push(row);
    }
    return rows;
  }
  runtime.parseCsvRows = parseCsvRows;
  /** 详情页里导出/清空的范围：选中某个库时只作用于该库，「全部术语」时才是全量。 */
  function activeScope() {
    const id = runtime.glossaryCore.normalizeLibraryId(runtime.activeLibraryId);
    const library = id ? runtime.glossaryCore.getLibrary(runtime.glossary, id) : null;
    return {
      library,
      entries: library
        ? runtime.glossary.entries.filter(entry => entry.libraryId === library.id)
        : runtime.glossary.entries
    };
  }
  runtime.activeScope = activeScope;
  /** 库名可能带 / : * 等文件系统不接受的字符，落到文件名前先换掉。 */
  function safeFilePart(name) {
    return String(name || "").replace(/[\\/:*?"<>|]/gu, "_").trim().slice(0, 40);
  }
  runtime.safeFilePart = safeFilePart;
  /**
   * 「导出…」先开弹窗再选格式：工具栏上少一个按钮，也省得用户点错直接落文件。
   * 弹窗里的说明跟着当前范围（某个库 / 全部术语）走。
   */
  function openExportDialog() {
    const { library, entries } = activeScope();
    const title = document.getElementById("exportDialogTitle");
    if (title) {
      title.textContent = library ? `导出「${library.name}」（${entries.length} 条）` : `导出全部术语（${entries.length} 条）`;
    }
    if (typeof runtime.exportDialog.showModal === "function") {
      runtime.exportDialog.showModal();
    } else {
      runtime.exportDialog.open = true;
    }
  }
  runtime.openExportDialog = openExportDialog;
  function exportGlossaryJson() {
    const { library, entries } = activeScope();
    const payload = library ? { ...runtime.glossary, libraries: [library], entries } : runtime.glossary;
    const suffix = library ? `-${safeFilePart(library.name)}` : "";
    runtime.downloadFile(`manga-glossary${suffix}-${runtime.formatDate()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    runtime.setStatus(library
      ? `已导出「${library.name}」的 ${entries.length} 条术语（含该库定义），可直接导回来`
      : `已导出 ${entries.length} 条术语（含 ${runtime.glossary.libraries.length} 个术语库定义）`, false);
  }
  runtime.exportGlossaryJson = exportGlossaryJson;
  function exportGlossaryCsv() {
    const { library, entries } = activeScope();
    // 导出列只留真正有用的六列：库名/范围相关列都已去掉——
    // 库名导入时不读（去向由「当前选中的库 / 文件名」决定）；范围已从界面移除，
    // 只留 scope 而没有 scope_key 反而会让「本书范围」的老条目在重新导入时变成全局，所以一并去掉。
    const rows = [["source", "target", "source_language", "target_language", "note", "enabled"],
      ...entries.map(entry => [
        entry.source, entry.target, entry.sourceLanguage, entry.targetLanguage,
        entry.note, String(entry.enabled)
      ])];
    const csv = rows.map(row => row.map(runtime.escapeCsvCell).join(",")).join("\r\n");
    const suffix = library ? `-${safeFilePart(library.name)}` : "";
    runtime.downloadFile(`manga-glossary${suffix}-${runtime.formatDate()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
    runtime.setStatus(library
      ? `已导出「${library.name}」的 ${entries.length} 条术语；文件名就是库名，导回来会回到这个库`
      : `已导出 ${entries.length} 条术语；导入时按文件名建库，想按库分开就先导出某个库`, false);
  }
  runtime.exportGlossaryCsv = exportGlossaryCsv;
  async function clearGlossary() {
    const scope = activeScope();
    if (scope.entries.length === 0) return;
    if (scope.library) {
      // 单库清空：只删这个库的条目，库定义（名称、开关、绑定网址）保留。
      if (!confirm(`确定清空术语库「${scope.library.name}」里的 ${scope.entries.length} 条术语吗？术语库本身会保留，服务端对应条目也会删除。`)) return;
      runtime.clearBtn.disabled = true;
      try {
        await runtime.persistEntries(
          runtime.glossary.entries.filter(entry => entry.libraryId !== scope.library.id),
          `已清空「${scope.library.name}」的 ${scope.entries.length} 条术语`
        );
      } finally {
        runtime.clearBtn.disabled = false;
      }
      return;
    }
    if (!confirm(`确定清空全部 ${scope.entries.length} 条术语吗？术语库定义（名称与绑定网址）会保留，此操作同时清空服务端数据库。`)) return;
    runtime.clearBtn.disabled = true;
    try {
      const baseUrl = await runtime.resolveServerBaseUrl();
      const resp = await fetch(`${baseUrl}/glossary/clear`, {
        method: "POST", headers: runtime.getServiceHeaders()
      });
      if (!resp.ok) throw new Error(`服务器错误 ${resp.status}`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "清空失败");
      runtime.glossary.entries = [];
      runtime.glossary.revision = 0;
      await runtime.storageSet({ [runtime.glossaryCore.STORAGE_KEY]: runtime.glossary });
      runtime.renderGlossary();
      runtime.setStatus(`已清空 ${data.deleted || 0} 条术语（${runtime.glossary.libraries.length} 个术语库保留）`, false);
    } catch (error) {
      runtime.setStatus(`清空失败：${runtime.getErrorMessage(error)}`, true);
    } finally {
      runtime.clearBtn.disabled = false;
    }
  }
  runtime.clearGlossary = clearGlossary;
  async function importDbFileToServer(file) {
    try {
      const baseUrl = await runtime.resolveServerBaseUrl();
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`${baseUrl}/glossary/import-db`, {
        method: "POST", headers: runtime.getServiceHeaders(), body: form
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
      return data;
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.importDbFileToServer = importDbFileToServer;
  async function importGlossaryDbFile(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    if (!confirm(`将导入数据库文件 "${file.name}" (${(file.size / 1024).toFixed(1)} KB)。\n\n导入前会自动备份当前数据库，不会直接替换。\n确认继续？`)) {
      event.target.value = "";
      return;
    }
    try {
      runtime.setStatus("正在导入数据库…", false);
      const result = await runtime.importDbFileToServer(file);
      if (result.ok === false) throw new Error(result.error || result.detail || "导入失败");
      const msg = `导入完成：读取 ${result.read || 0} 条，新增 ${result.added || 0} 条，更新 ${result.updated || 0} 条，跳过 ${result.skipped || 0} 条`;
      runtime.setStatus(msg + (result.backup ? ` (备份: ${result.backup})` : ""), false);
      await runtime.loadGlossary("server");
    } catch (error) {
      runtime.setStatus(`数据库导入失败：${runtime.getErrorMessage(error)}`, true);
    } finally {
      event.target.value = "";
    }
  }
  runtime.importGlossaryDbFile = importGlossaryDbFile;
  function downloadFile(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], {
      type
    }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  runtime.downloadFile = downloadFile;
  function escapeCsvCell(value) {
    const text = String(value || "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  runtime.escapeCsvCell = escapeCsvCell;
  function createTermId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `term-${globalThis.crypto.randomUUID()}`;
    }
    return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  runtime.createTermId = createTermId;
  function formatDate() {
    const date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }
  runtime.formatDate = formatDate;
}
