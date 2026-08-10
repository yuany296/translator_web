export function installTermDiscovery(runtime) {
  async function handleRestoreIgnoredTerm(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryIgnored]);
      const ignored = runtime.termDiscoveryCore.restoreIgnoredSource(stored[runtime.STORAGE_KEYS.glossaryIgnored], message.source);
      await runtime.storageSet({
        [runtime.STORAGE_KEYS.glossaryIgnored]: ignored
      });
      // 服务端同步
      try {
        const serverUrl = await runtime.isGlossaryServerMode();
        if (serverUrl) {
          await runtime.callGlossaryApi(serverUrl, "/glossary/ignored/restore", {
            method: "POST",
            body: JSON.stringify({
              source: message.source
            })
          }).catch(() => {});
        }
      } catch (_) {}
      return {
        ok: true
      };
    });
  }

  // ── OCR Service (health check only) ─────────────────────────────
  runtime.handleRestoreIgnoredTerm = handleRestoreIgnoredTerm;
  async function handleIgnoreTermCandidates(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const entries = (Array.isArray(message.entries) ? message.entries : []).slice(0, 500).map(entry => ({
        chapterKey: String(entry && entry.chapterKey || ""),
        source: String(entry && entry.source || "").trim()
      })).filter(entry => entry.source);
      if (entries.length === 0) {
        return {
          ok: false,
          error: "没有可忽略的候选术语"
        };
      }
      const scope = message.scope === "global" ? "global" : "chapter";
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending, runtime.STORAGE_KEYS.glossaryIgnored]);
      const next = runtime.termDiscoveryCore.ignoreCandidates({
        store: stored[runtime.STORAGE_KEYS.glossaryPending],
        ignored: stored[runtime.STORAGE_KEYS.glossaryIgnored],
        entries,
        scope
      });
      await runtime.storageSet({
        [runtime.STORAGE_KEYS.glossaryPending]: next.store,
        [runtime.STORAGE_KEYS.glossaryIgnored]: next.ignored
      });
      // 服务端同步（global 时逐条）
      try {
        const serverUrl = await runtime.isGlossaryServerMode();
        if (serverUrl && scope === "global") {
          for (const entry of entries) {
            await runtime.callGlossaryApi(serverUrl, "/glossary/pending/ignore", {
              method: "POST",
              body: JSON.stringify({
                source: entry.source
              })
            }).catch(() => {});
          }
        }
      } catch (_) {}
      return {
        ok: true,
        removed: next.removed,
        pendingCount: runtime.termDiscoveryCore.getPendingCount(next.store)
      };
    });
  }
  runtime.handleIgnoreTermCandidates = handleIgnoreTermCandidates;
  async function applyAutoIgnoreSources(stored, autoIgnoreSourcesValue, chapterKey) {
    let store = runtime.termDiscoveryCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
    let ignored = runtime.termDiscoveryCore.normalizeIgnoredStore(stored[runtime.STORAGE_KEYS.glossaryIgnored]);
    const sources = (Array.isArray(autoIgnoreSourcesValue) ? autoIgnoreSourcesValue : [])
      .map(source => String(source || "").trim()).filter(Boolean).slice(0, 20);
    const newlyIgnored = [];
    for (const source of sources) {
      const sourceKey = runtime.termDiscoveryCore.getSourceKey(source);
      if (sourceKey && !ignored.sources.some(item => item.sourceKey === sourceKey)) {
        newlyIgnored.push(source);
      }
      const next = runtime.termDiscoveryCore.ignoreCandidate({
        store,
        ignored,
        chapterKey,
        source,
        scope: "global"
      });
      store = next.store;
      ignored = next.ignored;
    }
    if (newlyIgnored.length) {
      await runtime.storageSet({
        [runtime.STORAGE_KEYS.glossaryPending]: store,
        [runtime.STORAGE_KEYS.glossaryIgnored]: ignored
      });
      // 服务端同步（全局忽略）
      try {
        const serverUrl = await runtime.isGlossaryServerMode();
        if (serverUrl) {
          for (const source of newlyIgnored) {
            await runtime.callGlossaryApi(serverUrl, "/glossary/pending/ignore", {
              method: "POST",
              body: JSON.stringify({
                source
              })
            }).catch(() => {});
          }
        }
      } catch (_) {}
    }
    return {
      store,
      ignored
    };
  }
  runtime.applyAutoIgnoreSources = applyAutoIgnoreSources;
  async function handleStartLocalOcr() {
    try {
      const configuration = await runtime.loadConfiguration();
      const baseUrl = runtime.sanitizeLocalOcrBaseUrl(configuration.ocr.localPaddle.baseUrl);
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      if (resp.ok) return {
        ok: true,
        status: "already_running"
      };
    } catch (_) {}
    return {
      ok: false,
      error: "请先手动运行 start_local_ocr_gpu.bat 启动 OCR 服务"
    };
  }
  runtime.handleStartLocalOcr = handleStartLocalOcr;
  async function handleStopLocalOcr() {
    return {
      ok: true
    };
  }
  runtime.handleStopLocalOcr = handleStopLocalOcr;
  async function handlePingLocalOcr() {
    try {
      const configuration = await runtime.loadConfiguration();
      const baseUrl = runtime.sanitizeLocalOcrBaseUrl(configuration.ocr.localPaddle.baseUrl);
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return {
        ok: resp.ok
      };
    } catch (_) {
      return {
        ok: false
      };
    }
  }
  runtime.handlePingLocalOcr = handlePingLocalOcr;
  function enqueueTermDiscoveryMutation(task) {
    const running = runtime.termDiscoveryMutationQueue.then(task, task);
    runtime.termDiscoveryMutationQueue = running.catch(() => undefined);
    return running;
  }
  runtime.enqueueTermDiscoveryMutation = enqueueTermDiscoveryMutation;
  function isTermExtractorCoolingDown(now = Date.now()) {
    return runtime.termExtractorRuntime.state === "offline" && runtime.termExtractorRuntime.cooldownUntil > now;
  }
  runtime.isTermExtractorCoolingDown = isTermExtractorCoolingDown;
  function getTermExtractorStatusSnapshot() {
    return {
      ...runtime.termExtractorRuntime
    };
  }
  runtime.getTermExtractorStatusSnapshot = getTermExtractorStatusSnapshot;
  function markTermExtractorOnline(now = Date.now()) {
    runtime.termExtractorRuntime = {
      state: "online",
      error: "",
      checkedAt: now,
      cooldownUntil: 0
    };
  }
  runtime.markTermExtractorOnline = markTermExtractorOnline;
  function markTermExtractorOffline(error, now = Date.now()) {
    runtime.termExtractorRuntime = {
      state: "offline",
      error: runtime.getErrorMessage(error) || "术语提取器离线",
      checkedAt: now,
      cooldownUntil: now + runtime.TERM_EXTRACTOR_COOLDOWN_MS
    };
  }
  runtime.markTermExtractorOffline = markTermExtractorOffline;
  async function probeTermExtractor(baseUrlValue) {
    const now = Date.now();
    if (runtime.termExtractorRuntime.checkedAt > 0 && now - runtime.termExtractorRuntime.checkedAt < runtime.TERM_EXTRACTOR_HEALTH_CACHE_MS) {
      return runtime.getTermExtractorStatusSnapshot();
    }
    const baseUrl = runtime.sanitizeLocalOcrBaseUrl(baseUrlValue || runtime.DEFAULT_LOCAL_OCR_BASE_URL);
    try {
      const payload = await runtime.requestTermExtractorJson(`${baseUrl}/terms/health`, {
        method: "GET"
      });
      if (!payload || payload.ok !== true || payload.available === false) {
        throw new Error(String(payload && payload.error || "Kiwi 加载失败"));
      }
      runtime.markTermExtractorOnline();
    } catch (error) {
      runtime.markTermExtractorOffline(error);
    }
    return runtime.getTermExtractorStatusSnapshot();
  }
  runtime.probeTermExtractor = probeTermExtractor;
  async function requestTermExtractorJson(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), runtime.TERM_EXTRACTOR_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      const payload = await runtime.safeJson(response);
      if (!response.ok) {
        throw new Error(String(payload && (payload.detail || payload.error) || `HTTP ${response.status}`));
      }
      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("术语提取请求超时");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Glossary REST API helpers (for server-side storage via SQLite)
  runtime.requestTermExtractorJson = requestTermExtractorJson;
  async function callGlossaryApi(baseUrl, endpoint, options = {}) {
    const url = `${String(baseUrl || runtime.DEFAULT_LOCAL_OCR_BASE_URL).replace(/\/+$/, "")}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), runtime.GLOSSARY_API_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      });
      const payload = await runtime.safeJson(response);
      if (!response.ok) {
        throw new Error(String(payload && (payload.detail || payload.error) || `HTTP ${response.status}`));
      }
      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("术语 API 请求超时");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  runtime.callGlossaryApi = callGlossaryApi;
  async function isGlossaryServerMode() {
    const [configuration, stored] = await Promise.all([
      runtime.loadConfiguration(), runtime.storageGet([runtime.STORAGE_KEYS.glossaryStorage])
    ]);
    return stored[runtime.STORAGE_KEYS.glossaryStorage] === "server"
      ? configuration.ocr.localPaddle.baseUrl
      : "";
  }
  runtime.isGlossaryServerMode = isGlossaryServerMode;
}
