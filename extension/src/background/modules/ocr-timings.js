/**
 * OCR 计时观测：把本地 OCR 服务返回的分阶段耗时与扩展侧的总耗时接到同一条日志上。
 *
 * 背景：漫画每页的延迟分散在「排队 / 检测 / 裁剪 / 识别 / 外观分析 / debug 写盘 / LLM 翻译」
 * 多个环节，单看总时长无法判断该优化哪一段。这里只做观测，不改变任何 OCR 行为。
 */
export function installOcrTimings(runtime) {
  const MAX_SAMPLES = 200;
  const samples = [];
  let pendingService = null;

  function percentile(values, ratio) {
    const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    if (list.length === 0) return 0;
    const index = Math.round((list.length - 1) * Math.min(1, Math.max(0, Number(ratio) || 0)));
    return list[index];
  }
  runtime.ocrTimingPercentile = percentile;

  function round(value, digits = 1) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function isEnabled() {
    return runtime.state?.ocrTimingsEnabled !== false;
  }

  function topPhases(phases, limit = 4) {
    return Object.entries(phases && typeof phases === "object" ? phases : {})
      .map(([name, value]) => ({ name, ms: round(value) }))
      .sort((left, right) => right.ms - left.ms)
      .slice(0, Math.max(1, limit));
  }

  function emptyPhases(phases) {
    return !phases || typeof phases !== "object" || Object.keys(phases).length === 0;
  }

  /** 服务端 /ocr 响应里的 timings（与扩展侧请求一一对应）。 */
  function recordOcrServiceTimings(input = {}) {
    try {
      const timings = input.timings;
      if (!isEnabled() || emptyPhases(timings?.phases)) return null;
      pendingService = {
        at: Date.now(),
        debugId: String(input.debugId || ""),
        lang: String(input.lang || ""),
        mode: String(input.mode || ""),
        counts: input.counts && typeof input.counts === "object" ? input.counts : null,
        timings
      };
      return pendingService;
    } catch {
      return null;
    }
  }
  runtime.recordOcrServiceTimings = recordOcrServiceTimings;

  /** 扩展侧一次 OCR（含本地服务往返）的总耗时与缓存命中情况。 */
  function recordOcrPipelineTimings(input = {}) {
    try {
      if (!isEnabled()) return null;
      const service = pendingService && Date.now() - pendingService.at <= 60000 ? pendingService : null;
      pendingService = null;
      const entry = {
        at: Date.now(),
        totalMs: round(input.totalMs),
        providerMs: round(input.providerMs),
        cached: input.cached === true,
        sourceType: String(input.sourceType || "page"),
        pages: Array.isArray(input.pageIds) ? input.pageIds.length : 0,
        service: service ? { debugId: service.debugId, lang: service.lang, mode: service.mode, counts: service.counts, timings: service.timings } : null
      };
      samples.push(entry);
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
      // 缓存命中时 provider 耗时为 0，只有真正调用服务端时才有分阶段数据可看。
      const phases = entry.service?.timings?.phases || {};
      console.info("[MangaTranslator][ocr-timing]", {
        cached: entry.cached,
        totalMs: entry.totalMs,
        providerMs: entry.providerMs,
        serviceTotalMs: entry.service?.timings?.totalMs ?? null,
        queueWaitMs: phases.queueWait ?? null,
        unaccountedMs: entry.service?.timings?.unaccountedMs ?? null,
        top: topPhases(phases),
        counts: entry.service?.counts || null
      });
      return entry;
    } catch {
      return null;
    }
  }
  runtime.recordOcrPipelineTimings = recordOcrPipelineTimings;

  function summarizeOcrTimings() {
    const totals = samples.filter(entry => !entry.cached).map(entry => entry.totalMs);
    const provider = samples.filter(entry => !entry.cached).map(entry => entry.providerMs);
    const phaseNames = [];
    for (const entry of samples) {
      for (const name of Object.keys(entry.service?.timings?.phases || {})) {
        if (!phaseNames.includes(name)) phaseNames.push(name);
      }
    }
    const phases = {};
    for (const name of phaseNames) {
      const values = samples.map(entry => Number(entry.service?.timings?.phases?.[name]) || 0);
      phases[name] = { p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)) };
    }
    return {
      count: samples.length,
      calls: totals.length,
      cachedCount: samples.length - totals.length,
      totalMs: { p50: round(percentile(totals, 0.5)), p95: round(percentile(totals, 0.95)) },
      providerMs: { p50: round(percentile(provider, 0.5)), p95: round(percentile(provider, 0.95)) },
      phases,
      last: samples[samples.length - 1] || null
    };
  }
  runtime.summarizeOcrTimings = summarizeOcrTimings;

  function resetOcrTimings() {
    samples.length = 0;
    pendingService = null;
  }
  runtime.resetOcrTimings = resetOcrTimings;

  function listOcrTimings() {
    return samples.map(entry => ({ ...entry }));
  }
  runtime.listOcrTimings = listOcrTimings;

  /** service worker 控制台里一行拿到分阶段统计：__mtOcrTimings() */
  function exposeConsoleHelper() {
    try {
      const scope = typeof globalThis === "undefined" ? null : globalThis;
      if (!scope || scope.__mtOcrTimings) return;
      scope.__mtOcrTimings = () => summarizeOcrTimings();
      scope.__mtOcrTimingsReset = () => resetOcrTimings();
    } catch {
      // 控制台助手只是便利设施，注册失败不影响计时
    }
  }
  runtime.exposeOcrTimingsConsoleHelper = exposeConsoleHelper;

  /**
   * OCR_DATA_URL 的统一观测入口：不改变 ocr-pipeline 的返回结构，
   * 只在返回后补一条「扩展侧总耗时 + 服务端分阶段」的日志。
   */
  async function handleOcrDataUrlWithTimings(message) {
    const startedAt = Date.now();
    const response = await runtime.handleOcrDataUrl(message);
    try {
      const timing = response && response.timing && typeof response.timing === "object" ? response.timing : {};
      runtime.recordOcrPipelineTimings({
        totalMs: timing.totalMs ?? Date.now() - startedAt,
        providerMs: timing.providerMs ?? 0,
        cached: response?.cached === true,
        sourceType: message && message.sourceType,
        pageIds: message && message.pageIds
      });
    } catch {
      // 观测失败不得影响 OCR 结果
    }
    return response;
  }
  runtime.handleOcrDataUrlWithTimings = handleOcrDataUrlWithTimings;
}
