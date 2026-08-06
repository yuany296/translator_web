import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { normalizeOcrConfig, DEFAULT_OCR_CONFIG } from "../extension/src/config/schema.js";
import { toLegacySettings } from "../extension/src/config/store.js";
import { installTargetResolve } from "../extension/src/content/modules/target-resolve.js";
import { installRecognitionPayload } from "../extension/src/content/modules/recognition-payload.js";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: { runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners }, tabs: {}, storage: { local: {} } },
  console, fetch, URL, Blob, AbortController, atob,
  crypto: webcrypto, setTimeout, clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, { filename: "background.iife.js" });

test("novel images preserve line groups by default and respect the setting", () => {
  const background = context.__backgroundTest;
  const defaultTuning = background.getDefaultOcrTuning();
  assert.equal(defaultTuning.novelImageMergeLines, false);
  assert.equal(background.shouldPreserveLineGroups({ imageMeta: { novelImage: true } }, defaultTuning), true);
  assert.equal(background.shouldPreserveLineGroups({ imageMeta: { novelImage: true } }, { novelImageMergeLines: true }), false);
  assert.equal(background.shouldPreserveLineGroups({ imageMeta: { novelImage: true } }, { novelImageMergeLines: false }), true);
  assert.equal(background.shouldPreserveLineGroups({ imageMeta: {} }, defaultTuning), false);
  assert.equal(background.shouldPreserveLineGroups({ imageMeta: { novelImage: false } }, defaultTuning), false);
});

test("ocr config schema defaults novel images to per-line translation", () => {
  assert.equal(DEFAULT_OCR_CONFIG.tuning.novelImageMergeLines, false);
  assert.equal(normalizeOcrConfig({}).tuning.novelImageMergeLines, false);
  assert.equal(normalizeOcrConfig({ tuning: { novelImageMergeLines: true } }).tuning.novelImageMergeLines, true);
  assert.equal(normalizeOcrConfig({ tuning: { novelImageMergeLines: "yes" } }).tuning.novelImageMergeLines, false);
  const legacy = toLegacySettings({
    ocr: normalizeOcrConfig({ tuning: { novelImageMergeLines: true } }),
    translation: {}, runtime: {}, glossary: {}
  });
  assert.equal(legacy.ocrNovelImageMergeLines, true);
});

test("background keeps the novel-image flag and separates per-line cache entries", () => {
  const background = context.__backgroundTest;
  const meta = background.normalizeImageMeta({ width: 100, height: 100, novelImage: true });
  assert.equal(meta.novelImage, true);
  assert.equal(background.normalizeImageMeta({ width: 100, height: 100 }).novelImage, false);
  const settingsBase = { provider: "local_paddle" };
  const base = { imageDigest: "digest", sourceType: "page", pageIds: ["p"], imageMeta: { width: 100, height: 100 } };
  const mergedKey = background.buildOcrCacheKey({ request: base, settings: settingsBase });
  const lineKey = background.buildOcrCacheKey({
    request: { ...base, imageMeta: { width: 100, height: 100, novelImage: true } },
    settings: settingsBase
  });
  const toggleKey = background.buildOcrCacheKey({
    request: { ...base, imageMeta: { width: 100, height: 100, novelImage: true } },
    settings: { ...settingsBase, ocrNovelImageMergeLines: true }
  });
  assert.notEqual(lineKey, mergedKey, "per-line mode must not reuse the merged cache entry");
  assert.notEqual(toggleKey, lineKey, "turning the merge setting on must invalidate the per-line entry");
});

test("payload image meta carries the novel-image flag for the OCR request", () => {
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const resolveRuntime = {
      getPayloadDisplayRect: () => null
    };
    installTargetResolve(resolveRuntime);
    assert.equal(resolveRuntime.buildPayloadImageMeta({ width: 100, height: 100, novelImage: true }).novelImage, true);
    assert.equal(resolveRuntime.buildPayloadImageMeta({ width: 100, height: 100 }).novelImage, false);
  } finally {
    delete globalThis.window;
  }
});

test("enriched payload marks novel images before OCR dispatch", () => {
  globalThis.HTMLImageElement = class HTMLImageElement {};
  globalThis.HTMLCanvasElement = class HTMLCanvasElement {};
  try {
    const payloadRuntime = {
      getQuickSourceToken: () => "source-token",
      getSourceImageIdForTarget: () => "image-1",
      isNovelImageTarget: target => target.novel === true
    };
    installRecognitionPayload(payloadRuntime);
    const target = {
      naturalWidth: 308,
      naturalHeight: 186,
      novel: true,
      getBoundingClientRect: () => ({ width: 504, height: 304 })
    };
    const payload = payloadRuntime.enrichPayloadForTarget({ width: 1, height: 1 }, target);
    assert.equal(payload.novelImage, true);
    const comic = payloadRuntime.enrichPayloadForTarget({ width: 1, height: 1 }, {
      naturalWidth: 308, naturalHeight: 186,
      getBoundingClientRect: () => ({ width: 100, height: 100 })
    });
    assert.equal(comic.novelImage, undefined);
  } finally {
    delete globalThis.HTMLImageElement;
    delete globalThis.HTMLCanvasElement;
  }
});
