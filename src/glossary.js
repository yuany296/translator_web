"use strict";

const glossaryCore = globalThis.MangaGlossary;
const termDiscoveryCore = globalThis.MangaTermDiscovery;
const addBtn = document.getElementById("addBtn");
const officialTabBtn = document.getElementById("officialTabBtn");
const pendingTabBtn = document.getElementById("pendingTabBtn");
const officialPanel = document.getElementById("officialPanel");
const pendingPanel = document.getElementById("pendingPanel");
const searchInput = document.getElementById("searchInput");
const importBtn = document.getElementById("importBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const migrateBtn = document.getElementById("migrateBtn");
const migrateStatus = document.getElementById("migrateStatus");
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
const confirmFilledBtn = document.getElementById("confirmFilledBtn");
const extractorStatus = document.getElementById("extractorStatus");
const pendingCountText = document.getElementById("pendingCountText");
const pendingStatusText = document.getElementById("pendingStatusText");
const pendingChapters = document.getElementById("pendingChapters");
const pendingEmptyState = document.getElementById("pendingEmptyState");
const ignoredPanel = document.getElementById("ignoredPanel");
const ignoredRows = document.getElementById("ignoredRows");

let glossary = glossaryCore.normalizeGlossary(null);
let pendingStore = termDiscoveryCore.normalizePendingStore(null);
let ignoredStore = termDiscoveryCore.normalizeIgnoredStore(null);
let activeTab = "official";

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await Promise.all([loadGlossary(), loadTermDiscoveryState(true)]);
});

function bindEvents() {
  addBtn.addEventListener("click", () => openEditor());
  searchInput.addEventListener("input", renderGlossary);
  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", importGlossaryFile);
  exportJsonBtn.addEventListener("click", exportGlossaryJson);
  exportCsvBtn.addEventListener("click", exportGlossaryCsv);
  clearBtn.addEventListener("click", clearGlossary);
  migrateBtn.addEventListener("click", migrateGlossaryToServer);
  termForm.addEventListener("submit", saveEditor);
  cancelBtn.addEventListener("click", () => termDialog.close());
  termRows.addEventListener("click", handleRowClick);
  termRows.addEventListener("change", handleRowToggle);
  officialTabBtn.addEventListener("click", () => switchTab("official"));
  pendingTabBtn.addEventListener("click", () => switchTab("pending"));
  confirmFilledBtn.addEventListener("click", confirmAllFilledCandidates);
  pendingChapters.addEventListener("click", handlePendingCandidateClick);
  ignoredRows.addEventListener("click", handleIgnoredClick);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes[glossaryCore.STORAGE_KEY]) {
      glossary = glossaryCore.normalizeGlossary(changes[glossaryCore.STORAGE_KEY].newValue);
      renderGlossary();
    }
    if (
      changes[termDiscoveryCore.PENDING_STORAGE_KEY] ||
      changes[termDiscoveryCore.IGNORED_STORAGE_KEY] ||
      changes[termDiscoveryCore.ENABLED_STORAGE_KEY]
    ) {
      loadTermDiscoveryState(false).catch(() => undefined);
    }
  });
}

function switchTab(tab) {
  activeTab = tab === "pending" ? "pending" : "official";
  const showPending = activeTab === "pending";
  officialPanel.classList.toggle("hidden", showPending);
  pendingPanel.classList.toggle("hidden", !showPending);
  officialTabBtn.classList.toggle("active", !showPending);
  pendingTabBtn.classList.toggle("active", showPending);
  addBtn.classList.toggle("hidden", showPending);
  if (showPending) {
    loadTermDiscoveryState(true).catch((error) => {
      setPendingStatus(`读取失败：${getErrorMessage(error)}`, true);
    });
  }
}

async function loadTermDiscoveryState(probe = false) {
  try {
    const response = await sendRuntimeMessage({ type: "GET_TERM_DISCOVERY_STATE", probe });
    if (!response || !response.ok) {
      throw new Error(response && response.error || "读取待确认术语失败");
    }
    pendingStore = termDiscoveryCore.normalizePendingStore(response.pending);
    ignoredStore = termDiscoveryCore.normalizeIgnoredStore(response.ignored);
    renderPendingState(response);
  } catch (error) {
    setPendingStatus(`读取待确认术语失败：${getErrorMessage(error)}`, true);
    throw error;
  }
}

