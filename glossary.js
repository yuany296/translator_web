"use strict";

const glossaryCore = globalThis.MangaGlossary;
const addBtn = document.getElementById("addBtn");
const searchInput = document.getElementById("searchInput");
const importBtn = document.getElementById("importBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const clearBtn = document.getElementById("clearBtn");
const fileInput = document.getElementById("fileInput");
const countText = document.getElementById("countText");
const statusText = document.getElementById("statusText");
const termRows = document.getElementById("termRows");
const emptyState = document.getElementById("emptyState");
const termDialog = document.getElementById("termDialog");
const termForm = document.getElementById("termForm");
const dialogTitle = document.getElementById("dialogTitle");
const termIdInput = document.getElementById("termIdInput");
const sourceInput = document.getElementById("sourceInput");
const targetInput = document.getElementById("targetInput");
const noteInput = document.getElementById("noteInput");
const enabledInput = document.getElementById("enabledInput");
const cancelBtn = document.getElementById("cancelBtn");

let glossary = glossaryCore.normalizeGlossary(null);

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await loadGlossary();
});

function bindEvents() {
  addBtn.addEventListener("click", () => openEditor());
  searchInput.addEventListener("input", renderGlossary);
  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", importGlossaryFile);
  exportJsonBtn.addEventListener("click", exportGlossaryJson);
  exportCsvBtn.addEventListener("click", exportGlossaryCsv);
  clearBtn.addEventListener("click", clearGlossary);
  termForm.addEventListener("submit", saveEditor);
  cancelBtn.addEventListener("click", () => termDialog.close());
  termRows.addEventListener("click", handleRowClick);
  termRows.addEventListener("change", handleRowToggle);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[glossaryCore.STORAGE_KEY]) {
      return;
    }
    glossary = glossaryCore.normalizeGlossary(changes[glossaryCore.STORAGE_KEY].newValue);
    renderGlossary();
  });
}

async function loadGlossary() {
  try {
    const stored = await storageGet([glossaryCore.STORAGE_KEY]);
    glossary = glossaryCore.normalizeGlossary(stored[glossaryCore.STORAGE_KEY]);
    renderGlossary();
  } catch (error) {
    setStatus(`读取术语库失败：${getErrorMessage(error)}`, true);
  }
}

function renderGlossary() {
  const query = String(searchInput.value || "").trim().toLocaleLowerCase();
  const filtered = glossary.entries.filter((entry) => {
    if (!query) {
      return true;
    }
    return [entry.source, entry.target, entry.note]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  });
  const enabledCount = glossary.entries.filter((entry) => entry.enabled).length;

  countText.textContent = query
    ? `共 ${glossary.entries.length} 条，匹配 ${filtered.length} 条，启用 ${enabledCount} 条`
    : `共 ${glossary.entries.length} 条，启用 ${enabledCount} 条`;
  termRows.replaceChildren(...filtered.map(createTermRow));
  emptyState.textContent = glossary.entries.length === 0
    ? "暂无术语，点击“新增术语”开始建立词库。"
    : "没有匹配当前搜索条件的术语。";
  emptyState.classList.toggle("hidden", filtered.length !== 0);
}

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
  actions.append(
    createActionButton("编辑", "edit"),
    createActionButton("删除", "delete", "danger")
  );
  actionsCell.append(actions);
  row.append(enabledCell, sourceCell, targetCell, noteCell, actionsCell);
  return row;
}

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

function openEditor(entry = null) {
  dialogTitle.textContent = entry ? "编辑术语" : "新增术语";
  termIdInput.value = entry ? entry.id : "";
  sourceInput.value = entry ? entry.source : "";
  targetInput.value = entry ? entry.target : "";
  noteInput.value = entry ? entry.note : "";
  enabledInput.checked = entry ? entry.enabled : true;
  termDialog.showModal();
  sourceInput.focus();
}

async function saveEditor(event) {
  event.preventDefault();
  const id = String(termIdInput.value || "");
  const source = String(sourceInput.value || "").trim();
  const target = String(targetInput.value || "").trim();
  const duplicate = glossary.entries.find((entry) => entry.source === source && entry.id !== id);
  if (duplicate) {
    setStatus(`原文术语“${source}”已存在`, true);
    sourceInput.focus();
    return;
  }

  const nextEntry = glossaryCore.normalizeGlossaryEntry({
    id: id || createTermId(),
    source,
    target,
    note: noteInput.value,
    enabled: enabledInput.checked
  });
  if (!nextEntry) {
    setStatus("原文术语和固定译文不能为空", true);
    return;
  }

  const nextEntries = id
    ? glossary.entries.map((entry) => entry.id === id ? nextEntry : entry)
    : [nextEntry, ...glossary.entries];
  if (nextEntries.length > glossaryCore.MAX_ENTRIES) {
    setStatus(`术语库最多保存 ${glossaryCore.MAX_ENTRIES} 条`, true);
    return;
  }

  await persistEntries(nextEntries, id ? "术语已更新" : "术语已新增");
  termDialog.close();
}

