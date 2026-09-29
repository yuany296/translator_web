/**
 * 手机版的「并发小批」翻译。
 *
 * 桌面版走的是本地服务的流式接口（/translations/stream），逐段出译文；手机版只能直连
 * LLM，于是落到 novel-progressive-workflow.js 的渐进小批上。那套流水线有个硬闸门：
 * 要发第 k 块，必须等第 0…k-1 块**全部返回**（`nextChunkIndex <= respondedChunkCount`），
 * 所以网络请求其实是**串行**的，PROGRESSIVE_CHUNK_CONCURRENCY=2 只让「提交/渲染」与
 * 「下一块请求」重叠。一屏 5–8 块 × 每块生成 1400 字 = 慢的 API 下要等好几分钟，
 * 而且第一块不返回就一个字都不显示。
 *
 * 这里换成：块更小（更早看到第一批译文）+ 块之间真并发（总时间从 N×latency 降到 N/并发×latency）
 * + 结果**按块顺序**上屏（网络并发不变，但屏幕从上往下长出来，不会「最后一段先出现」）。
 * 块是**平均切**的（见 splitEvenly）：不再单独切一个很小的开头块 —— 那样块大小悬殊、还多一块。
 *
 * 并发的前提是「块之间没有顺序依赖」，所以**不传 previousTranslation**（上一块的译文）：
 *   - 上下文只保留 beforeText / afterText，它们取自**原文**，任何时刻都拿得到，确定性；
 *   - 专名一致靠每块都注入的术语库保证，这正是术语库存在的意义；
 *   - 附带好处：TRANSLATE_NOVEL_CHUNK 的缓存键里带着 previousTranslation，
 *     去掉后同一个块无论什么时候翻都命中同一条缓存。
 * 代价是跨块的风格/敬语一致性只靠模型自身 + 术语库；真遇到漂移，先把术语补齐，
 * 再考虑把并发降到 2（见 MOBILE_CHUNK_CONCURRENCY 注释）。
 */
import { formatTermUsage, mergeTermUsage } from "./term-usage-local.js";
import { createNovelRepair } from "./novel-repair.js";
import {
  DEFAULT_CHUNK_CHARS, DEFAULT_CONCURRENCY, REPAIR_CONCURRENCY, loadNovelTuning
} from "./novel-tuning.js";

/**
 * 一次请求的成本构成（每块都要重付一遍固定开销）：
 *   固定指令 ~450 token + 术语前言 ~120 + 前后文（各 1 段原文）~180 + 正文 ~500，输出 ~600。
 * 所以「块数」几乎直接等于总成本，而「轮数 = ceil(块数 / 并发)」决定总耗时。
 * 默认值：块 1200 字 → 常见一屏 4–7 块；并发 6 → 大多数屏一轮发完，总耗时约等于一次请求的延迟。
 * 这两个数**用户可以在设置页改**（见 novel-tuning.js），改完下一次翻译就生效。
 */
const MOBILE_CHUNK_CHARS = DEFAULT_CHUNK_CHARS;
const MOBILE_CHUNK_CONCURRENCY = DEFAULT_CONCURRENCY;
// 连续失败这么多块之后就不要再发新块了：API 挂了的时候并发只会变成「同时发一堆失败请求」。
// 注意并发工作线程是各自去取下一个任务的，所以实际最多会多发「并发数 - 1」个已经出发的块。
const MAX_CHUNK_FAILURES = 2;
// 前后各留 1 段原文（不带前文译文）：跨块指代能对上，又只占约 180 token。
// 这里从 3 段降到 1 段是纯省 token —— 前后文原本比正文本身还贵。
const CONTEXT_NEIGHBOR_PARAGRAPHS = 1;