function renderPendingState(response = {}) {
  const pendingCount = termDiscoveryCore.getPendingCount(pendingStore);
  pendingTabBtn.textContent = `待确认（${pendingCount}）`;
  pendingCountText.textContent = `最近 ${pendingStore.chapters.length} 话，共 ${pendingCount} 条待确认术语`;
  confirmFilledBtn.disabled = pendingCount === 0;
  pendingChapters.replaceChildren(
    ...pendingStore.chapters
      .filter((chapter) => chapter.candidates.length > 0)
      .map(createPendingChapter)
  );
  pendingEmptyState.classList.toggle("hidden", pendingCount !== 0);
  renderIgnoredTerms();

  const enabled = response.enabled !== false;
  const stateValue = String(response.status && response.status.state || "unknown");
  if (!enabled || stateValue === "disabled") {
    extractorStatus.textContent = "Kiwi 状态：自动发现已关闭";
  } else if (stateValue === "online") {
    extractorStatus.textContent = "Kiwi 状态：在线";
  } else if (stateValue === "offline") {
    extractorStatus.textContent = "Kiwi 状态：离线（不影响翻译）";
  } else {
    extractorStatus.textContent = "Kiwi 状态：等待本地服务";
  }
}

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
  section.append(heading, ...chapter.candidates.map((candidate) => createCandidateCard(chapter, candidate)));
  return section;
}

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
  heading.append(
    source,
    createBadge(formatCandidateKind(candidate.kind)),
    createBadge(`出现 ${candidate.occurrences} 次`)
  );
  if (candidate.ambiguous) {
    heading.append(createBadge("可能有歧义", "warning"));
  }

  const grid = document.createElement("div");
  grid.className = "candidate-grid";
  grid.append(
    createCandidateField("原文术语（可修改）", "candidate-source-input", candidate.source, 120),
    createCandidateField("固定译文", "candidate-target", candidate.suggestedTarget, 120),
    createCandidateField("备注（可选）", "candidate-note", "", 240)
  );
  const sourceInput = grid.querySelector(".candidate-source-input");
  const targetInput = grid.querySelector(".candidate-target");
  targetInput.dataset.autoSuggestion = candidate.suggestedTarget || "";
  targetInput.addEventListener("input", () => {
    targetInput.dataset.userEdited = "true";
  });
  sourceInput.addEventListener("input", () => {
    source.textContent = sourceInput.value.trim() || candidate.source;
    const suggestion = termDiscoveryCore.getSuggestedTargetForSource(sourceInput.value, candidate.contexts);
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
    contexts.append(...candidate.contexts.map((context) => {
      const row = document.createElement("div");
      row.className = "context-row";
      row.textContent = context.translatedText
        ? `${context.originalText} → ${context.translatedText}`
        : context.originalText;
      return row;
    }));
  }

  const actions = document.createElement("div");
  actions.className = "pending-actions";
  actions.append(
    createActionButton("确认加入", "confirm", "primary"),
    createActionButton("本话忽略", "ignore-chapter"),
    createActionButton("永久忽略", "ignore-global", "danger")
  );
  card.append(heading, grid, contexts, actions);
  return card;
}

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

function createBadge(text, className = "") {
  const badge = document.createElement("span");
  badge.className = `badge${className ? ` ${className}` : ""}`;
  badge.textContent = text;
  return badge;
}

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

function renderIgnoredTerms() {
  ignoredPanel.classList.toggle("hidden", ignoredStore.sources.length === 0);
  ignoredRows.replaceChildren(...ignoredStore.sources.map((item) => {
    const row = document.createElement("div");
    row.className = "ignored-row";
    const source = document.createElement("span");
    source.textContent = item.source;
    const button = createActionButton("恢复", "restore");
    button.dataset.source = item.source;
    row.append(source, button);
    return row;
  }));
}

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
      setPendingStatus("原文术语不能为空", true);
      card.querySelector(".candidate-source-input").focus();
      return;
    }
    if (!target) {
      setPendingStatus(`请先填写“${source}”的固定译文`, true);
      card.querySelector(".candidate-target").focus();
      return;
    }
    await confirmPendingEntries([{ candidateSource, source, target, note }]);
    return;
  }
  const scope = button.dataset.action === "ignore-global" ? "global" : "chapter";
  await runPendingAction(
    { type: "IGNORE_TERM_CANDIDATE", chapterKey, source: candidateSource, scope },
    scope === "global" ? `已永久忽略“${candidateSource}”` : `本话已忽略“${candidateSource}”`
  );
}

async function confirmAllFilledCandidates() {
  const entries = Array.from(pendingChapters.querySelectorAll(".candidate-card"))
    .map((card) => ({
      candidateSource: card.dataset.source,
      source: card.querySelector(".candidate-source-input").value.trim(),
      target: card.querySelector(".candidate-target").value.trim(),
      note: card.querySelector(".candidate-note").value.trim()
    }))
    .filter((entry) => entry.source && entry.target);
  if (entries.length === 0) {
    setPendingStatus("没有已填写译名的候选术语", true);
    return;
  }
  await confirmPendingEntries(entries);
}

async function confirmPendingEntries(entries) {
  await runPendingAction(
    { type: "CONFIRM_TERM_CANDIDATES", entries },
    `已加入 ${entries.length} 条正式术语`
  );
}