async function handleRowClick(event) {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest("tr[data-term-id]");
  if (!button || !row) {
    return;
  }
  const entry = glossary.entries.find((item) => item.id === row.dataset.termId);
  if (!entry) {
    return;
  }

  if (button.dataset.action === "edit") {
    openEditor(entry);
    return;
  }
  if (button.dataset.action === "delete" && confirm(`确定删除术语“${entry.source}”吗？`)) {
    await persistEntries(
      glossary.entries.filter((item) => item.id !== entry.id),
      "术语已删除"
    );
  }
}

async function handleRowToggle(event) {
  if (event.target.dataset.action !== "toggle") {
    return;
  }
  const row = event.target.closest("tr[data-term-id]");
  if (!row) {
    return;
  }
  const nextEntries = glossary.entries.map((entry) => entry.id === row.dataset.termId
    ? { ...entry, enabled: event.target.checked }
    : entry);
  await persistEntries(nextEntries, event.target.checked ? "术语已启用" : "术语已停用");
}

async function importGlossaryFile() {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const imported = file.name.toLocaleLowerCase().endsWith(".csv")
      ? parseCsvGlossary(text)
      : glossaryCore.normalizeGlossary(JSON.parse(text)).entries;
    if (imported.length === 0) {
      throw new Error("文件中没有有效术语");
    }

    const merged = new Map(glossary.entries.map((entry) => [entry.source, entry]));
    for (const entry of imported) {
      const existing = merged.get(entry.source);
      merged.set(entry.source, { ...entry, id: existing ? existing.id : entry.id || createTermId() });
    }
    await persistEntries(
      Array.from(merged.values()).slice(0, glossaryCore.MAX_ENTRIES),
      `已导入 ${imported.length} 条术语（同名原文已更新）`
    );
  } catch (error) {
    setStatus(`导入失败：${getErrorMessage(error)}`, true);
  }
}

function parseCsvGlossary(text) {
  const rows = parseCsvRows(String(text || "").replace(/^\uFEFF/, ""));
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0].map((cell) => cell.trim().toLocaleLowerCase());
  const hasHeader = header.includes("source") && header.includes("target");
  const sourceIndex = hasHeader ? header.indexOf("source") : 0;
  const targetIndex = hasHeader ? header.indexOf("target") : 1;
  const noteIndex = hasHeader ? header.indexOf("note") : 2;
  const enabledIndex = hasHeader ? header.indexOf("enabled") : 3;

  return glossaryCore.normalizeGlossary((hasHeader ? rows.slice(1) : rows).map((row) => ({
    id: createTermId(),
    source: row[sourceIndex],
    target: row[targetIndex],
    note: noteIndex >= 0 ? row[noteIndex] : "",
    enabled: enabledIndex < 0 || !/^(false|0|no|否)$/i.test(String(row[enabledIndex] || "").trim())
  }))).entries;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
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
  if (row.some((value) => value !== "")) {
    rows.push(row);
  }
  return rows;
}

function exportGlossaryJson() {
  downloadFile(
    `manga-glossary-${formatDate()}.json`,
    JSON.stringify(glossary, null, 2),
    "application/json;charset=utf-8"
  );
  setStatus(`已导出 ${glossary.entries.length} 条术语`, false);
}

function exportGlossaryCsv() {
  const rows = [
    ["source", "target", "note", "enabled"],
    ...glossary.entries.map((entry) => [entry.source, entry.target, entry.note, String(entry.enabled)])
  ];
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  downloadFile(`manga-glossary-${formatDate()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  setStatus(`已导出 ${glossary.entries.length} 条术语`, false);
}

async function clearGlossary() {
  if (glossary.entries.length === 0 || !confirm(`确定清空全部 ${glossary.entries.length} 条术语吗？`)) {
    return;
  }
  await persistEntries([], "术语库已清空");
}

async function persistEntries(entries, message) {
  const next = glossaryCore.normalizeGlossary({
    version: glossaryCore.SCHEMA_VERSION,
    revision: glossary.revision + 1,
    updatedAt: Date.now(),
    entries
  });
  try {
    await storageSet({ [glossaryCore.STORAGE_KEY]: next });
    glossary = next;
    renderGlossary();
    setStatus(message, false);
  } catch (error) {
    setStatus(`保存失败：${getErrorMessage(error)}`, true);
    await loadGlossary();
  }
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeCsvCell(value) {
  const text = String(value || "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function createTermId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `term-${globalThis.crypto.randomUUID()}`;
  }
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function setStatus(message, isError) {
  statusText.textContent = message;
  statusText.dataset.error = isError ? "true" : "false";
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error || "未知错误");
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}
