import assert from "node:assert/strict";
import test from "node:test";
import { installBackgroundState } from "../extension/src/background/modules/background-state.js";
import { DEFAULT_RUNTIME_CONFIG } from "../extension/src/config/schema.js";

/**
 * 后台只该有**一份**兜底默认值表，且它只服务 OCR/覆盖微调。
 * 以前 background-state.js 另抄了一份 provider/apiKey/baseUrl/采集与渲染模式等默认值，
 * 与 config/schema.js 各说各话（provider 这里是 baidu、那边是 local_paddle），
 * 那份拷贝还没有任何读取方 —— 这里把"只有一份、且值一致"钉住。
 */

function installState() {
  const runtime = {
    glossaryCore: { STORAGE_KEY: "mt_glossary_test", LEGACY_STORAGE_KEY: "mt_glossary_test_v1" },
    termDiscoveryCore: { PENDING_STORAGE_KEY: "pending", IGNORED_STORAGE_KEY: "ignored" }
  };
  installBackgroundState(runtime);
  return runtime;
}

test("后台兜底默认值只保留 ocr-item-filter 真正读取的键", () => {
  const { DEFAULT_SETTINGS } = installState();
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), [
    "debugOverlayMode", "ocrConfidenceThreshold", "ocrMaxAspectRatio", "ocrMaxBoxArea",
    "ocrMergeLineGap", "ocrMinBoxArea", "ocrMinBoxHeight", "ocrMinBoxWidth",
    "ocrNovelImageMergeLines", "overwriteCoverPadding", "overwriteFontScale", "overwritePreviewMode"
  ]);
  // 第二份 provider/apiKey/采集与渲染模式默认值不得再出现
  for (const stale of ["provider", "model", "apiKey", "baseUrl", "localOcrBaseUrl",
    "captureMode", "renderMode", "pretranslateMode", "visionOcrEnabled", "floatingSide"]) {
    assert.equal(stale in DEFAULT_SETTINGS, false, `DEFAULT_SETTINGS 不该再有 ${stale}`);
  }
});

test("兜底默认值与 config/schema.js 的配置默认值一致", () => {
  const { DEFAULT_SETTINGS } = installState();
  assert.equal(DEFAULT_SETTINGS.overwriteCoverPadding, DEFAULT_RUNTIME_CONFIG.overwriteCoverPadding);
  assert.equal(DEFAULT_SETTINGS.overwriteFontScale, DEFAULT_RUNTIME_CONFIG.overwriteFontScale);
  assert.equal(DEFAULT_SETTINGS.debugOverlayMode, DEFAULT_RUNTIME_CONFIG.debugOverlayMode);
  assert.equal(DEFAULT_SETTINGS.overwritePreviewMode, DEFAULT_RUNTIME_CONFIG.overwritePreviewMode);
});
