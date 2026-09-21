/**
 * 网页正文翻译的可调速度参数。
 *
 * 网页翻译把页面上的文字节点切成批（`content/modules/webpage-scheduler.js`），
 * 三个旋钮分别作用在切批与并发上：
 *   1. `webpageConcurrency`：同时进行的批数（车道）。有视口/近屏内容待翻时后台批只占 1 条，
 *      纯后台长页才允许占满 —— 保证眼前的内容先回来。
 *   2. `webpageBatchItems`：一批最多合并多少段网页文字。视口内按配置的 1/4、近屏按 1/2 折算
 *      （见 `content/modules/webpage-scheduler-config.js`），所以调大它主要惠及后台批次。
 *   3. `webpageBatchChars`：一批的字符上限，与段数**谁先到就切批**；单个超长文本节点自己成一批。
 *
 * 这三个值原本只在快捷弹窗的「高级参数」里可调；现在统一由设置页「网页翻译速度」卡片承载，
 * 默认值与搬走之前 `config/schema.js` 里写死的数字逐个相等 —— 不动设置就等于没改。
 */

/** 取值范围：并发再高就是排队与限流，批再大只会让单次请求更慢。 */
export const WEBPAGE_SPEED_LIMITS = Object.freeze({
  concurrency: Object.freeze({ min: 1, max: 8 }),
  batchItems: Object.freeze({ min: 4, max: 96 }),
  batchChars: Object.freeze({ min: 400, max: 8000 })
});

export const WEBPAGE_SPEED_DEFAULTS = Object.freeze({
  concurrency: 5,
  batchItems: 32,
  batchChars: 3200
});

/** runtime.state 上的字段名（也是 config/schema.js 的键名）。 */
export const WEBPAGE_SPEED_STATE_KEYS = Object.freeze({
  concurrency: "webpageConcurrency",
  batchItems: "webpageBatchItems",
  batchChars: "webpageBatchChars"
});

/**
 * 快捷弹窗「网页快速翻译」开关原来的两档，搬进设置页后作为「快速模式」勾选项：
 * 数值必须与搬走前的 FAST_MODE / NORMAL_MODE 完全一致。
 */
export const WEBPAGE_SPEED_PRESETS = Object.freeze({
  fast: Object.freeze({ concurrency: 5, batchItems: 32, batchChars: 3200 }),
  normal: Object.freeze({ concurrency: 3, batchItems: 24, batchChars: 1600 })
});

function isMissing(value) {
  if (value === null || value === undefined) return true;
  // 注意 Number("") === 0：空输入框必须当「没填」，否则会被夹到最小值（每批 4 段这种）。
  return typeof value === "string" && value.trim() === "";
}

/** 任何脏数据都收敛成合法值：设置页填错、旧配置缺字段都不会让网页翻译跑飞。 */
export function clampWebpageSpeed(key, value) {
  const limits = WEBPAGE_SPEED_LIMITS[key];
  const fallback = WEBPAGE_SPEED_DEFAULTS[key];
  if (!limits || fallback === undefined) return fallback;
  if (isMissing(value)) return fallback;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, number));
}

/** 三个值都等于快速档才是「快速模式」；用户手改任意一格，勾选状态就该跟着掉。 */
export function isWebpageFastMode(value = {}) {
  const fast = WEBPAGE_SPEED_PRESETS.fast;
  // 这里刻意不做收敛：比的是「现在填的这几个数是不是正好那一档」，
  // 缺字段/空输入框（Number("") === 0）都不是快速档，不能因为回默认值就算命中。
  return Object.keys(fast).every(key => Number(value[key]) === fast[key]);
}

/** 设置页那句「现在会怎么跑」：让用户不用试就知道一批大概多大。 */
export function describeWebpageSpeed(value = {}) {
  const concurrency = clampWebpageSpeed("concurrency", value.concurrency);
  const batchItems = clampWebpageSpeed("batchItems", value.batchItems);
  const batchChars = clampWebpageSpeed("batchChars", value.batchChars);
  return `当前：并发 ${concurrency} 批 · 每批最多 ${batchItems} 段 / ${batchChars} 字（先到者为准）`;
}
