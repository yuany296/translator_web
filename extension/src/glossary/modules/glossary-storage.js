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
    return runtime.glossaryCore.normalizeGlossary((hasHeader ? rows.slice(1) : rows).map(row => ({
      id: runtime.createTermId(),
      source: row[sourceIndex],
      target: row[targetIndex],
      note: noteIndex >= 0 ? row[noteIndex] : "",
      enabled: enabledIndex < 0 || !/^(false|0|no|否)$/i.test(String(row[enabledIndex] || "").trim())
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
    const rows = [["source", "target", "note", "enabled"], ...runtime.glossary.entries.map(entry => [entry.source, entry.target, entry.note, String(entry.enabled)])];
    const csv = rows.map(row => row.map(runtime.escapeCsvCell).join(",")).join("\r\n");
    runtime.downloadFile(`manga-glossary-${runtime.formatDate()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
    runtime.setStatus(`已导出 ${runtime.glossary.entries.length} 条术语`, false);
  }
  runtime.exportGlossaryCsv = exportGlossaryCsv;
  async function clearGlossary() {
    if (runtime.glossary.entries.length === 0 || !confirm(`确定清空全部 ${runtime.glossary.entries.length} 条术语吗？`)) {
      return;
    }
    await runtime.persistEntries([], "术语库已清空");
  }
  runtime.clearGlossary = clearGlossary;
  async function migrateGlossaryToServer() {
    const serverUrl = prompt("请输入 OCR 服务地址（默认 http://127.0.0.1:8765）：", "http://127.0.0.1:8765");
    if (!serverUrl) return;
    const baseUrl = serverUrl.replace(/\/+$/, "");
    if (!confirm(`将把浏览器存储中的术语数据迁移到 ${baseUrl}，确认继续？`)) return;
    runtime.migrateBtn.disabled = true;
    runtime.migrateStatus.textContent = "迁移中...";
    runtime.migrateStatus.style.color = "";
    try {
      // 1. 读取本地数据
      const stored = await runtime.storageGet([runtime.glossaryCore.STORAGE_KEY, runtime.termDiscoveryCore.PENDING_STORAGE_KEY, runtime.termDiscoveryCore.IGNORED_STORAGE_KEY]);

      // 2. 获取待确认和已忽略数据（通过 background）
      const termState = await runtime.sendRuntimeMessage({
        type: "GET_TERM_DISCOVERY_STATE"
      });

      // 3. 导入术语条目
      const glossaryEntries = runtime.glossaryCore.normalizeGlossary(stored[runtime.glossaryCore.STORAGE_KEY]).entries;
      let importedCount = 0;
      if (glossaryEntries.length > 0) {
        const resp = await fetch(`${baseUrl}/glossary/import`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            entries: glossaryEntries
          })
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
                  headers: {
                    "Content-Type": "application/json"
                  },
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
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                source: item.source
              })
            });
            ignoredCount++;
          } catch (_) {}
        }
      }
      runtime.migrateStatus.textContent = `✅ 迁移完成：${importedCount} 条术语，${pendingCount} 条待确认，${ignoredCount} 条已忽略`;
      runtime.migrateStatus.style.color = "#28a745";
    } catch (error) {
      runtime.migrateStatus.textContent = `❌ 迁移失败：${runtime.getErrorMessage(error)}`;
      runtime.migrateStatus.style.color = "#dc3545";
    } finally {
      runtime.migrateBtn.disabled = false;
    }
  }
  runtime.migrateGlossaryToServer = migrateGlossaryToServer;
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
