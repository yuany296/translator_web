export function installTermDiscovery(runtime) {
  /**
   * 用户为某个章节手动指定术语库（留空表示回到"按网址自动匹配"）。
   * 手动指定会被标记，之后同一章节再次察觉术语时不会覆盖。
   */
  async function handleSetPendingChapterLibrary(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending]);
      const store = runtime.termDiscoveryCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
      const chapterKey = runtime.termDiscoveryCore.getChapterKey(String(message.chapterKey || message.url || ""));
      const chapter = store.chapters.find(item => item.key === chapterKey);
      if (!chapter) {
        return { ok: false, error: "未找到该章节的待确认记录" };
      }
      chapter.libraryId = runtime.glossaryCore.normalizeLibraryId(message.libraryId);
      chapter.libraryManual = Boolean(chapter.libraryId);
      store.updatedAt = Date.now();
      await runtime.storageSet({ [runtime.STORAGE_KEYS.glossaryPending]: store });
      return {
        ok: true,
        pending: store,
        pendingCount: runtime.termDiscoveryCore.getPendingCount(store)
      };
    });
  }
  runtime.handleSetPendingChapterLibrary = handleSetPendingChapterLibrary;
  async function handleRestoreIgnoredTerm(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryIgnored]);
      const ignored = runtime.termDiscoveryCore.restoreIgnoredSource(stored[runtime.STORAGE_KEYS.glossaryIgnored], message.source);
      await runtime.storageSet({
        [runtime.STORAGE_KEYS.glossaryIgnored]: ignored
      });
      return {
        ok: true
      };
    });
  }

  // ── OCR Service (health check only) ─────────────────────────────
  runtime.handleRestoreIgnoredTerm = handleRestoreIgnoredTerm;
  async function handleResetTermDiscoveryProcessed() {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending]);
      const store = runtime.termDiscoveryCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
      for (const chapter of store.chapters) {
        chapter.processedEvidenceIds = [];
      }
      store.updatedAt = Date.now();
      await runtime.storageSet({
        [runtime.STORAGE_KEYS.glossaryPending]: store
      });
      return {
        ok: true,
        chapters: store.chapters.length
      };
    });
  }
  runtime.handleResetTermDiscoveryProcessed = handleResetTermDiscoveryProcessed;
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
  function markTermExtractorOnline(engine = "", now = Date.now()) {
    runtime.termExtractorRuntime = {
      state: "online",
      engine: String(engine || "").slice(0, 40),
      error: "",
      checkedAt: now,
      cooldownUntil: 0
    };
  }
  runtime.markTermExtractorOnline = markTermExtractorOnline;
  function markTermExtractorOffline(error, engine = "", now = Date.now(), cooldownMs = runtime.TERM_EXTRACTOR_COOLDOWN_MS) {
    runtime.termExtractorRuntime = {
      state: "offline",
      engine: String(engine || "").slice(0, 40),
      error: runtime.getErrorMessage(error) || "术语提取器离线",
      checkedAt: now,
      cooldownUntil: now + Math.max(0, Number(cooldownMs) || 0)
    };
  }
  runtime.markTermExtractorOffline = markTermExtractorOffline;
  /**
   * 这次提取请求该给多少预算。
   *
   * 服务端把整章拼成正文（原文 + 译文行）按 3000 字符切段，逐段串行调用 LLM，
   * 所以耗时基本与段数成正比。固定 600 秒时，段数多的大章节「还在正常跑」就被
   * 扩展判成超时、结果整份丢掉，再叠一次冷却 —— 表现就是没有收集到术语。
   */
  function termExtractionTimeoutMs(blocks) {
    const chars = (Array.isArray(blocks) ? blocks : []).reduce((total, block) => total
      + String(block && block.originalText || "").length
      + String(block && block.translatedText || "").length, 0);
    const chunks = Math.max(1, Math.ceil(chars / runtime.TERM_EXTRACTOR_CHUNK_CHARS));
    const budget = chunks * runtime.TERM_EXTRACTOR_CHUNK_BUDGET_MS;
    return Math.min(runtime.TERM_EXTRACTOR_MAX_TIMEOUT_MS,
      Math.max(runtime.TERM_EXTRACTOR_MIN_LLM_TIMEOUT_MS, budget));
  }
  runtime.termExtractionTimeoutMs = termExtractionTimeoutMs;
  async function probeTermExtractor(baseUrlValue, termExtraction = null) {
    const now = Date.now();
    if (runtime.termExtractorRuntime.checkedAt > 0 && now - runtime.termExtractorRuntime.checkedAt < runtime.TERM_EXTRACTOR_HEALTH_CACHE_MS) {
      return runtime.getTermExtractorStatusSnapshot();
    }
    const baseUrl = runtime.sanitizeLocalOcrBaseUrl(baseUrlValue || runtime.DEFAULT_LOCAL_OCR_BASE_URL);
    const llmBaseUrl = String(termExtraction && termExtraction.baseUrl || "").trim();
    const query = llmBaseUrl
      ? `?base_url=${encodeURIComponent(llmBaseUrl)}&api_key=${encodeURIComponent(String(termExtraction && termExtraction.apiKey || "").trim())}`
      : "";
    try {
      const payload = await runtime.requestTermExtractorJson(`${baseUrl}/terms/health${query}`, {
        method: "GET"
      });
      if (!payload || payload.ok !== true || payload.available === false) {
        throw new Error(String(payload && payload.error || "术语提取器不可用"));
      }
      runtime.markTermExtractorOnline(payload.engine);
    } catch (error) {
      runtime.markTermExtractorOffline(error, "ollama");
    }
    return runtime.getTermExtractorStatusSnapshot();
  }
  runtime.probeTermExtractor = probeTermExtractor;
  async function requestTermExtractorJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutValue = Math.max(1, Number(timeoutMs) || runtime.TERM_EXTRACTOR_TIMEOUT_MS);
    const timeoutId = setTimeout(() => controller.abort(), timeoutValue);
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
        const timeout = new Error("术语提取请求超时");
        // 打标记：调用方要区分「这次太慢」和「提取器坏了」，前者不该吃 5 分钟冷却。
        timeout.timeout = true;
        throw timeout;
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
}
