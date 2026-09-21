/**
 * 手机版后台覆盖层。
 *
 * 桌面版把「译文入库 / 术语提取 / 流式翻译 / 章节管理面板」都交给本地 Python 服务；
 * 手机上（Kiwi 等 Chromium 内核浏览器）没有本地服务，所以在 runtime 装配完成之后
 * 把这些入口换成纯本地实现。业务调用点都是 `runtime.X(...)`（晚绑定），因此这一步
 * 不需要改动任何现有文件。
 *
 * 唯一必须重新实现的是「整章术语提取」的 HTTP 步骤（原实现打本地服务
 * /terms/extract，提示词在 Python 里），见 term-extract-llm.js。
 */
import cacheCore from "../shared/translation-cache.js";
import reportCore from "../shared/term-discovery-report.js";
import { installTermExtractLlm } from "./term-extract-llm.js";
import { installGlossaryJudgementLocal } from "./glossary-judgement.js";
import { installTranslationGuardLocal } from "./translation-guard-local.js";
import { installTermUsageLocal } from "./term-usage-local.js";
import { installTermExtractQueue } from "./term-extract-queue.js";

const MAX_VERSIONS = 5;
const LOCAL_ONLY = "手机版不使用本地服务";

function emptyResult() {
  return { records: [], changeSeq: 0, results: [] };
}

function localServiceStatus() {
  return { ok: true, status: "local", error: "", records: [], changeSeq: 0, pendingConflicts: [] };
}

/** 记录基础字段与桌面版 snapshotToCacheRecord 对齐，保证缓存键与命中判定完全一致。 */
function buildRecordBase(operation, payload, existing) {
  const segmentKey = String(payload.segmentKey || "");
  const normalizedSourceHash = String(payload.normalizedSourceHash || payload.rawSourceHash || "");
  return {
    id: String(operation.recordKey || ""),
    mode: payload.mode === "webpage" || payload.mode === "comic" ? payload.mode : "novel",
    scopeKey: String(payload.scopeKey || ""),
    segmentKey,
    paragraphKey: segmentKey,
    workId: payload.workId,
    chapterId: payload.chapterId,
    sourceText: String(payload.rawSourceText || ""),
    normalizedSourceText: String(payload.normalizedSourceText || ""),
    sourceHash: normalizedSourceHash,
    rawSourceHash: String(payload.rawSourceHash || ""),
    normalizedSourceHash,
    configuredSourceLanguage: String(payload.configuredSourceLanguage || "auto"),
    resolvedSourceLanguage: String(payload.resolvedSourceLanguage || "auto"),
    targetLanguage: String(payload.targetLanguage || "zh-CN"),
    translationConfigFingerprint: String(payload.configFingerprint || ""),
    createdAt: Number(existing && existing.createdAt) || Date.now()
  };
}

/**
 * 本地提交：直接写扩展自己的 IndexedDB 缓存（桌面版由本地服务写 SQLite 再回灌）。
 * 返回结构与桌面版一致（`record.activeVersion.translatedText`），content 侧读取方式不变。
 */
async function commitLocalOperation(runtime, operation) {
  const recordKey = String(operation && operation.recordKey || "");
  const payload = operation && operation.payload || {};
  const translatedText = String(payload.translatedText || "").trim();
  if (!recordKey) return { ok: false, pending: false, error: "缺少 recordKey" };
  if (!translatedText) return { ok: false, pending: false, error: "译文为空" };
  const existing = await runtime.getTranslationCacheRecord(recordKey);
  const version = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    translatedText,
    source: "api",
    createdAt: Date.now(),
    pinned: false,
    manual: false,
    translationConfigFingerprint: String(payload.configFingerprint || "")
  };
  const previous = existing && Array.isArray(existing.versions) ? existing.versions : [];
  const base = buildRecordBase(operation, payload, existing);
  const record = cacheCore.buildRecordFromVersions(base.mode, base, [version, ...previous].slice(0, MAX_VERSIONS));
  if (!record) return { ok: false, pending: false, error: "无法构建译文记录" };
  const saved = await runtime.saveTranslationCacheRecords([record]);
  if (!saved || saved.ok !== true) {
    return { ok: false, pending: false, error: String(saved && saved.error || "写入译文缓存失败") };
  }
  return { ok: true, pending: false, record: { ...record, activeVersion: version } };
}