async function handleIgnoredClick(event) {
  const button = event.target.closest("button[data-action='restore']");
  if (!button) {
    return;
  }
  await runPendingAction(
    { type: "RESTORE_IGNORED_TERM", source: button.dataset.source },
    `已恢复“${button.dataset.source}”，后续出现时会重新发现`
  );
}

async function runPendingAction(message, successMessage) {
  try {
    const response = await sendRuntimeMessage(message);
    if (!response || !response.ok) {
      throw new Error(response && response.error || "操作失败");
    }
    setPendingStatus(successMessage, false);
    await Promise.all([loadGlossary(), loadTermDiscoveryState(false)]);
  } catch (error) {
    setPendingStatus(`操作失败：${getErrorMessage(error)}`, true);
  }
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

async function migrateGlossaryToServer() {
  const serverUrl = prompt(
    "请输入 OCR 服务地址（默认 http://127.0.0.1:8765）：",
    "http://127.0.0.1:8765"
  );
  if (!serverUrl) return;
  const baseUrl = serverUrl.replace(/\/+$/, "");

  if (!confirm(`将把浏览器存储中的术语数据迁移到 ${baseUrl}，确认继续？`)) return;
  migrateBtn.disabled = true;
  migrateStatus.textContent = "迁移中...";
  migrateStatus.style.color = "";

  try {
    // 1. 读取本地数据
    const stored = await storageGet([
      glossaryCore.STORAGE_KEY,
      termDiscoveryCore.PENDING_STORAGE_KEY,
      termDiscoveryCore.IGNORED_STORAGE_KEY
    ]);

    // 2. 获取待确认和已忽略数据（通过 background）
    const termState = await sendRuntimeMessage({ type: "GET_TERM_DISCOVERY_STATE" });

    // 3. 导入术语条目
    const glossaryEntries = glossaryCore.normalizeGlossary(stored[glossaryCore.STORAGE_KEY]).entries;
    let importedCount = 0;
    if (glossaryEntries.length > 0) {
      const resp = await fetch(`${baseUrl}/glossary/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: glossaryEntries })
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`服务端错误 ${resp.status}：${text.slice(0, 200)}`);
      }
      const data = await resp.json();
      if (data.ok) importedCount = data.imported || 0;
    }

    // 4. 导入待确认候选
    let pendingCount = 0;
    const pending = termState && termState.pending;
    if (pending && Array.isArray(pending.chapters)) {
      for (const chapter of pending.chapters) {
        if (Array.isArray(chapter.candidates)) {
          for (const candidate of chapter.candidates) {
            try {
              // 将 evidenceIds 转换为字符串数组，避免类型不匹配
              const eids = (candidate.evidenceIds || []).slice(0, 50).map(String);
              await fetch(`${baseUrl}/glossary/pending`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  source: candidate.source,
                  kind: candidate.kind || "proper_noun",
                  score: Number(candidate.score) || 0,
                  evidence_ids: eids,
                  chapter_key: chapter.key || ""
                })
              });
              pendingCount++;
            } catch (_) {}
          }
        }
      }
    }

    // 5. 导入已忽略列表
    let ignoredCount = 0;
    const ignored = termState && termState.ignored;
    if (ignored && Array.isArray(ignored.sources)) {
      for (const item of ignored.sources) {
        try {
          await fetch(`${baseUrl}/glossary/pending/ignore`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: item.source })
          });
          ignoredCount++;
        } catch (_) {}
      }
    }

    migrateStatus.textContent =
      `✅ 迁移完成：${importedCount} 条术语，${pendingCount} 条待确认，${ignoredCount} 条已忽略`;
    migrateStatus.style.color = "#28a745";
  } catch (error) {
    migrateStatus.textContent = `❌ 迁移失败：${getErrorMessage(error)}`;
    migrateStatus.style.color = "#dc3545";
  } finally {
    migrateBtn.disabled = false;
  }
}

async function persistEntries(entries, message) {
  const next = glossaryCore.normalizeGlossary({
    version: glossaryCore.SCHEMA_VERSION,
    revision: glossary.revision + 1,
    updatedAt: Date.now(),
    entries
  });
  try {
    const nextPending = termDiscoveryCore.removeSourcesFromPending(
      pendingStore,
      next.entries.map((entry) => entry.source)
    );
    await storageSet({
      [glossaryCore.STORAGE_KEY]: next,
      [termDiscoveryCore.PENDING_STORAGE_KEY]: nextPending
    });
    glossary = next;
    pendingStore = nextPending;
    renderGlossary();
    renderPendingState();
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

function setPendingStatus(message, isError) {
  pendingStatusText.textContent = message;
  pendingStatusText.dataset.error = isError ? "true" : "false";
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response || null);
    });
  });
}
