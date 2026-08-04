function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response?.ok === false) reject(new Error(response.error || "操作失败"));
    else resolve(response);
  }));
}

function cell(row, className = "") {
  const value = document.createElement("td");
  value.className = className;
  value.textContent = String(row ?? "");
  return value;
}

export function installTranslationLibrary() {
  const state = { exports: [], filter: "" };
  const status = document.querySelector("#status");
  const rows = document.querySelector("#rows");
  const dialog = document.querySelector("#versions");
  const versionRows = document.querySelector("#versionRows");

  function filteredRecords() {
    const needle = state.filter.toLowerCase();
    return state.exports.filter(entry => {
      const record = entry.record || {};
      return !needle || [record.mode, record.scopeKey, record.rawSourceText,
        record.activeVersion?.translatedText, record.workId, record.chapterId]
        .some(value => String(value || "").toLowerCase().includes(needle));
    });
  }

  function showError(error) {
    status.textContent = error?.message || String(error);
  }

  async function showVersions(entry) {
    const response = await send({ type: "GET_TRANSLATION_VERSIONS", recordId: entry.record.recordId });
    versionRows.replaceChildren();
    for (const version of response.versions || []) {
      const row = document.createElement("div");
      row.className = "version";
      const text = document.createElement("div");
      text.textContent = `${version.source}${version.pinned ? " · pinned" : ""} · ${new Date(version.createdAt).toLocaleString()}\n${version.translatedText}`;
      const select = document.createElement("button");
      select.textContent = version.versionId === entry.record.activeVersionId ? "当前版本" : "设为活动版本";
      select.disabled = version.versionId === entry.record.activeVersionId;
      select.addEventListener("click", () => void selectVersion(entry, version.versionId).catch(showError));
      row.append(text, select);
      versionRows.appendChild(row);
    }
    dialog.showModal();
  }

  async function selectVersion(entry, versionId) {
    const record = entry.record;
    await send({
      type: "SUBMIT_TRANSLATION_OPERATIONS",
      operations: [{
        operationId: crypto.randomUUID(), type: "select_version",
        recordId: record.recordId, recordKey: record.recordKey,
        expectedRecordRevision: record.recordRevision,
        baseActiveVersionId: record.activeVersionId,
        payload: { versionId }, createdAt: Date.now()
      }]
    });
    dialog.close();
    await refresh();
  }

  async function deleteRecord(entry) {
    const record = entry.record;
    if (!confirm("确定软删除这条正式译文吗？完整版本历史仍保留在 SQLite。")) return;
    await send({
      type: "SUBMIT_TRANSLATION_OPERATIONS",
      operations: [{
        operationId: crypto.randomUUID(), type: "delete",
        recordId: record.recordId, recordKey: record.recordKey,
        expectedRecordRevision: record.recordRevision,
        baseActiveVersionId: record.activeVersionId,
        payload: {}, createdAt: Date.now()
      }]
    });
    await refresh();
  }

  function render() {
    rows.replaceChildren();
    for (const entry of filteredRecords()) {
      const record = entry.record;
      const tr = document.createElement("tr");
      const mode = cell(record.mode);
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = record.mode;
      mode.replaceChildren(tag);
      const actions = cell("", "actions");
      const versions = document.createElement("button");
      versions.textContent = `历史 ${entry.versions?.length || 0}`;
      versions.addEventListener("click", () => void showVersions(entry).catch(showError));
      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "删除";
      remove.addEventListener("click", () => void deleteRecord(entry).catch(showError));
      actions.append(versions, remove);
      tr.append(mode, cell(record.scopeKey), cell(`${record.resolvedSourceLanguage} → ${record.targetLanguage}`),
        cell(record.rawSourceText, "source"), cell(record.activeVersion?.translatedText, "translation"),
        cell(`${record.recordRevision} / seq ${record.changeSeq}`), actions);
      rows.appendChild(tr);
    }
  }

  async function refresh() {
    status.textContent = "正在读取 SQLite…";
    const response = await send({ type: "EXPORT_TRANSLATION_LIBRARY" });
    state.exports = response.data?.records || [];
    status.textContent = `SQLite 在线 · ${state.exports.length} 条记录 · changeSeq ${response.data?.changeSeq || 0}`;
    render();
  }

  document.querySelector("#search").addEventListener("input", event => {
    state.filter = event.target.value.trim();
    render();
  });
  document.querySelector("#refresh").addEventListener("click", () => void refresh().catch(showError));
  document.querySelector("#export").addEventListener("click", async () => {
    try {
      const response = await send({ type: "EXPORT_TRANSLATION_LIBRARY" });
      const url = URL.createObjectURL(new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `manga-translations-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { showError(error); }
  });
  document.querySelector("#import").addEventListener("click", () => document.querySelector("#file").click());
  document.querySelector("#file").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("导入文件不能超过 10 MiB");
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.records) || data.records.length > 5000) throw new Error("导入记录格式或数量无效");
      if (!confirm(`确认导入 ${data.records.length} 条记录并合并到 SQLite 历史吗？`)) return;
      await send({ type: "IMPORT_TRANSLATION_LIBRARY", records: data.records });
      await refresh();
    } catch (error) { showError(error); }
    event.target.value = "";
  });
  document.querySelector("#closeDialog").addEventListener("click", () => dialog.close());
  void refresh().catch(showError);
}
