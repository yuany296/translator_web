import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { installOcrDispatch } from "../extension/src/background/modules/ocr-dispatch.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

/**
 * OCR 缓存键必须包含外观采样算法版本：墨色主色挑选口径修复（白描边像素数恒大于
 * 彩色笔画像素数，旧逻辑把蓝字白边采成"墨色=白"再渲染成黑字白边）之后，旧缓存里
 * 采出的颜色最长还能活 7 天；版本参与键让它们整体失效。
 */
test("appearanceSampleVersion 参与 OCR 缓存键：版本 bump 必须让键变化", () => {
  const runtime = {
    OCR_CACHE_PREFIX: "mt_cache_v28:ocr:",
    LOCAL_OCR_GEOMETRY_VERSION: "geo-test-v5",
    OCR_COORDINATE_MODEL_VERSION: "coord-test",
    stableSerialize: value => JSON.stringify(value),
    stableHash128: source => `hash(${source})`
  };
  installOcrDispatch(runtime);
  const request = {
    imageDigest: "digest-a",
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: { "page-a": "revision-a" },
    imageMeta: { width: 1280, height: 1280, pageSpans: [] }
  };
  const settings = { provider: "local_paddle", localOcrBaseUrl: "http://127.0.0.1:8765" };
  const serialized = [];
  runtime.stableSerialize = value => {
    serialized.push(value);
    return JSON.stringify(value);
  };

  const first = runtime.buildOcrCacheKey({ request, settings });
  const second = runtime.buildOcrCacheKey({ request, settings });
  assert.equal(first, second, "同参数键必须稳定");
  assert.ok(first.startsWith("mt_cache_v28:ocr:digest-a:"));
  assert.equal(serialized[0].appearanceSampleVersion, 4, "外观采样算法版本必须进键");
  assert.equal(serialized[0].observationSchemaVersion, 1, "observation 结构版本必须进键");
  assert.equal(serialized[0].geometryVersion, "geo-test-v5", "与几何版本同层参与键");

  // 版本 bump（唯一变量）→ 序列化源变化 → 键变化：旧缓存失效的旋钮真的接上了。
  runtime.stableSerialize = value => JSON.stringify({ ...value, appearanceSampleVersion: 99 });
  assert.notEqual(runtime.buildOcrCacheKey({ request, settings }), first,
    "appearanceSampleVersion 变化必须改变 OCR 缓存键");

  // 接线断言：字段必须引用模块常量（防止将来有人删字段或写死值漏 bump）。
  const source = fs.readFileSync(
    path.join(projectRoot, "extension", "src", "background", "modules", "ocr-dispatch.js"), "utf8");
  assert.match(source, /appearanceSampleVersion: APPEARANCE_SAMPLE_VERSION/u);
  assert.match(source, /const APPEARANCE_SAMPLE_VERSION = 4;/u);
  assert.match(source, /observationSchemaVersion: OBSERVATION_SCHEMA_VERSION/u);
  assert.match(source, /const OBSERVATION_SCHEMA_VERSION = 1;/u);
});
