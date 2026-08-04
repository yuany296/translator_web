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

/** 目标文字仍原样保留源语言脚本时，不把它当成成功译文或有效缓存。 */
export function isUsableWebpageTranslation(source, translated, targetLanguage = "zh-CN") {
  const original = String(source || "").replace(/\s+/gu, " ").trim();
  const result = String(translated || "").replace(/\s+/gu, " ").trim();
  if (!result) return false;
  if (result !== original) return true;
  const target = String(targetLanguage || "").toLowerCase();
  if (target.startsWith("zh")) return !/[가-힯぀-ヿ]/u.test(original);
  if (target.startsWith("ja")) return !/[가-힯]/u.test(original);
  if (target.startsWith("ko")) return !/[぀-ヿ]/u.test(original);
  if (target.startsWith("en")) return !/[가-힯぀-ヿ一-鿿]/u.test(original);
  return true;
}

export const WEBPAGE_BATCH_LIMITS = Object.freeze({
  maxItems: MAX_BATCH_ITEMS,
  maxChars: MAX_BATCH_CHARS,
  concurrency: MAX_CONCURRENCY,
  partialRetryConcurrency: PARTIAL_RETRY_CONCURRENCY
});
