import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebpageBatches, completePartialWebpageBatch, isUsableWebpageTranslation,
  runWebpageBatchQueue, WEBPAGE_BATCH_LIMITS
} from "../extension/src/content/modules/webpage-batches.js";
import { WEBPAGE_SPEED_DEFAULTS } from "../extension/src/shared/webpage-speed.js";

test("webpage batches respect both the item-count and approximate character limits", () => {
  const items = Array.from({ length: 50 }, (_, index) => `item-${index}`);
  // 显式传 limits：这里验的是切批逻辑本身，不该被默认值变动牵着走
  const byCount = buildWebpageBatches(items, { maxItems: 24 });
  assert.deepEqual(byCount.map(batch => batch.length), [24, 24, 2]);
  const byChars = buildWebpageBatches(["a".repeat(1000), "b".repeat(700), "short"], { maxChars: 1600 });
  assert.deepEqual(byChars.map(batch => batch.length), [1, 2]);
  assert.equal(WEBPAGE_BATCH_LIMITS.concurrency, 2);
  // 不传 limits 时的兜底与网页速度默认值同源（只有一份数字）
  assert.equal(WEBPAGE_BATCH_LIMITS.maxItems, WEBPAGE_SPEED_DEFAULTS.batchItems);
  assert.equal(WEBPAGE_BATCH_LIMITS.maxChars, WEBPAGE_SPEED_DEFAULTS.batchChars);
});

test("webpage queue never exceeds concurrency two and continues after a failed batch", async () => {
  let active = 0;
  let maxActive = 0;
  const settled = [];
  await runWebpageBatchQueue([[1], [2], [3], [4]], async batch => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 4));
    active -= 1;
    if (batch[0] === 2) throw new Error("expected failure");
    return { ok: true, value: batch[0] };
  }, (result, batch) => settled.push({ result, batch }), 2);
  assert.equal(maxActive, 2);
  assert.equal(settled.length, 4);
  assert.equal(settled.find(entry => entry.batch[0] === 2).result.ok, false);
  assert.equal(settled.find(entry => entry.batch[0] === 4).result.ok, true);
});

test("partial batch retries every missing item independently with bounded concurrency", async () => {
  const first = {
    ok: true, partial: true, translations: new Map([["a", "甲"]]),
    errors: [{ error: "batch omitted items" }]
  };
  let active = 0;
  let maxActive = 0;
  const retried = [];
  const result = await completePartialWebpageBatch(["a", "b", "c", "d", "e", "f"], first,
    async ([key]) => {
      retried.push(key);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 4));
      active -= 1;
      return { ok: true, translations: new Map([[key, `译-${key}`]]), errors: [] };
    });
  assert.deepEqual(retried.sort(), ["b", "c", "d", "e", "f"]);
  assert.equal(maxActive, WEBPAGE_BATCH_LIMITS.partialRetryConcurrency);
  assert.equal(result.partial, false);
  assert.equal(result.translations.size, 6);
});

test("partial retry keeps a readable reason when a missing item stays missing", async () => {
  const first = { ok: true, partial: true, translations: new Map(), errors: [] };
  const result = await completePartialWebpageBatch(["a"], first,
    async () => ({ ok: true, translations: new Map(), errors: [] }));
  assert.equal(result.translations.size, 0);
  assert.equal(result.partial, true);
  assert.equal(result.errors.length > 0, true, "空 errors 不再吞掉失败原因");
  assert.equal(result.errors[0].error, "翻译响应漏项");
});

test("webpage accepts any non-empty string (protocol-only validation)", () => {
  // 1. 专名保持不变：글개미 → 글개미 → accepted，不重试不失败
  assert.equal(isUsableWebpageTranslation("글개미"), true, "专名保留韩文也接受");
  // 2. 整句保持不变：同样接受（不判内容质量）
  assert.equal(isUsableWebpageTranslation("최신화 업데이트 완료"), true);
  // 3. 部分翻译：译文非空即接受
  assert.equal(isUsableWebpageTranslation("网络小说 · 奇幻 · 글개미"), true);
  // 4. 空译文 / 非字符串：协议级失败
  assert.equal(isUsableWebpageTranslation(""), false, "trim 后为空仍判失败（协议级）");
  assert.equal(isUsableWebpageTranslation("   "), false);
  assert.equal(isUsableWebpageTranslation(null), false, "非字符串仍判失败（协议级）");
  assert.equal(isUsableWebpageTranslation(undefined), false);
});