/**
 * 平均切块。
 *
 * 早先的做法是「开头 2 段单独一个小块，剩下按 1200 字切」：为了让视线里那几段最早回来。
 * 代价是块大小很不均匀（2 段 / 6 段这种），用户一眼就看出「前面怎么只有 2 段」，
 * 而且块数会多一块（多付一次每块的固定开销）。现在改成平均切：
 *   块数 = ceil(总字数 / 上限)，每块的目标容量 = 总字数 / 块数，按段边界就近落刀。
 * 于是 2400 字 → 两块各 1200；1800 字 → 两块各 900（而不是 1200 + 600）。
 * 上限仍是硬约束：单段超过上限时它自己占一块（和原来的切法一致）。
 */
export function splitEvenly(items, chunkChars = MOBILE_CHUNK_CHARS) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return [];
  const limit = Math.max(400, Number(chunkChars) || MOBILE_CHUNK_CHARS);
  const sizes = list.map(item => String(item.original_text || "").length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const blockCount = Math.max(1, Math.ceil(total / limit));
  const target = total / blockCount;
  const chunks = [[]];
  let length = 0;
  for (let index = 0; index < list.length; index += 1) {
    const size = sizes[index];
    // 换块：① 加上这一段会超过硬上限；② 当前块已经装够它那一份（后面还有块）
    const overLimit = length > 0 && length + size > limit;
    const pastShare = length > 0 && chunks.length < blockCount && length >= chunks.length * target;
    if (overLimit || pastShare) {
      chunks.push([]);
      length = 0;
    }
    chunks.at(-1).push(list[index]);
    length += size;
  }
  return chunks;
}

function buildContext(allItems, chunk) {
  const firstIndex = allItems.findIndex(item => item.id === chunk[0].id);
  const lastIndex = allItems.findIndex(item => item.id === chunk.at(-1).id);
  return {
    previousTranslation: "",
    beforeText: allItems.slice(Math.max(0, firstIndex - CONTEXT_NEIGHBOR_PARAGRAPHS), firstIndex)
      .map(item => item.original_text).join("\n"),
    afterText: allItems.slice(lastIndex + 1, lastIndex + 1 + CONTEXT_NEIGHBOR_PARAGRAPHS)
      .map(item => item.original_text).join("\n")
  };
}

function buildRequest(chapter, state, chunk, nearby, force, revisionInstruction = "") {
  return {
    type: "TRANSLATE_NOVEL_CHUNK",
    scopeKey: chapter.scopeKey,
    seriesId: chapter.seriesId,
    chapterId: chapter.chapterId,
    chapterTitle: chapter.chapterTitle,
    chapterOrder: chapter.chapterOrder,
    force,
    taskId: state.taskId,
    sourceLanguage: state.sourceLanguage,
    targetLanguage: state.targetLanguage,
    ...nearby,
    ...(revisionInstruction ? { revisionInstruction } : {}),
    items: chunk.map(({ id, index, kind, original_text }) => ({ id, index, kind, original_text }))
  };
}

async function requestChunk(runtime, request) {
  try {
    return await runtime.sendRuntimeMessage(request);
  } catch (error) {
    return { ok: false, error: runtime.getErrorMessage(error) };
  }
}

/** 把一块的译文落库 + 渲染，与桌面版 applyChunkTranslations 的记账方式保持一致。 */
async function applyChunk(runtime, chapter, state, response, fingerprint) {
  for (const row of response?.translations || []) {
    const text = String(row && row.translated_text || "").trim();
    if (!text) continue;
    const item = chapter.paragraphs.find(candidate => candidate.id === String(row.id));
    if (!item) continue;
    const operation = runtime.createTranslationOperation(
      "commit_translation", runtime.buildNovelRecordKey(chapter, item), {
        mode: "novel", scopeKey: chapter.scopeKey, segmentKey: item.paragraphKey,
        workId: chapter.seriesId, chapterId: chapter.chapterId,
        rawSourceText: item.original_text,
        normalizedSourceText: runtime.normalizeTranslationCacheText(item.original_text),
        rawSourceHash: item.rawSourceHash,
        normalizedSourceHash: item.normalizedSourceHash,
        configuredSourceLanguage: runtime.getConfiguredSourceLanguage?.() || "auto",
        resolvedSourceLanguage: runtime.resolveSourceLanguage?.(item.original_text) || "auto",
        targetLanguage: runtime.getTargetLanguage?.() || "zh-CN",
        translatedText: text, source: "api", configFingerprint: fingerprint
      });
    const committed = await runtime.commitTranslationOperation(operation);
    const officialText = String(committed && committed.record && committed.record.activeVersion
      && committed.record.activeVersion.translatedText || text);
    state.translations.set(item.id, officialText);
    runtime.renderNovelTranslation(item.node, officialText, true, item.id);
    item.node.dataset.mtNovelStatus = committed && committed.pending ? "pending" : "current";
    if (committed && committed.pending) state.pendingParagraphs.add(item.id);
    else state.pendingParagraphs.delete(item.id);
  }
}

