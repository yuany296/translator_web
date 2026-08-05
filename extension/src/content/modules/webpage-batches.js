const MAX_BATCH_ITEMS = 24;
const MAX_BATCH_CHARS = 1600;
const MAX_CONCURRENCY = 2;
const PARTIAL_RETRY_CONCURRENCY = 4;

export function buildWebpageBatches(values, options = {}) {
  const itemLimit = Math.max(1, Number(options.maxItems) || MAX_BATCH_ITEMS);
  const charLimit = Math.max(1, Number(options.maxChars) || MAX_BATCH_CHARS);
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "");
    if (batch.length && (batch.length >= itemLimit || chars + text.length > charLimit)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(value);
    chars += text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function runWebpageBatchQueue(batches, worker, onSettled, concurrency = MAX_CONCURRENCY) {
  const queue = Array.isArray(batches) ? batches : [];
  let cursor = 0;
  async function consume() {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      let result;
      try {
        result = await worker(queue[index], index);
      } catch (error) {
        result = { ok: false, errors: [{ error: String(error?.message || error) }] };
      }
      await onSettled(result, queue[index], index);
    }
  }
  const count = Math.min(Math.max(1, Number(concurrency) || 1), queue.length || 1);
  await Promise.all(Array.from({ length: count }, consume));
}

/** 批量响应漏项时拆成单项并发补偿，避免模型连续只返回少数 id。 */
export async function completePartialWebpageBatch(keys, initial, worker) {
  const translations = new Map(initial?.translations || []);
  const missing = [...new Set((Array.isArray(keys) ? keys : [])
    .filter(key => !translations.has(key)))];
  if (!missing.length || initial?.cancelled) return initial;
  const retryErrors = [];
  let cancelled = false;
  await runWebpageBatchQueue(missing.map(key => [key]), worker, (result, batch) => {
    if (result?.cancelled) cancelled = true;
    result?.translations?.forEach((value, key) => translations.set(key, value));
    if (!result?.translations?.has(batch[0])) {
      retryErrors.push(...(result?.errors || [{ error: "翻译响应漏项" }]));
    }
  }, PARTIAL_RETRY_CONCURRENCY);
  const unresolved = missing.filter(key => !translations.has(key));
  return {
    ok: translations.size > 0 || unresolved.length === 0,
    cancelled,
    partial: unresolved.length > 0,
    translations,
    errors: unresolved.length ? [...(initial?.errors || []), ...retryErrors] : []
  };
}

/**
 * 网页翻译只做协议级校验：模型为对应 ID 返回合法非空字符串即接受。
 * 不判断内容质量——保留源语言文字、专有名词、部分翻译、与原文相同
 * 都不视为失败；失败仅限缺 ID、译文非字符串、trim 后为空。
 */
export function isUsableWebpageTranslation(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export const WEBPAGE_BATCH_LIMITS = Object.freeze({
  maxItems: MAX_BATCH_ITEMS,
  maxChars: MAX_BATCH_CHARS,
  concurrency: MAX_CONCURRENCY,
  partialRetryConcurrency: PARTIAL_RETRY_CONCURRENCY
});
