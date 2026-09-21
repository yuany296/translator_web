/**
 * 桌面版小说的可调速度参数。
 *
 * 桌面小说有两条通道，旋钮分别作用在它们身上：
 *   1. 流式（主力通道）：整章按「每批段数」（novelStreamBatchSize）切批，同时并发
 *      novelStreamConcurrency 条请求 —— 一轮最多翻「并发 × 每批段数」段。
 *   2. 渐进（流式不可用时回退）：按 novelChunkChars 字切块。块与块之间**严格串行**：
 *      下一块的上下文取自已到达的上一块译文，请求本身没法并行（见
 *      content/modules/novel-progressive-workflow.js 的 pump 闸门）。
 *      所以这里能拧的是「每块字数」——块越大总轮数越少、总耗时越短，但首屏第一段译文更晚。
 *   漏译逐段补齐的请求彼此独立，按 novelRepairConcurrency 并行。
 *
 * 默认值与改动前写死的常量**完全一致**：不动设置就等于没改。
 */

/** 取值范围：流式并发再高就是排队和限流，渐进每块过小只会把固定开销翻倍。 */
export const NOVEL_SPEED_LIMITS = Object.freeze({
  streamConcurrency: Object.freeze({ min: 1, max: 8 }),
  chunkChars: Object.freeze({ min: 400, max: 4000 }),
  repairConcurrency: Object.freeze({ min: 1, max: 8 })
});

export const NOVEL_SPEED_DEFAULTS = Object.freeze({
  streamConcurrency: 3,
  chunkChars: 1400,
  repairConcurrency: 3
});

/** runtime.state 上的字段名：统一带 novel 前缀，避免和网页翻译的同名参数撞车。 */
export const NOVEL_SPEED_STATE_KEYS = Object.freeze({
  streamConcurrency: "novelStreamConcurrency",
  chunkChars: "novelChunkChars",
  repairConcurrency: "novelRepairConcurrency"
});

/** 流式每批段数的范围与默认值属于既有设置项，这里只用于算「一轮能翻多少段」。 */
const STREAM_BATCH_MIN = 5;
const STREAM_BATCH_MAX = 150;
const STREAM_BATCH_DEFAULT = 50;

function isMissing(value) {
  if (value === null || value === undefined) return true;
  // 注意 Number("") === 0：空输入框必须当「没填」，否则会被夹到最小值（每块 400 字这种）。
  return typeof value === "string" && value.trim() === "";
}

/** 任何脏数据都收敛成合法值：设置页填错、旧配置缺字段都不会让翻译跑飞。 */
export function clampNovelSpeed(key, value) {
  const limits = NOVEL_SPEED_LIMITS[key];
  const fallback = NOVEL_SPEED_DEFAULTS[key];
  if (!limits || fallback === undefined) return fallback;
  if (isMissing(value)) return fallback;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, number));
}

/** 每批段数（既有设置项 novelStreamBatchSize）——只用来把「一轮能翻多少段」算给用户看。 */
function resolveStreamBatch(value) {
  if (isMissing(value)) return STREAM_BATCH_DEFAULT;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return STREAM_BATCH_DEFAULT;
  return Math.min(STREAM_BATCH_MAX, Math.max(STREAM_BATCH_MIN, number));
}

/** 从 runtime.state 解析出本次翻译要用的三个值；state 缺失或字段为空一律用默认值。 */
export function resolveNovelSpeed(state) {
  const source = state || {};
  const resolved = {};
  for (const key of Object.keys(NOVEL_SPEED_STATE_KEYS)) {
    resolved[key] = clampNovelSpeed(key, source[NOVEL_SPEED_STATE_KEYS[key]]);
  }
  return resolved;
}

/** 设置页那句「当前会怎么跑」：让用户能自己算一轮最多翻多少段。 */
export function describeNovelSpeed(value = {}) {
  const streamConcurrency = clampNovelSpeed("streamConcurrency", value.streamConcurrency);
  const chunkChars = clampNovelSpeed("chunkChars", value.chunkChars);
  const repairConcurrency = clampNovelSpeed("repairConcurrency", value.repairConcurrency);
  const batch = resolveStreamBatch(value.streamBatchSize);
  const perRound = streamConcurrency * batch;
  return `当前：流式并发 ${streamConcurrency} × 每批 ${batch} 段（一轮最多 ${perRound} 段）`
    + ` · 渐进每块 ${chunkChars} 字 · 补翻并发 ${repairConcurrency}`;
}
