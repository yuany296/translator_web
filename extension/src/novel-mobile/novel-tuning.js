/**
 * 手机版可调的「翻译速度」参数。
 *
 * 速度大致是这么来的：
 *   块数 = ceil(一屏总字数 / 每块字数)，总耗时 ≈ ceil(块数 / 并发) × 单次请求耗时。
 * 所以「并发」和「每块字数」是两个真正能拧的旋钮：
 *   - 并发调高 → 轮数变少（块数 ≤ 并发 时一轮发完），但更容易撞服务商限流，被限流后重试反而更慢；
 *   - 每块字数调小 → 每块生成的内容少、回来得快，但块数变多，而每块都要重付一遍
 *     「固定指令 + 术语前言」的开销（约 600 token），总花费和总请求数都涨。
 * 没有普适最优值：模型快慢、服务商限流、小说段落长度都不一样，只能自己试。
 * 所以这些值不再写死在代码里，而是存在 chrome.storage.local，设置页可以直接改，
 * 内容脚本每次开始翻译时读一次 —— 改完下一次翻译就生效，不用重开标签页。
 */

export const TUNING_KEY = "mt_novel_mobile_tuning_v1";

/** 取值边界：太小的块只会烧钱，太大的并发基本一定被限流。 */
export const TUNING_LIMITS = Object.freeze({
  concurrency: Object.freeze({ min: 1, max: 10, step: 1 }),
  chunkChars: Object.freeze({ min: 400, max: 2000, step: 100 }),
  repairParagraphs: Object.freeze({ min: 0, max: 8, step: 1 })
});

export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_CHUNK_CHARS = 1200;
export const DEFAULT_REPAIR_PARAGRAPHS = 3;
/** 定点修正自己的并发（通常 3 就够：一次最多补几段而已）。 */
export const REPAIR_CONCURRENCY = 3;

export const DEFAULT_TUNING = Object.freeze({
  concurrency: DEFAULT_CONCURRENCY,
  chunkChars: DEFAULT_CHUNK_CHARS,
  repairParagraphs: DEFAULT_REPAIR_PARAGRAPHS
});

function clampInteger(value, fallback, { min, max }) {
  // 注意 Number(null) === 0、Number("") === 0：这两种「没填」必须当缺省处理，
  // 否则空值会被当成 0 再被夹到最小值（每块 400 字、补翻 0 段这种莫名其妙的设置）。
  if (value === null || value === undefined || value === "") return fallback;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 任何脏数据都收敛成合法值：设置页填错、旧版本残留都不会让翻译跑飞。 */
export function normalizeTuning(value) {
  return {
    concurrency: clampInteger(value && value.concurrency, DEFAULT_CONCURRENCY, TUNING_LIMITS.concurrency),
    chunkChars: clampInteger(value && value.chunkChars, DEFAULT_CHUNK_CHARS, TUNING_LIMITS.chunkChars),
    repairParagraphs: clampInteger(
      value && value.repairParagraphs, DEFAULT_REPAIR_PARAGRAPHS, TUNING_LIMITS.repairParagraphs
    )
  };
}

/** 设置页底部那句「当前会怎么跑」：给用户一个能自己验算的说明。 */
export function describeTuning(tuning) {
  const value = normalizeTuning(tuning);
  const blocks = Math.max(1, Math.ceil(3000 / value.chunkChars));
  const rounds = Math.ceil(blocks / value.concurrency);
  return `当前：并发 ${value.concurrency} · 每块 ${value.chunkChars} 字`
    + `（一屏约 3000 字 → ${blocks} 块，约 ${rounds} 轮发完）`;
}

/** 读取用户设置；没有就返回默认值。任何异常都退回默认，绝不让翻译因为读设置而失败。 */
export async function loadNovelTuning(runtime) {
  try {
    const stored = await runtime.storageGet?.([TUNING_KEY]);
    return normalizeTuning(stored && stored[TUNING_KEY]);
  } catch (error) {
    return { ...DEFAULT_TUNING };
  }
}