/** 平均每次模型请求耗时：把「模型慢」和「请求太多」两种慢区分开的唯一线索。 */
function perCallText(elapsedMs, modelCalls = 0) {
  const perCall = modelCalls > 0 ? elapsedMs / modelCalls / 1000 : 0;
  if (!(perCall >= 0.05)) return "";
  // 10 秒以内给一位小数：手机上「平均 2.3s/次」比「平均 2s/次」更能看出趋势
  return `平均 ${perCall >= 10 ? Math.round(perCall) : perCall.toFixed(1)}s/次 · `;
}

/**
 * 进度文案：「请求次数 / 块数」能看出后台有没有重试；「平均 Xs/次」能看出慢在哪 ——
 * 平均只有几秒而总时间很长 = 请求太多（块太小或并发太低）；平均就几十秒 = 模型/服务商慢。
 */
function formatNovelProgress({ doneChunks, totalChunks, modelCalls, okChunks = doneChunks, startedAt, termUsage = null }) {
  const elapsedMs = Date.now() - startedAt;
  const seconds = Math.round(elapsedMs / 1000);
  // 请求数多于成功块数 = 有块被校验打回后单独重试过（缺段、丢引号、重复段…）。
  // 那是最纯粹的浪费时间：同一段内容付了两次模型钱，其中一次注定被丢掉。
  const retries = Math.max(0, modelCalls - okChunks);
  const termText = formatTermUsage(termUsage);
  return `正在翻译（${doneChunks}/${totalChunks} 块 · 请求 ${modelCalls} 次`
    + `${retries ? ` · 重试 ${retries} 次` : ""} · ${perCallText(elapsedMs, modelCalls)}${seconds}s`
    + `${termText ? ` · ${termText}` : ""}）`;
}

function updateProgress(state, runtime, doneChunks, totalChunks, startedAt, modelCalls = 0, termUsage = null) {
  state.progress.textDone = state.translations.size;
  state.progress.textPhase = formatNovelProgress({ doneChunks, totalChunks, modelCalls, startedAt, termUsage });
  runtime.setNovelTextStatus?.("working", state.progress);
}

