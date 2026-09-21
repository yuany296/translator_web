export function installGlossaryStorage(runtime) {
  function getServiceHeaders(json = false) {
    return { ...(json ? { "Content-Type": "application/json" } : {}) };
  }
  runtime.getServiceHeaders = getServiceHeaders;
  /**
   * 读接口一律带超时：本地服务单线程，批量写译文时会把队列占满（连 /glossary/health 都要排队），
   * 没有超时的话页面会一直转圈、最后看起来「术语表是空的」。超时后照常走本地副本兜底。
   */
  async function fetchReadWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  runtime.fetchReadWithTimeout = fetchReadWithTimeout;
  // ── server-backed glossary sync ──
  let serverBaseUrl = localStorage.getItem("mt_glossary_server_url") || "http://127.0.0.1:8765";
  async function resolveServerBaseUrl() {
    // 与背景层 handleConfirmTermCandidates 同源（配置的 OCR baseUrl），避免面板同步到服务 A、页面读取服务 B。
    try {
      const stored = await runtime.storageGet(["mt_ocr_config_v1"]);
      const configured = String(stored.mt_ocr_config_v1?.localPaddle?.baseUrl || "").trim();
      if (configured) return configured.replace(/\/+$/, "");
    } catch (_) {}
    return String(serverBaseUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
  }
  runtime.getServerBaseUrl = () => serverBaseUrl;
  runtime.resolveServerBaseUrl = resolveServerBaseUrl;
  runtime.setServerBaseUrl = (url) => {
    serverBaseUrl = String(url || "http://127.0.0.1:8765").replace(/\/+$/, "");
    try { localStorage.setItem("mt_glossary_server_url", serverBaseUrl); } catch (_) {}
  };
  runtime.getSyncRevision = () => { try { return Number(localStorage.getItem("mt_glossary_sync_revision")) || 0; } catch (_) { return 0; } };
  runtime.setSyncRevision = (rev) => { try { localStorage.setItem("mt_glossary_sync_revision", String(Number(rev) || 0)); } catch (_) {} };
  async function loadGlossaryFromServer() {
    const stored = await runtime.storageGet([runtime.glossaryCore.STORAGE_KEY, runtime.glossaryCore.LEGACY_STORAGE_KEY]);
    const localState = runtime.glossaryCore.normalizeGlossary(
      stored[runtime.glossaryCore.STORAGE_KEY] ?? stored[runtime.glossaryCore.LEGACY_STORAGE_KEY]
    );
    try {
      serverBaseUrl = await resolveServerBaseUrl();
      const fetchData = async () => {
        const resp = await fetchReadWithTimeout(`${serverBaseUrl}/glossary?limit=2000`, {
          headers: await getServiceHeaders()
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        if (!payload.ok || !Array.isArray(payload.entries)) throw new Error("Invalid server response");
        return payload;
      };
      let data = await fetchData();
      const entryKey = entry => [entry.libraryId, entry.sourceLanguage, entry.targetLanguage, entry.scope, entry.scopeKey, entry.source].join("\u0000");
      const toEntry = e => ({
        libraryId: e.libraryId || e.library_id || runtime.glossaryCore.DEFAULT_LIBRARY_ID,
        source: String(e.source || ""), sourceLanguage: e.sourceLanguage || e.src_lng || "ko",
        targetLanguage: e.targetLanguage || e.tgtLng || e.tgt_lng || "zh-CN",
        scope: e.scope || e.scope_type || "global", scopeKey: e.scopeKey || e.scope_key || ""
      });
      // 迁移历史数据：修订面板确认的术语此前只写本地 chrome.storage，服务在线时补传服务端缺失条目。
      let pushed = 0;
      let missing = [];
      try {
        const localEntries = localState.entries;
        if (localEntries.length) {
          const serverKeys = new Set(data.entries.map(entry => entryKey(toEntry(entry))));
          missing = localEntries.filter(entry => !serverKeys.has(entryKey(entry)));
          if (missing.length) {
            const batchResp = await fetch(`${serverBaseUrl}/glossary/batch`, {
              method: "POST",
              headers: await getServiceHeaders(true),
              body: JSON.stringify({
                entries: missing.map(entry => ({ id: entry.id, source: entry.source, target: entry.target, note: entry.note || "", enabled: entry.enabled !== false, src_lng: entry.sourceLanguage, tgt_lng: entry.targetLanguage, scope_type: entry.scope, scope_key: entry.scopeKey, scope_label: entry.scopeLabel, library_id: entry.libraryId })),
                tgt_lng: "zh-CN"
              })
            });
            const batchData = await batchResp.json().catch(() => null);
            if (batchResp.ok && (batchData.ok || batchData.added > 0 || batchData.updated > 0)) pushed = missing.length;
          }
        }
      } catch (_) { /* 迁移失败不阻断加载，本地条目保留为离线兜底 */ }
      if (pushed > 0) {
        data = await fetchData();
      } else if (missing.length) {
        // 迁移推送失败：合并本地独有条目，不因服务端旧数据覆盖而丢失。
        data = { ...data, entries: [...data.entries, ...missing] };
      }
      // 服务端没返回库定义（旧版服务）时保留本地库，避免刷新即丢失库归属。
      const serverLibraries = Array.isArray(data.libraries) && data.libraries.length ? data.libraries : null;
      runtime.libraryServerSupported = Boolean(serverLibraries);
      const libraries = serverLibraries
        ? runtime.glossaryCore.normalizeLibraries([
          ...serverLibraries,
          ...localState.libraries.filter(local => !serverLibraries.some(item => item.id === local.id))
        ])
        : localState.libraries;
      runtime.glossary = runtime.glossaryCore.normalizeGlossary({
        version: runtime.glossaryCore.SCHEMA_VERSION,
        revision: Math.max(1, Math.round((data.revision || data.last_updated || 0) * 1000)),
        updatedAt: Date.now(),
        libraries,
        entries: data.entries.map(e => ({
          id: e.id, source: e.source, target: e.target, note: e.note || "",
          sourceLanguage: e.sourceLanguage || e.src_lng || "ko",
          targetLanguage: e.targetLanguage || e.tgtLng || e.tgt_lng || "zh-CN",
          enabled: e.enabled !== false, scope: e.scope || e.scope_type,
          scopeKey: e.scopeKey || e.scope_key, scopeLabel: e.scopeLabel || e.scope_label,
          libraryId: e.libraryId || e.library_id || runtime.glossaryCore.DEFAULT_LIBRARY_ID
        }))
      });
      await runtime.storageSet({
        [runtime.glossaryCore.STORAGE_KEY]: runtime.glossary
      });
      if (data.revision) runtime.setSyncRevision(Number(data.revision));
      runtime.renderGlossary();
      runtime.renderLibraryPanel();
      // 服务端还缺的库定义补齐（含首次升级的服务端迁移），失败只提示不回滚本地。
      const missingOnServer = serverLibraries
        ? localState.libraries.filter(local => !serverLibraries.some(item => item.id === local.id))
        : localState.libraries;
      if (missingOnServer.length) {
        const synced = await runtime.syncLibrariesToServer(missingOnServer).catch(() => 0);
        if (synced < missingOnServer.length) {
          runtime.setLibraryStatus("术语库定义暂未同步到本地服务：请重启本地 OCR 服务后再试", true);
        }
      }
      const migratedNote = pushed > 0 ? `，并补齐本地旧术语 ${pushed} 条` : missing.length ? `，本地旧术语 ${missing.length} 条未同步（已保留）` : "";
      runtime.setStatus(`已从服务加载 ${data.total || runtime.glossary.entries.length} 条术语，${runtime.glossary.libraries.length} 个术语库${migratedNote} (修订 ${runtime.getSyncRevision().toFixed(1)})`, false);
      return { ok: true, entries: runtime.glossary.entries };
    } catch (error) {
      runtime.setStatus(`加载失败：${runtime.getErrorMessage(error)}`, true);
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.loadGlossaryFromServer = loadGlossaryFromServer;
  async function saveEntryToServer(source, target, tgtLng, note, enabled, entryId, scope = {}) {
    try {
      serverBaseUrl = await resolveServerBaseUrl();
      const body = { source: source.trim(), target: target.trim(), tgt_lng: tgtLng || "zh-CN" };
      const stored = await runtime.storageGet(["mt_translation_config_v1"]);
      body.src_lng = stored.mt_translation_config_v1?.sourceLanguage === "auto"
        ? "ko" : stored.mt_translation_config_v1?.sourceLanguage || "ko";
      if (note) body.note = note.trim();
      body.enabled = enabled !== false;
      body.scope_type = scope.scope === "work" ? "work" : "global";
      body.scope_key = body.scope_type === "work" ? String(scope.scopeKey || "") : "";
      body.scope_label = body.scope_type === "work" ? String(scope.scopeLabel || "") : "";
      body.library_id = runtime.glossaryCore.normalizeLibraryId(scope.libraryId) || runtime.glossaryCore.DEFAULT_LIBRARY_ID;
      body.library_name = runtime.glossaryCore.getLibraryName(runtime.glossary, body.library_id);
      if (entryId && !entryId.startsWith("term-new-")) body.id = entryId;
      const resp = await fetch(`${serverBaseUrl}/glossary`, {
        method: "PUT",
        headers: await getServiceHeaders(true),
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "保存失败");
      const savedEntry = data.entry || {};
      // Refresh local revision
      try {
        const healthResp = await fetch(`${serverBaseUrl}/glossary/health`, {
          headers: await getServiceHeaders()
        });
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
      const resp = await fetch(`${serverBaseUrl}/glossary/${encodeURIComponent(entryId)}`, {
        method: "DELETE", headers: await getServiceHeaders()
      });
      if (resp.status === 404) return { ok: true };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.deleteEntryFromServer = deleteEntryFromServer;
  // ── end server sync ──
  async function persistEntries(entries, message) {
    const previousIds = runtime.glossary.entries.map(entry => entry.id);
    const next = runtime.glossaryCore.normalizeGlossary({
      version: runtime.glossaryCore.SCHEMA_VERSION,
      revision: runtime.glossary.revision + 1,
      updatedAt: Date.now(),
      libraries: runtime.glossary.libraries,
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
      runtime.renderLibraryPanel();
      runtime.renderPendingState();
      runtime.setStatus(message, false);
      // Sync to server in background
      let failedDeletes = 0;
      try {
        serverBaseUrl = await resolveServerBaseUrl();
        const nextIds = new Set(next.entries.map(entry => entry.id));
        // 先删掉本地已移除的条目，避免下次从服务端加载时"复活"。
        for (const id of previousIds.filter(id => !nextIds.has(id))) {
          const deleted = await runtime.deleteEntryFromServer(id).catch(() => ({ ok: false }));
          if (!deleted || deleted.ok === false) {
            failedDeletes += 1;
          }
        }
        const batchEntries = next.entries.map(e => ({
          id: e.id,
          source: e.source, target: e.target, note: e.note || "", enabled: e.enabled !== false,
          src_lng: e.sourceLanguage, tgt_lng: e.targetLanguage,
          scope_type: e.scope, scope_key: e.scopeKey, scope_label: e.scopeLabel,
          library_id: e.libraryId,
          library_name: runtime.glossaryCore.getLibraryName(next, e.libraryId)
        }));
        const resp = await fetch(`${serverBaseUrl}/glossary/batch`, {
          method: "POST",
          headers: await getServiceHeaders(true),
          body: JSON.stringify({ entries: batchEntries, tgt_lng: "zh-CN" })
        });
        const data = await resp.json();
        if (data.ok || data.added > 0 || data.updated > 0) {
          runtime.setSyncRevision(data.revision || Date.now() / 1000);
        }
      } catch (_) {
        // Server sync is best-effort
      }
      // 删除只做在本地是不够的：服务端没删掉，下次 loadGlossaryFromServer 会把它们原样拉回来。
      // 这种情况必须报出来，不能让界面停在「已删除」上骗人。
      if (failedDeletes) {
        setStatus(`术语删除失败：${failedDeletes} 条术语未从本地服务删除，刷新后会重新出现`, true);
      }
      return { ok: true, failedDeletes };
    } catch (error) {
      runtime.setStatus(`保存失败：${runtime.getErrorMessage(error)}`, true);
      await runtime.loadGlossary();
      return { ok: false, failedDeletes: 0 };
    }
  }
  runtime.persistEntries = persistEntries;
  // 说明行按设计稿删掉了：状态条只在有真反馈（保存/删除/导入成败）时出现，平时整条藏起
  function setStatus(message, isError) {
    runtime.statusText.textContent = message;
    runtime.statusText.dataset.error = isError ? "true" : "false";
    document.getElementById("statusSummary")?.classList.toggle("hidden", !message);
  }
  runtime.setStatus = setStatus;
  function setPendingStatus(message, isError) {
    runtime.pendingStatusText.textContent = message;
    runtime.pendingStatusText.dataset.error = isError ? "true" : "false";
    const summary = document.getElementById("pendingStatusSummary");
    summary?.classList.toggle("hidden", !message);
    // 候选卡可能滚在下面：报错时把那行提示带进视野，别让它停在屏幕外当成「没反应」。
    if (message && isError) summary?.scrollIntoView?.({ block: "nearest" });
  }
  runtime.setPendingStatus = setPendingStatus;
  function getErrorMessage(error) {
    return error && error.message ? error.message : String(error || "未知错误");
  }
  runtime.getErrorMessage = getErrorMessage;
  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, result => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result || {});
      });
    });
  }
  runtime.storageGet = storageGet;
  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(value, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }
  runtime.storageSet = storageSet;
  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response || null);
      });
    });
  }
  runtime.sendRuntimeMessage = sendRuntimeMessage;
}
