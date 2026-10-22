import assert from "node:assert/strict";
import test from "node:test";
import { installControlsAutotranslate } from "../extension/src/content/modules/controls-autotranslate.js";

function makeRuntime() {
  const queued = [];
  const runtime = {
    state: { autoTranslatePageEnabled: true, enabled: true, invalidated: false },
    IS_STRIP_TILE_READER: false,
    isOcrServiceFaultActive: () => false,
    isSupportedTarget: () => true,
    maybeQueueKakaoShortPageAttachmentOwner: () => false,
    isKakaoShortPageQueueBlocked: () => false,
    computeTargetKey: () => "target-key",
    buildTargetSourceCacheKey: (key, source) => `${key}|${source}`,
    getQuickSourceToken: () => "source-token",
    isTranslationRecoveryDue: () => true,
    passesTargetFilter: () => true,
    debugTargetFilter: () => {},
    tracePipeline: () => {},
    isScreenshotCaptureMode: () => false,
    queueTranslate: (target, options) => queued.push({ target, options })
  };
  installControlsAutotranslate(runtime);
  return { runtime, queued };
}

test("settled no-text pages are rechecked once per scoped source", () => {
  const { runtime, queued } = makeRuntime();
  const target = { dataset: { mtNoTextKey: "target-key|source-token" }, isConnected: true };
  assert.equal(runtime.retrySettledNoTextOnce(target, "target-key|source-token"), true);
  assert.equal(target.dataset.mtNoTextKey, undefined);
  assert.equal(target.dataset.mtNoTextRetryKey, "target-key|source-token");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].options.reason, "page-auto");

  assert.equal(runtime.retrySettledNoTextOnce(target, "target-key|source-token"), false);
  assert.equal(queued.length, 1, "同一个 source 只允许重查一次");
});

test("a new source token is allowed to trigger one new no-text recheck", () => {
  const { runtime, queued } = makeRuntime();
  const target = { dataset: { mtNoTextKey: "target-key|source-a" }, isConnected: true };
  assert.equal(runtime.retrySettledNoTextOnce(target, "target-key|source-a"), true);
  target.dataset.mtNoTextKey = "target-key|source-b";
  assert.equal(runtime.retrySettledNoTextOnce(target, "target-key|source-b"), true);
  assert.equal(queued.length, 2);
});