export function installNovelBatch(runtime, options = {}) {
  const optionChunkChars = Number(options.chunkChars) > 0 ? Number(options.chunkChars) : 0;
  const optionConcurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 0;

  runtime.runNovelProgressiveTranslation = async ({ chapter, state, allItems, pending, force, fingerprint }) => {
    const startedAt = Date.now();
    // 用户设置（设置页可改）优先于内置默认；显式传进来的 options 只给测试用。
    const tuning = await loadNovelTuning(runtime);
    const chunkChars = optionChunkChars || tuning.chunkChars;
    const concurrency = optionConcurrency || tuning.concurrency;
    // 定点修正（术语译名 / 简繁字形）见 novel-repair.js：这里把那几个块级工具注入进去
    const repair = createNovelRepair({
      buildContext, buildRequest, requestChunk, applyChunk,
      concurrency: REPAIR_CONCURRENCY, maxParagraphs: tuning.repairParagraphs
    });
    // 「开始翻译时在哪一屏」必须在动手之前抓下来：收尾时再算就已经是新屏了，永远比不出差异。
    const startSignature = runtime.novelSurfaceSignature?.(chapter.surface) || "";
    const sourceLanguage = runtime.getConfiguredSourceLanguage?.() || "auto";
    const targetLanguage = runtime.getTargetLanguage?.() || "zh-CN";
    Object.assign(state, { sourceLanguage, targetLanguage });
    // 平均切块（见 splitEvenly）：块大小尽量一致，块数 = ceil(总字数 / 1200)。
    const chunks = splitEvenly(pending, chunkChars);
    const errors = [];
    const warnings = new Map();
    const chunkStats = [];
    let doneChunks = 0;
    // 成功回来的块数：重试次数 = 模型请求数 - 成功块数（失败块不会把「重试」算多）
    let okChunks = 0;
    let failures = 0;
    let dispatched = 0;
    let modelCalls = 0;
    // 术语为什么没生效：把每块回传的 termUsage 累加起来，直接显示在进度行上（见 term-usage-local.js）
    let termUsage = null;
    // 主流程每块的原始响应：收尾时用来判断哪些段落需要定点修正（术语 / 字形）
    const responses = [];
    state.progress.textTotal = allItems.length;

    const progressText = () => formatNovelProgress({
      doneChunks, totalChunks: chunks.length, modelCalls, okChunks, startedAt, termUsage
    });

    /**
     * 结果按**块顺序**上屏。
     *
     * 网络仍然是 N 路并发（谁先回来谁先到达这里），但先到的后块会攒着，等它前面的块都到齐
     * 再一起从前往后贴 —— 屏幕永远是从上往下长出来的，不会再出现「最后一段先出来」。
     * 总耗时不变：整体完成时间由最慢的那块决定，这里只改贴上屏的顺序（最坏情况是多等一次
     * 「前面那块还在路上」的时间，而那块本来就还没显示）。
     * 某块失败时按空结果推进游标，不会把后面的块卡住。
     */
    const arrived = new Map();
    let paintCursor = 0;
    let paintChain = Promise.resolve();

    const paintChunk = async response => {
      doneChunks += 1;
      if (response) {
        okChunks += 1;
        (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
        errors.push(...(response.errors || []));
        termUsage = mergeTermUsage(termUsage, response.termUsage);
        responses.push(response);
        for (const row of response.translations || []) {
          const text = String(row && row.translated_text || "").trim();
          if (text) state.translations.set(String(row.id), text);
        }
        await applyChunk(runtime, chapter, state, response, fingerprint);
      }
      updateProgress(state, runtime, doneChunks, chunks.length, startedAt, modelCalls, termUsage);
    };

    const drainPaints = async () => {
      while (arrived.has(paintCursor)) {
        const response = arrived.get(paintCursor);
        arrived.delete(paintCursor);
        paintCursor += 1;
        await paintChunk(response);
      }
    };
    const queuePaint = () => {
      paintChain = paintChain.then(drainPaints);
      return paintChain;
    };

    const runChunk = async (chunk, index) => {
      // 失败够了就不再发新块（已发出的跑完），避免 API 挂掉时并发变成一堆失败请求。
      if (failures >= MAX_CHUNK_FAILURES) return;
      dispatched += 1;
      state.progress.textPhase = progressText();
      runtime.setNovelTextStatus?.("working", state.progress);
      const chunkStartedAt = Date.now();
      const nearby = buildContext(allItems, chunk);
      const response = await requestChunk(runtime, buildRequest(chapter, state, chunk, nearby, force));
      const attempts = Array.isArray(response && response.diagnostics) ? response.diagnostics.length : 0;
      modelCalls += attempts;
      chunkStats.push({
        ids: chunk.map(item => item.id),
        index,
        ms: Date.now() - chunkStartedAt,
        attempts,
        ok: Boolean(response && response.ok === true)
      });
      runtime.collectTextDiagnostics?.(state, response);
      if (!response || response.ok !== true) {
        failures += 1;
        errors.push(...chunk.map(item => ({ id: item.id, error: response && response.error || "translation_failed" })));
        arrived.set(index, null);
        await queuePaint();
        return;
      }
      arrived.set(index, response);
      await queuePaint();
    };

    await runtime.runWithConcurrency(chunks.map((chunk, index) => () => runChunk(chunk, index)), concurrency);

    // 定点修正：术语被模型自己发挥（典型是人名换成别的写法）／目标是简体却出现繁体字。
    // 本地都没法确定性改回来，所以只对受影响的段落重问一次，并在请求里点名要求改什么。
    const repairReasons = new Map();
    const mergeReasons = source => {
      for (const [id, reasons] of source) {
        if (!repairReasons.has(id)) repairReasons.set(id, []);
        reasons.forEach(reason => {
          if (!repairReasons.get(id).includes(reason)) repairReasons.get(id).push(reason);
        });
      }
    };
    responses.forEach(response => mergeReasons(repair.collectReasons(response, targetLanguage)));
    if (repairReasons.size) {
      await repair.repairParagraphs({
        runtime, chapter, state, allItems, force, fingerprint, errors, warnings,
        onUsage: next => { termUsage = mergeTermUsage(termUsage, next); }
      }, repairReasons, progressText);
    }

    // 漏段逐段补齐：并发跑，结果按原顺序归并，错误保持确定性。
    let missing = allItems.filter(item => !state.translations.has(item.id));
    if (missing.length) {
      const repairErrors = [];
      state.progress.textPhase = `正在逐段补齐 ${missing.length} 个漏译段落…`;
      runtime.setNovelTextStatus?.("working", state.progress);
      const repairs = missing.map(item => async () => {
        const nearby = buildContext(allItems, [item]);
        const response = await requestChunk(runtime, buildRequest(chapter, state, [item], nearby, force));
        runtime.collectTextDiagnostics?.(state, response);
        if (!response || response.ok !== true) {
          return { id: item.id, ok: false, error: response && response.error || "repair_failed" };
        }
        (response.warnings || []).forEach(warning => warnings.set(String(warning.id), warning));
        termUsage = mergeTermUsage(termUsage, response.termUsage);
        await applyChunk(runtime, chapter, state, response, fingerprint);
        return { id: item.id, ok: true, errors: response.errors || [] };
      });
      for (const result of await runtime.runWithConcurrency(repairs, REPAIR_CONCURRENCY)) {
        if (!result || result.ok === false) {
          repairErrors.push({ id: result && result.id || "", error: result && result.error || "repair_failed" });
          continue;
        }
        repairErrors.push(...(result.errors || []));
      }
      errors.push(...repairErrors);
      missing = allItems.filter(item => !state.translations.has(item.id));
    }
    // 翻译期间阅读器可能把段落节点重建了（KakaoPage 是虚拟滚动/EPUB 重渲染），
    // renderNovelTranslation 写进的就是已经脱离文档的旧节点 —— 表现就是「翻译完成了但页面没替换」。
    // 这里按**当前** surface 按 id 重新贴一遍：state.translations 里有译文，节点是活的。
    // surfaceSignature 只由原文算出（渲染插入的包裹不改它），所以这一步不会自激触发重译。
    const liveSurface = runtime.findNovelSurface?.() || chapter.surface;
    runtime.reapplyNovelTranslations?.(liveSurface);
    const liveSignature = runtime.novelSurfaceSignature?.(liveSurface) || "";
    return {
      errors,
      warnings: [...warnings.values()],
      termUsage,
      diagnostics: {
        chunks: chunks.length, dispatched, failures, modelCalls,
        elapsedMs: Date.now() - startedAt, missing: missing.length,
        // 每块的耗时与模型请求次数：块数 < 请求数说明后台在重试，
        // 「开头那一段最后才完成」能从这里一眼看出是重试还是服务商慢。
        chunkStats: chunkStats.sort((left, right) => right.ms - left.ms),
        surfaceChanged: Boolean(startSignature && liveSignature && startSignature !== liveSignature)
      }
    };
  };
}

export const NOVEL_BATCH_DEFAULTS = Object.freeze({
  chunkChars: DEFAULT_CHUNK_CHARS,
  concurrency: DEFAULT_CONCURRENCY,
  repairConcurrency: REPAIR_CONCURRENCY
});
