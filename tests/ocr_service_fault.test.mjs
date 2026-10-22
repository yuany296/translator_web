import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPermanentServiceFault, describeServiceFault, isPermanentServiceFault
} from "../extension/src/shared/ocr-service-fault.js";
import { installOcrServiceFault } from "../extension/src/content/modules/ocr-service-fault.js";
import { installRecognitionWorkflow } from "../extension/src/content/modules/recognition-workflow.js";
import { installControlsAutotranslate } from "../extension/src/content/modules/controls-autotranslate.js";
import { installLifecyclePosition } from "../extension/src/content/modules/lifecycle-position.js";

/**
 * 永久性服务故障的判据 + 客户端状态机。
 *
 * 现场：扩展升到 v12、本地服务还是 v11 → 每个 OCR 请求 409 contract mismatch →
 * 恢复扫描（650ms 节流）与自动重试把它当成临时错误，0.5~1.5 秒一轮
 * 「入队→失败→清 loading→再入队」= loading 卡无限闪烁，且没有任何提示。
 */

test("契约不匹配与服务不可用都归类为永久故障，临时失败不算", () => {
  assert.equal(classifyPermanentServiceFault("Local OCR request failed: 409 Conflict"), "mismatch");
  assert.equal(classifyPermanentServiceFault("Local OCR request failed: OCR geometry contract mismatch; restart local-ocr-service"), "mismatch");
  assert.equal(classifyPermanentServiceFault("本地 OCR 服务版本过旧，请重启 local-ocr-service 后重试"), "mismatch");
  assert.equal(classifyPermanentServiceFault("本地 OCR 服务不可用，请先启动 local-ocr-service"), "offline");
  assert.equal(classifyPermanentServiceFault("Failed to fetch"), "offline");
  assert.equal(classifyPermanentServiceFault("Extension context invalidated"), "invalidated");
  // 临时失败：单页识别失败 / 队列超时 / 5xx —— 仍然走自动重试。
  assert.equal(isPermanentServiceFault("Page OCR failed"), false);
  assert.equal(isPermanentServiceFault("Page OCR timed out"), false);
  assert.equal(isPermanentServiceFault("Local OCR request failed: 500 Internal Server Error"), false);
  assert.equal(isPermanentServiceFault(""), false);
});

test("提示文案是可操作的（重启/启动/刷新），不是原始错误回显", () => {
  assert.match(describeServiceFault("Local OCR request failed: 409 Conflict"), /重启 local-ocr-service/u);
  assert.match(describeServiceFault("本地 OCR 服务不可用，请先启动 local-ocr-service"), /启动 local-ocr-service/u);
  assert.match(describeServiceFault("Extension context invalidated"), /刷新漫画页/u);
  assert.equal(describeServiceFault("Page OCR failed"), "");
});

function makeRuntime(extra = {}) {
  const runtime = {
    state: { invalidated: false, enabled: true, autoTranslatePageEnabled: true },
    CONTEXT_INVALIDATED_RE: /extension context invalidated/iu,
    notices: [],
    statuses: [],
    stoppedAuto: 0,
    ...extra
  };
  runtime.showFloatingBallFeedback = (message, level) => runtime.notices.push({ message, level });
  runtime.togglePageAutoTranslate = async enabled => { runtime.stoppedAuto += enabled === false ? 1 : 0; };
  runtime.reportStatus = async (level, message, details) => runtime.statuses.push({ level, message, details });
  installOcrServiceFault(runtime);
  return runtime;
}

test("noteOcrServiceFault：一次提示 + 停自动翻译 + 冷却，冷却期内不重复提示", () => {
  const runtime = makeRuntime();
  assert.equal(runtime.noteOcrServiceFault("Local OCR request failed: 409 Conflict"), true);
  assert.equal(runtime.isOcrServiceFaultActive(), true);
  assert.equal(runtime.notices.length, 1);
  assert.match(runtime.notices[0].message, /重启 local-ocr-service/u);
  assert.equal(runtime.notices[0].level, "error");
  assert.equal(runtime.stoppedAuto, 1, "永久故障要停掉本页自动翻译");
  assert.equal(runtime.statuses[0].details.code, "service-fault");
  // 冷却期内再来一次：不再提示（避免刷屏），但仍算"已按永久故障处理"。
  assert.equal(runtime.noteOcrServiceFault("Local OCR request failed: 409 Conflict"), false);
  assert.equal(runtime.notices.length, 1);
  // 临时错误不进入状态机。
  const other = makeRuntime();
  assert.equal(other.noteOcrServiceFault("Page OCR failed"), false);
  assert.equal(other.isOcrServiceFaultActive(), false);
  assert.equal(other.notices.length, 0);
});

test("冷却期内：自动入队与恢复扫描都不再动作（闪烁的源头）", () => {
  const runtime = makeRuntime();
  // 最小 runtime：除状态机外什么都没有 —— 若没有提前返回，下面会因缺方法直接抛错。
  installControlsAutotranslate(runtime);
  installLifecyclePosition(runtime);
  runtime.noteOcrServiceFault("Local OCR request failed: 409 Conflict");
  assert.equal(runtime.isOcrServiceFaultActive(), true);
  assert.doesNotThrow(() => runtime.queuePageAutoTranslate({ dataset: {} }));
  assert.doesNotThrow(() => runtime.recoverRenderedTargets());
  assert.doesNotThrow(() => runtime.scheduleAutoTranslateRetry({ dataset: {} }));
  // 解除后队列路径恢复（仍会缺能力 → 抛错，说明真的往下走了）。
  runtime.clearOcrServiceFault();
  assert.equal(runtime.isOcrServiceFaultActive(), false);
  assert.throws(() => runtime.queuePageAutoTranslate({ dataset: {} }));
});

test("OCR 成功一次即解除冷却（不必刷新页面）", async () => {
  const runtime = makeRuntime({ clearKakaoLoadingOverlay: () => {}, tracePipeline: () => {} });
  installRecognitionWorkflow(runtime);
  runtime.kakaoCanonicalPipeline = { run: async () => ({ ok: true, bubbles: 0, timings: { total: 12 } }) };
  runtime.noteOcrServiceFault("Local OCR request failed: 409 Conflict");
  assert.equal(runtime.isOcrServiceFaultActive(), true);
  const result = await runtime.runKakaoCanonicalTarget({ dataset: {} }, { reason: "manual" }, false);
  assert.equal(result.ok, true);
  assert.equal(runtime.isOcrServiceFaultActive(), false, "成功一次就要解除冷却");
});