/** 提取用 LLM 是否已配置（默认「跟随翻译服务」，所以填了翻译 Key 就可用）。 */
async function hasExtractionLlm(runtime) {
  const configuration = await runtime.loadConfiguration();
  const llm = runtime.termLlmConfig ? runtime.termLlmConfig(configuration) : null;
  return Boolean(String(llm && llm.baseUrl || "").trim());
}

export function applyBackgroundLocal(runtime) {
  // ── 术语：从「硬约束」改成「模型按语境判断」（提示词 + 校验器两处一起换） ──
  installGlossaryJudgementLocal(runtime);
  // ── 请求出口补一条「整段都必须是目标语言」：防止术语/人名照抄原文 ──
  installTranslationGuardLocal(runtime);
  // ── 术语为什么没生效：随译文一起把结论回给内容脚本（手机上没 DevTools） ──
  installTermUsageLocal(runtime);

  // ── 译文入库：本地 IndexedDB，永不进入 pendingOperations 队列 ──
  runtime.commitOrQueueTranslationOperation = operation => commitLocalOperation(runtime, operation);

  // ── 译文库/本地服务状态：直接报本地，不做任何网络探测 ──
  runtime.getTranslationServiceStatus = async () => localServiceStatus();
  runtime.syncTranslationService = async () => localServiceStatus();
  runtime.flushPendingTranslationOperations = async () => ({ submitted: 0, remaining: 0, conflicts: [] });
  runtime.migrateLegacyTranslations = async () => ({ migrated: 0, skipped: true });

  // 这些入口内部调用的是模块私有函数而不是 runtime 属性，所以必须逐个覆盖，
  // 否则某条旁路仍会去连 127.0.0.1 并等满超时。
  runtime.queryTranslationService = async () => emptyResult();
  runtime.submitTranslationOperations = async () => ({ results: [] });
  runtime.importLegacyTranslations = async () => ({ results: [] });
  runtime.getTranslationVersions = async () => ({ ok: false, error: LOCAL_ONLY });
  runtime.exportTranslationLibrary = async () => ({ ok: false, error: LOCAL_ONLY });
  runtime.importTranslationLibrary = async () => ({ ok: false, error: LOCAL_ONLY });

  // ── 流式翻译端口 / 章节管理面板：手机版直接不支持 ──
  runtime.handleTranslationStreamPort = () => false;
  runtime.openNovelManageUi = async () => ({ ok: false, error: "手机版不提供章节译文管理面板" });

  // ── 术语提取：改直连 LLM ──
  installTermExtractLlm(runtime);
  runtime.isGlossaryServerMode = async () => "";
  runtime.probeTermExtractor = async () => {
    if (await hasExtractionLlm(runtime)) {
      runtime.markTermExtractorOnline("llm");
    } else {
      runtime.markTermExtractorOffline(new Error("未配置提取用 AI 服务"), "llm");
    }
    return runtime.getTermExtractorStatusSnapshot();
  };
  /**
   * 原实现三段：prepareDiscovery（写状态）→ requestDiscovery（打本地服务）→ mergeDiscovery（写候选）。
   * 这里保留一、三段，只把中间一步换成直连 LLM。
   *
   * 未配置提取服务时必须在 prepareDiscovery 之前返回 reason:"disabled"：content 侧只对
   * offline/cooldown/throttled 重试，disabled 不会进 40×30s 的重试循环。
   */
  // ── 整章提取：串行队列（对齐桌面 enqueueExtraction）+ 结果记账（对齐桌面 recordDiscovery）──
  installTermExtractQueue(runtime);
  runtime.runTermDiscovery = async message => {
    if (!await hasExtractionLlm(runtime)) {
      await reportCore.recordTermDiscoveryOutcome(runtime, { outcome: "skipped", reason: "disabled" });
      return { ok: true, skipped: true, reason: "disabled", status: runtime.getTermExtractorStatusSnapshot() };
    }
    const prepared = await runtime.prepareDiscovery(message);
    if (prepared.skip) {
      await reportCore.recordTermDiscoveryOutcome(runtime, { outcome: "skipped", reason: prepared.skip });
      return { ok: true, skipped: true, reason: prepared.skip, status: prepared.status };
    }
    // 队列满（多屏同时翻完）：不堆积，交回内容脚本的 30 秒重试，语义同桌面被节流挡下。
    if (runtime.isTermExtractQueueFull?.()) {
      await reportCore.recordTermDiscoveryOutcome(runtime, { outcome: "skipped", reason: "throttled" });
      return { ok: true, skipped: true, reason: "throttled", status: runtime.getTermExtractorStatusSnapshot() };
    }
    const startedAt = Date.now();
    await reportCore.recordTermDiscoveryOutcome(runtime, {
      outcome: "running",
      startedAt,
      pageUrl: prepared.pageUrl,
      pageTitle: prepared.pageTitle
    });
    const payload = await runtime.enqueueTermExtraction(
      () => runtime.requestChapterTermExtraction(prepared.requestBody)
    );
    if (!payload || payload.ok !== true) {
      // 超时只罚 60 秒（这次太慢），其它错误才 5 分钟 —— 与桌面 requestDiscovery 一致。
      const timedOut = payload && payload.timedOut === true;
      runtime.markTermExtractorOffline(
        new Error(String(payload && payload.error || "术语提取失败")), "llm", Date.now(),
        timedOut ? runtime.TERM_EXTRACTOR_TIMEOUT_COOLDOWN_MS : undefined
      );
      await reportCore.recordTermDiscoveryOutcome(runtime, {
        outcome: "failed",
        reason: timedOut ? "timeout" : "offline",
        startedAt,
        error: runtime.getTermExtractorStatusSnapshot().error
      });
      return { ok: true, skipped: true, reason: "offline", status: runtime.getTermExtractorStatusSnapshot() };
    }
    runtime.markTermExtractorOnline("llm");
    // 只有真的跑出结果的分段覆盖的块才记成「已处理」：分段超时/失败时若把整屏都标记，
    // 落在失败分段里的术语就永远不会再被提取（「待确认里有术语，但老漏」的真凶）。
    const partial = payload.partial && typeof payload.partial === "object" ? payload.partial : null;
    const covered = partial && Array.isArray(partial.coveredBlockIds) ? partial.coveredBlockIds : null;
    const merged = await runtime.mergeDiscovery(prepared, payload, covered ? { processedBlockIds: covered } : {});
    await runtime.syncPendingCandidates(prepared, payload);
    const returned = Array.isArray(payload.candidates) ? payload.candidates.length : 0;
    if (partial && Number(partial.failedChunks) > 0) {
      await reportCore.recordTermDiscoveryOutcome(runtime, {
        outcome: "partial",
        reason: "partial",
        startedAt,
        returned,
        added: Number(merged.added) || 0,
        failedChunks: Number(partial.failedChunks) || 0,
        totalChunks: Number(partial.totalChunks) || 0
      });
      return {
        ...merged,
        returned,
        // 内容脚本对 "partial" 与 offline/cooldown/throttled 一样会自动重试；
        // 没被标记已处理的那些块正好是这次缺的部分（见 shared/term-discovery.js#getUnprocessedBlocks）。
        reason: "partial",
        failedChunks: Number(partial.failedChunks) || 0,
        totalChunks: Number(partial.totalChunks) || 0
      };
    }
    await reportCore.recordTermDiscoveryOutcome(runtime, {
      outcome: "added",
      reason: Number(merged.added) > 0 ? "added" : "no_new_candidates",
      startedAt,
      returned,
      added: Number(merged.added) || 0
    });
    return merged;
  };
}
