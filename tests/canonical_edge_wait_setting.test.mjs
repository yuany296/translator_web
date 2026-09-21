import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_RUNTIME_CONFIG, normalizeRuntimeConfig } from "../extension/src/config/schema.js";

const source = relative => readFileSync(new URL(`../extension/src/${relative}`, import.meta.url), "utf8");
const translateSource = source("canonical/canonical-pipeline-factory/canonical-translate.js");
const configureSource = source("content/configure.js");
const readerApiSource = source("content/modules/reader-api.js");

// 边缘 canonical（贴着页面上下边的文字）默认必须等邻页 seam 结算后再翻译：
// 跨页句子只请求一次、上下文完整。这是既有契约，6 个 kakao pipeline 测试在守它。
test("边缘等待策略默认关闭，只有显式 true 才打开", () => {
  assert.equal(DEFAULT_RUNTIME_CONFIG.edgeTranslateWithoutWaiting, false);
  assert.equal(normalizeRuntimeConfig({}).edgeTranslateWithoutWaiting, false);
  assert.equal(normalizeRuntimeConfig({ edgeTranslateWithoutWaiting: "true" }).edgeTranslateWithoutWaiting, false);
  assert.equal(normalizeRuntimeConfig({ edgeTranslateWithoutWaiting: 1 }).edgeTranslateWithoutWaiting, false);
  assert.equal(normalizeRuntimeConfig({ edgeTranslateWithoutWaiting: true }).edgeTranslateWithoutWaiting, true);
});

test("开关关闭时 eligible 仍然剔除边缘 canonical", () => {
  assert.match(
    translateSource,
    /canonical\.status !== "filtered" && \(runtime\.edgeTranslateWithoutWaiting === true \|\| !scope\.canonicalWaitsForEdge\(canonical\)\)/u
  );
  // 兜底等待只在「邻页已经在跑」时保留，避免分页阅读器白等满超时。
  assert.match(translateSource, /if \(runtime\.edgeTranslateWithoutWaiting !== true\) return true;/u);
  assert.match(translateSource, /const neighborInFlight = relevant\.some\(/u);
});

test("开关打开时才把边缘 canonical 的投影标成 provisional", () => {
  assert.match(
    translateSource,
    /const edgeWaitingIds = runtime\.edgeTranslateWithoutWaiting === true \? edgeWaitingCanonicalIds\(\) : null;/u
  );
  assert.match(translateSource, /provisional: true,\s*\n\s*edgePending: true/u);
});

test("runtime 配置把开关送进内容脚本，兜底等待从 8s 降到 3s", () => {
  assert.match(configureSource, /runtime\.edgeTranslateWithoutWaiting = config\.edgeTranslateWithoutWaiting === true;/u);
  assert.match(readerApiSource, /edgeWaitTimeoutMs: 3000/u);
  assert.doesNotMatch(readerApiSource, /edgeWaitTimeoutMs: 8000/u);
});
