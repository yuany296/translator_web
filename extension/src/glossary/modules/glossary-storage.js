export function installGlossaryStorage(runtime) {
  function parseCsvGlossary(text) {
    const rows = runtime.parseCsvRows(String(text || "").replace(/^\uFEFF/, ""));
    if (rows.length === 0) {
      return [];
    }
    const header = rows[0].map(cell => cell.trim().toLocaleLowerCase());
    const hasHeader = header.includes("source") && header.includes("target");
    const sourceIndex = hasHeader ? header.indexOf("source") : 0;
    const targetIndex = hasHeader ? header.indexOf("target") : 1;
    const noteIndex = hasHeader ? header.indexOf("note") : 2;
    const enabledIndex = hasHeader ? header.indexOf("enabled") : 3;
    const scopeIndex = hasHeader ? header.indexOf("scope") : -1;
    const scopeKeyIndex = hasHeader ? header.indexOf("scope_key") : -1;
    const scopeLabelIndex = hasHeader ? header.indexOf("scope_label") : -1;
    return runtime.glossaryCore.normalizeGlossary((hasHeader ? rows.slice(1) : rows).map(row => ({
      id: runtime.createTermId(),
      source: row[sourceIndex],
      target: row[targetIndex],
      note: noteIndex >= 0 ? row[noteIndex] : "",
      enabled: enabledIndex < 0 || !/^(false|0|no|否)$/i.test(String(row[enabledIndex] || "").trim()),
      scope: scopeIndex >= 0 ? row[scopeIndex] : "global",
      scopeKey: scopeKeyIndex >= 0 ? row[scopeKeyIndex] : "",
      scopeLabel: scopeLabelIndex >= 0 ? row[scopeLabelIndex] : ""
    }))).entries;
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
    if (row.some(value => value !== "")) {
      rows.push(row);
    }
    return rows;
  }
  runtime.parseCsvRows = parseCsvRows;
  function exportGlossaryJson() {
    runtime.downloadFile(`manga-glossary-${runtime.formatDate()}.json`, JSON.stringify(runtime.glossary, null, 2), "application/json;charset=utf-8");
    runtime.setStatus(`已导出 ${runtime.glossary.entries.length} 条术语`, false);
  }
  runtime.exportGlossaryJson = exportGlossaryJson;
  function exportGlossaryCsv() {
    const rows = [["source", "target", "note", "enabled", "scope", "scope_key", "scope_label"],
      ...runtime.glossary.entries.map(entry => [
        entry.source, entry.target, entry.note, String(entry.enabled),
        entry.scope, entry.scopeKey, entry.scopeLabel
      ])];
    const csv = rows.map(row => row.map(runtime.escapeCsvCell).join(",")).join("\r\n");
    runtime.downloadFile(`manga-glossary-${runtime.formatDate()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
    runtime.setStatus(`已导出 ${runtime.glossary.entries.length} 条术语`, false);
  }
  runtime.exportGlossaryCsv = exportGlossaryCsv;
  async function clearGlossary() {
    if (runtime.glossary.entries.length === 0) return;
    if (!confirm(`确定清空全部 ${runtime.glossary.entries.length} 条术语吗？此操作同时清空服务端数据库。`)) return;
    runtime.clearBtn.disabled = true;
    try {
      const resp = await fetch(`${runtime.getServerBaseUrl()}/glossary/clear`, { method: "POST" });
      if (!resp.ok) throw new Error(`服务器错误 ${resp.status}`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "清空失败");
      runtime.glossary.entries = [];
      runtime.glossary.revision = 0;
      await runtime.storageSet({ [runtime.glossaryCore.STORAGE_KEY]: runtime.glossary });
      runtime.renderGlossary();
      runtime.setStatus(`已清空 ${data.deleted || 0} 条术语`, false);
    } catch (error) {
      runtime.setStatus(`清空失败：${runtime.getErrorMessage(error)}`, true);
    } finally {
      runtime.clearBtn.disabled = false;
    }
  }
  runtime.clearGlossary = clearGlossary;
  // ── server-backed glossary sync ──
  let serverBaseUrl = localStorage.getItem("mt_glossary_server_url") || "http://127.0.0.1:8765";
  runtime.getServerBaseUrl = () => serverBaseUrl;
  runtime.setServerBaseUrl = (url) => { serverBaseUrl = String(url || "http://127.0.0.1:8765").replace(/\/+$/, ""); try { localStorage.setItem("mt_glossary_server_url", serverBaseUrl); } catch (_) {} };
  runtime.getSyncRevision = () => {
    try { return Number(localStorage.getItem("mt_glossary_sync_revision")) || 0; } catch (_) { return 0; }
  };
  runtime.setSyncRevision = (rev) => {
    try { localStorage.setItem("mt_glossary_sync_revision", String(Number(rev) || 0)); } catch (_) {}
  };
  async function loadGlossaryFromServer() {
    try {
      const resp = await fetch(`${serverBaseUrl}/glossary?limit=2000`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.ok || !Array.isArray(data.entries)) throw new Error("Invalid server response");
      runtime.glossary = runtime.glossaryCore.normalizeGlossary({
        version: runtime.glossaryCore.SCHEMA_VERSION,
        revision: Math.max(1, Math.round((data.revision || data.last_updated || 0) * 1000)),
        updatedAt: Date.now(),
        entries: data.entries.map(e => ({
          id: e.id, source: e.source, target: e.target, note: e.note || "",
          enabled: e.enabled !== false, scope: e.scope || e.scope_type,
          scopeKey: e.scopeKey || e.scope_key, scopeLabel: e.scopeLabel || e.scope_label
        }))
      });
      await runtime.storageSet({
        [runtime.glossaryCore.STORAGE_KEY]: runtime.glossary
      });
      if (data.revision) runtime.setSyncRevision(Number(data.revision));
      runtime.renderGlossary();
      runtime.setStatus(`已从服务加载 ${data.total || runtime.glossary.entries.length} 条术语 (修订 ${runtime.getSyncRevision().toFixed(1)})`, false);
      return { ok: true, entries: runtime.glossary.entries };
    } catch (error) {
      runtime.setStatus(`加载失败：${runtime.getErrorMessage(error)}`, true);
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.loadGlossaryFromServer = loadGlossaryFromServer;
  async function saveEntryToServer(source, target, tgtLng, note, enabled, entryId, scope = {}) {
    try {
      const body = { source: source.trim(), target: target.trim(), tgt_lng: tgtLng || "zh-CN" };
      if (note) body.note = note.trim();
      body.enabled = enabled !== false;
      body.scope_type = scope.scope === "series" ? "series" : "global";
      body.scope_key = body.scope_type === "series" ? String(scope.scopeKey || "") : "";
      body.scope_label = body.scope_type === "series" ? String(scope.scopeLabel || "") : "";
      if (entryId && !entryId.startsWith("term-new-")) body.id = entryId;
      const resp = await fetch(`${serverBaseUrl}/glossary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "保存失败");
      const savedEntry = data.entry || {};
      // Refresh local revision
      try {
        const healthResp = await fetch(`${serverBaseUrl}/glossary/health`);
        const healthData = await healthResp.json();
        if (healthData.revision) runtime.setSyncRevision(Number(healthData.revision));
      } catch (_) {}
      return { ok: true, entry: savedEntry };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.saveEntryToServer = saveEntryToServer;
  async function deleteEntryFromServer(entryId) {
    try {
      const resp = await fetch(`${serverBaseUrl}/glossary/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      if (resp.status === 404) return { ok: true };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.deleteEntryFromServer = deleteEntryFromServer;
  async function importDbFileToServer(file) {
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`${serverBaseUrl}/glossary/import-db`, { method: "POST", body: form });
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
  // ── end server sync ──
  async function persistEntries(entries, message) {
    const next = runtime.glossaryCore.normalizeGlossary({
      version: runtime.glossaryCore.SCHEMA_VERSION,
      revision: runtime.glossary.revision + 1,
      updatedAt: Date.now(),
      entries
    });
    try {
      const nextPending = runtime.termDiscoveryCore.removeSourcesFromPending(runtime.pendingStore, next.entries.map(entry => entry.source));
      await runtime.storageSet({
        [runtime.glossaryCore.STORAGE_KEY]: next,
        [runtime.termDiscoveryCore.PENDING_STORAGE_KEY]: nextPending
      });
      runtime.glossary = next;
      runtime.pendingStore = nextPending;
      runtime.renderGlossary();
      runtime.renderPendingState();
      runtime.setStatus(message, false);
      // Sync to server in background
      try {
        const batchEntries = next.entries.map(e => ({
          source: e.source, target: e.target, note: e.note || "", enabled: e.enabled !== false,
          scope_type: e.scope, scope_key: e.scopeKey, scope_label: e.scopeLabel
        }));
        const resp = await fetch(`${runtime.getServerBaseUrl()}/glossary/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: batchEntries, tgt_lng: "zh-CN" })
        });
        const data = await resp.json();
        if (data.ok || data.added > 0 || data.updated > 0) {
          runtime.setSyncRevision(data.revision || Date.now() / 1000);
        }
      } catch (_) {
        // Server sync is best-effort
      }
    } catch (error) {
      runtime.setStatus(`保存失败：${runtime.getErrorMessage(error)}`, true);
      await runtime.loadGlossary();
    }
  }
  runtime.persistEntries = persistEntries;
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
  function setStatus(message, isError) {
    runtime.statusText.textContent = message;
    runtime.statusText.dataset.error = isError ? "true" : "false";
  }
  runtime.setStatus = setStatus;
  function setPendingStatus(message, isError) {
    runtime.pendingStatusText.textContent = message;
    runtime.pendingStatusText.dataset.error = isError ? "true" : "false";
  }
  runtime.setPendingStatus = setPendingStatus;
  function getErrorMessage(error) {
    return error && error.message ? error.message : String(error || "未知错误");
  }
  runtime.getErrorMessage = getErrorMessage;
  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, result => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result || {});
      });
    });
  }
  runtime.storageGet = storageGet;
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
  runtime.storageSet = storageSet;
  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || null);
      });
    });
  }
  runtime.sendRuntimeMessage = sendRuntimeMessage;
}
