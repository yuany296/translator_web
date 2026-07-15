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
  async function handleStartLocalOcr() {
    try {
      const resp = await fetch("http://127.0.0.1:8765/health", {
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
      const resp = await fetch("http://127.0.0.1:8765/health", {
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
    const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryStorage, runtime.STORAGE_KEYS.localOcrBaseUrl]);
    return stored[runtime.STORAGE_KEYS.glossaryStorage] === "server" ? stored[runtime.STORAGE_KEYS.localOcrBaseUrl] || runtime.DEFAULT_LOCAL_OCR_BASE_URL : "";
  }
  runtime.isGlossaryServerMode = isGlossaryServerMode;
}
