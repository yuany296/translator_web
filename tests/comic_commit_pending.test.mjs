import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installComicTranslationStore } from "../extension/src/background/modules/comic-translation-store.js";

function makeRuntime(options = {}) {
  const submitted = [];
  const queued = [];
  const snapshots = [];
  const runtime = {
    canonicalTranslationItemKey: item => `${item.id}@${Number(item.revision) || 0}`,
    restoreDialogueQuotes: (source, text) => text,
    async submitTranslationOperations(operations) {
      submitted.push(operations);
      if (options.failSubmit) throw new Error("service offline");
      return { results: [{ record: { recordKey: operations[0].recordKey } }] };
    },
    async saveTranslationServiceSnapshots(records) {
      snapshots.push(records);
    },
    async queuePendingTranslationOperation(operation) {
      queued.push(operation);
    }
  };
  installComicTranslationStore(runtime);
  return { runtime, submitted, queued, snapshots };
}

function descriptor(id, recordKey) {
  return { item: { id, revision: 1, original_text: "원문" }, recordKey, payload: { mode: "comic" } };
}

test("提交成功时 pending 集合为空，并落盘快照", async () => {
  const { runtime, submitted, queued, snapshots } = makeRuntime();
  const outcome = new Map([["c1@1", { translatedText: "译文一" }]]);

  const pending = await runtime.commitOfficialComicTranslations([descriptor("c1", "rk-1")], outcome, "fp-1");

  assert.equal(pending.size, 0);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0][0].payload.translatedText, "译文一");
  assert.equal(submitted[0][0].payload.configFingerprint, "fp-1");
  assert.equal(queued.length, 0);
  assert.equal(snapshots.length, 1);
});

test("提交失败时把失败的 recordKey 交回给调用方，并排队重试", async () => {
  const { runtime, queued } = makeRuntime({ failSubmit: true });
  const outcome = new Map([["c1@1", { translatedText: "译文一" }]]);

  const pending = await runtime.commitOfficialComicTranslations([descriptor("c1", "rk-1")], outcome, "fp-1");

  assert.deepEqual([...pending], ["rk-1"]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].recordKey, "rk-1");
});

test("已经来自官方库的译文不重复提交", async () => {
  const { runtime, submitted } = makeRuntime();
  const outcome = new Map([["c1@1", { translatedText: "官方译文", official: true }]]);

  const pending = await runtime.commitOfficialComicTranslations([descriptor("c1", "rk-1")], outcome, "fp-1");

  assert.equal(pending.size, 0);
  assert.equal(submitted.length, 0);
});

// 上一轮把官方库提交改成后台不 await 之后，pending 集合被丢掉、`pendingRecordKeys`
// 成了永远为空的死集合。这里锁住接回来的形状。
test("漫画提交的 pending 集合真的被消费，不再是死代码", () => {
  const source = readFileSync(new URL("../extension/src/background/modules/ocr-pipeline.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /pendingRecordKeys/u);
  assert.match(source, /const queued = await runtime\.commitOfficialComicTranslations\(/u);
  assert.match(source, /official comic commit queued \$\{queued\.size\} record\(s\) for retry/u);
  assert.match(source, /pending: false/u);
});
