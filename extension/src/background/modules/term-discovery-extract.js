import { resolveExtractionConfig } from "../../config/store.js";
import reportCore from "../../shared/term-discovery-report.js";

/**
 * 整章术语提取：把「排队阶段」和「慢 HTTP 阶段」拆开。
 *
 * 事故背景：整条链路（含 LLM 上游请求，超时 {@link runtime.TERM_EXTRACTOR_LLM_TIMEOUT_MS}）
 * 原本都跑在 `enqueueTermDiscoveryMutation` 那条串行队列里。上游一挂，队列后面所有
 * 用户操作（术语库页「确认加入」/「本话忽略」、章节归属下拉）都拿不到后台回话，
 * 页面端又没有超时 —— 表现就是「按钮点不动」，重载扩展才恢复。
 *
 * 现在分三段：
 *   1. 准备（用户操作同一条队列，快）：读状态、写自动忽略、去重与节流，产出请求正文；
 *   2. 提取（单独的提取队列，慢）：HTTP 请求串行跑，但不挡用户操作；
 *   3. 合并（用户操作同一条队列，快）：合并前重新读一遍状态，
 *      免得用提取前的旧快照把用户刚确认/忽略的条目盖回去。
 */
export function installTermDiscoveryExtract(runtime) {
  /** 术语提取的有效配置：配置库选定条目（旧存档仍按「跟随翻译服务」解析）。 */
  function termLlmConfig(configuration) {
    return resolveExtractionConfig(configuration, "termExtraction");
  }
  runtime.termLlmConfig = termLlmConfig;
  /** 提取请求单独排一条队列：上游仍串行（别并发压垮本地模型），但不占用户操作的队列。 */
  function enqueueExtraction(task) {
    const running = runtime.termDiscoveryExtractionQueue.then(task, task);
    runtime.termDiscoveryExtractionQueue = running.catch(() => undefined);
    return running;
  }
  runtime.enqueueTermExtraction = enqueueExtraction;
  function discoveryRequestBody(configuration, store, blocks, upstream) {
    return {
      mode: "balanced",
      blocks: blocks.map(block => ({
        id: block.id,
        text: block.originalText,
        translatedText: block.translatedText
      })),
      user_terms: [
        ...configuration.glossary.entries.map(entry => entry.source),
        ...store.chapters.flatMap(chapter => chapter.candidates)
          .filter(candidate => candidate.kind === "person")
          .map(candidate => candidate.source)
      ].slice(0, 200),
      upstream,
      target_language: String(configuration.translation.targetLanguage || "zh-CN")
    };
  }
  /** 一段：排队做快速准备。返回 `skip` 表示这次不用提取。 */
  async function prepareDiscovery(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const configuration = await runtime.loadConfiguration();
      const stored = await runtime.storageGet([
        runtime.STORAGE_KEYS.glossaryPending,
        runtime.STORAGE_KEYS.glossaryIgnored
      ]);
      if (configuration.runtime.termDiscoveryEnabled === false) {
        return { skip: "disabled" };
      }
      const pageUrl = String(message.pageUrl || "").trim();
      const targetKey = String(message.targetKey || "").trim();
      // 网址归库：命中已启用术语库的页面，候选自动进入该库（未命中则为空，界面按默认库处理）。
      const matched = runtime.glossaryCore.matchLibraryByUrl(configuration.glossary.libraries, pageUrl);
      const libraryId = matched ? matched.libraryId : "";
      // 自动忽略来源（小说名等）先于冷却/去重早退写入，保证提取器离线时也生效。
      const autoIgnored = await runtime.applyAutoIgnoreSources(stored, message.autoIgnoreSources, pageUrl);
      const blocks = runtime.termDiscoveryCore.getUnprocessedBlocks(
        autoIgnored.store, pageUrl, message.blocks, targetKey
      );
      if (blocks.length === 0) {
        return { skip: "already_processed" };
      }
      if (runtime.isTermExtractorCoolingDown()) {
        return { skip: "cooldown", status: runtime.getTermExtractorStatusSnapshot() };
      }
      // 漫画连续翻页时同一章节 30 秒内只提取一次。
      const now = Date.now();
      const lastByPage = runtime.termExtractorLastExtractByPage || new Map();
      if (now - (lastByPage.get(pageUrl) || 0) < runtime.TERM_EXTRACTOR_THROTTLE_MS) {
        return { skip: "throttled" };
      }
      lastByPage.set(pageUrl, now);
      if (lastByPage.size > 100) {
        lastByPage.delete(lastByPage.keys().next().value);
      }
      runtime.termExtractorLastExtractByPage = lastByPage;
      const termLlm = termLlmConfig(configuration);
      const upstream = {
        baseUrl: String(termLlm.baseUrl || "").trim(),
        model: String(termLlm.model || "").trim(),
        apiKey: String(termLlm.apiKey || "").trim()
      };
      return {
        pageUrl,
        pageTitle: message.pageTitle,
        targetKey,
        libraryId,
        blocks,
        llmMode: Boolean(upstream.baseUrl),
        baseUrl: runtime.sanitizeLocalOcrBaseUrl(configuration.ocr.localPaddle.baseUrl),
        requestBody: discoveryRequestBody(configuration, autoIgnored.store, blocks, upstream)
      };
    });
  }
  runtime.prepareDiscovery = prepareDiscovery;
  /** 二段：慢请求走提取队列，成功返回 `{ payload }`，失败返回 `{ error, timedOut }`。 */
  async function requestDiscovery(prepared) {
    try {
      const payload = await enqueueExtraction(() => runtime.requestTermExtractorJson(
        `${prepared.baseUrl}/terms/extract`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prepared.requestBody)
        },
        prepared.llmMode ? runtime.termExtractionTimeoutMs(prepared.blocks) : runtime.TERM_EXTRACTOR_TIMEOUT_MS
      ));
      runtime.markTermExtractorOnline(payload && payload.engine);
      return { payload };
    } catch (error) {
      const timedOut = Boolean(error && error.timeout === true);
      // 超时只罚一分钟（内容脚本 30 秒后本来就会重试），别用 5 分钟冷却把后面几章一起罚掉。
      runtime.markTermExtractorOffline(error, "", Date.now(),
        timedOut ? runtime.TERM_EXTRACTOR_TIMEOUT_COOLDOWN_MS : undefined);
      console.warn("[MangaTranslator] 术语提取器暂时不可用：", runtime.getErrorMessage(error));
      return { error, timedOut };
    }
  }
  runtime.requestDiscovery = requestDiscovery;
  /** 三段：排队合并进待确认仓库（只碰存储，不发网络请求）。
   *  `options.processedBlockIds` 覆盖「哪些段落算已处理」：桌面整趟要么全成要么全败，
   *  默认（全部块）就是对的；手机端分段容错，只把真的跑出结果的分段覆盖的块传进来。 */
  async function mergeDiscovery(prepared, payload, options = {}) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const [configuration, stored] = await Promise.all([
        runtime.loadConfiguration(),
        runtime.storageGet([
          runtime.STORAGE_KEYS.glossaryPending,
          runtime.STORAGE_KEYS.glossaryIgnored
        ])
      ]);
      const store = runtime.termDiscoveryCore.normalizePendingStore(
        stored[runtime.STORAGE_KEYS.glossaryPending]
      );
      const nextPending = runtime.termDiscoveryCore.mergeDiscoveryResult({
        store,
        ignored: runtime.termDiscoveryCore.normalizeIgnoredStore(stored[runtime.STORAGE_KEYS.glossaryIgnored]),
        glossary: configuration.glossary,
        pageUrl: prepared.pageUrl,
        pageTitle: prepared.pageTitle,
        targetKey: prepared.targetKey,
        libraryId: prepared.libraryId,
        blocks: prepared.blocks,
        processedBlockIds: Array.isArray(options.processedBlockIds) ? options.processedBlockIds : null,
        extractedCandidates: payload && payload.candidates
      });
      await runtime.storageSet({ [runtime.STORAGE_KEYS.glossaryPending]: nextPending });
      return {
        ok: true,
        added: runtime.termDiscoveryCore.getPendingCount(nextPending)
          - runtime.termDiscoveryCore.getPendingCount(store),
        // 提取器这次到底给了几条：added 为 0 时用它区分「没提取到」和「都被去重掉了」。
        returned: Array.isArray(payload && payload.candidates) ? payload.candidates.length : 0,
        libraryId: prepared.libraryId,
        pendingCount: runtime.termDiscoveryCore.getPendingCount(nextPending),
        status: runtime.getTermExtractorStatusSnapshot()
      };
    });
  }
  runtime.mergeDiscovery = mergeDiscovery;
  /**
   * 记下最近一次自动提取的结果。
   *
   * 以前提取失败/被跳过是完全静默的：页面只显示「提取器在线」，用户看到的是
   * 「我翻了两章，一条术语都没收集到」而没有任何线索。现在把结果（成功几条、
   * 跳过原因、失败原因）落盘，术语库页待确认标签会把最近一次结果写出来。
   * 手机版也用同一份实现（见 shared/term-discovery-report.js）。
   */
  async function recordDiscovery(outcome) {
    await reportCore.recordTermDiscoveryOutcome(runtime, outcome);
  }
  runtime.recordDiscovery = recordDiscovery;
  async function runTermDiscovery(message) {
    const prepared = await prepareDiscovery(message);
    if (prepared.skip) {
      await recordDiscovery({ outcome: "skipped", reason: prepared.skip });
      return { ok: true, skipped: true, reason: prepared.skip, status: prepared.status };
    }
    const startedAt = Date.now();
    const budgetMs = prepared.llmMode
      ? runtime.termExtractionTimeoutMs(prepared.blocks)
      : runtime.TERM_EXTRACTOR_TIMEOUT_MS;
    // 开始就记账：请求挂住时页面能显示「正在提取（已 N 分钟）」，而不是一片空白。
    await recordDiscovery({
      outcome: "running",
      startedAt,
      budgetMs,
      pageUrl: prepared.pageUrl,
      pageTitle: prepared.pageTitle
    });
    const extraction = await requestDiscovery(prepared);
    if (!extraction.payload) {
      await recordDiscovery({
        outcome: "failed",
        // 超时与被拒绝分开记：前者是「这次太慢」，后者多半是配置/网络问题。
        reason: extraction.timedOut ? "timeout" : "offline",
        startedAt,
        budgetMs,
        error: runtime.getTermExtractorStatusSnapshot().error
      });
      // 返回给内容脚本的 reason 保持 "offline"：它在自动重试白名单里，
      // 改成别的会让「等会儿自己再试一次」这条恢复路径失效。
      return { ok: true, skipped: true, reason: "offline", status: runtime.getTermExtractorStatusSnapshot() };
    }
    const merged = await mergeDiscovery(prepared, extraction.payload);
    await recordDiscovery({
      outcome: "added",
      // 提取器返回了候选但一条都没进待确认（都在术语库里/被忽略）：也要说清楚，
      // 否则看起来就是「收集失灵」。
      reason: merged.added > 0 ? "added" : "no_new_candidates",
      startedAt,
      budgetMs,
      returned: merged.returned,
      added: merged.added,
      // 模型给了但被校验丢掉的条数与原因（kind 非法 / 原文里找不到 / schema 不符）：
      // 「术语老漏」时靠它区分「模型没给」和「给了又被丢」。
      dropped: extraction.payload.dropped && typeof extraction.payload.dropped === "object"
        ? extraction.payload.dropped
        : null
    });
    return merged;
  }
  runtime.runTermDiscovery = runTermDiscovery;
}
