import assert from "node:assert/strict";
import test from "node:test";
import { installGlossaryPending } from "../extension/src/glossary/modules/glossary-pending.js";

/**
 * 「最近一次提取」这句文案是用户判断「术语为什么没收集到」的唯一线索。
 *
 * 手机版以前从不写这条记录，所以那半句永远是空的；现在手机也写了，而且多了两种
 * 必须说清楚的结果：
 *   - partial：跑了但缺几段（分段超时/失败），后面会自动补跑；
 *   - 丢弃统计：模型给了却被判掉多少条、为什么丢 —— 「术语老漏」时用来区分
 *     「模型没给」和「给了被丢」。
 */
function describe(last) {
  const originalDocument = globalThis.document;
  // installGlossaryPending 会按 id 取页面元素；这里只测纯函数文案，给个最小桩即可。
  globalThis.document = { getElementById: () => null };
  try {
    const runtime = { termDiscoveryCore: termDiscoveryStub };
    installGlossaryPending(runtime);
    return runtime.describeLastDiscovery(last);
  } finally {
    globalThis.document = originalDocument;
  }
}

const termDiscoveryStub = {
  normalizePendingStore: () => ({ chapters: [] }),
  normalizeIgnoredStore: () => ({ sources: [] })
};

const AT = 1_700_000_000_000;

test("没有记录时不显示任何文案", () => {
  assert.equal(describe(null), "");
  assert.equal(describe({}), "");
});

test("部分失败：说清缺几段、会补跑", () => {
  const text = describe({ at: AT, outcome: "partial", failedChunks: 2, totalChunks: 9 });
  assert.match(text, /有 2 段没跑完/u);
  assert.match(text, /共 9 段/u);
  assert.match(text, /会自动补跑/u);
});

test("提取到候选时带上丢弃统计与自造 kind 的处理", () => {
  const text = describe({
    at: AT, outcome: "added", added: 3, returned: 8,
    dropped: { invalidKind: 2, notInSource: 1, unknownKind: 2 }
  });
  assert.match(text, /新增 3 条候选/u);
  assert.match(text, /另有 3 条被丢弃/u);
  assert.match(text, /kind 非法 2/u);
  assert.match(text, /原文里找不到 1/u);
  assert.match(text, /2 条自造 kind 已按专有名词保留/u);
});

test("没有新增时也把「返回了几条」和丢弃原因说清楚", () => {
  const text = describe({ at: AT, outcome: "added", added: 0, returned: 4, dropped: { invalidKind: 4 } });
  assert.match(text, /返回 4 条，都不是新候选/u);
  assert.match(text, /另有 4 条被丢弃/u);
});

test("跳过与失败保持原来的原因文案", () => {
  assert.match(describe({ at: AT, outcome: "skipped", reason: "throttled" }), /同一页 30 秒内只提取一次/u);
  assert.match(describe({ at: AT, outcome: "failed", reason: "timeout", error: "超时" }), /上次提取超时/u);
  assert.match(describe({ at: AT, outcome: "running", startedAt: AT }), /正在提取/u);
});
