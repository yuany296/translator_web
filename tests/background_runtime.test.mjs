import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  setTimeout,
  clearTimeout
});
vm.runInContext(
  `${source}\nglobalThis.__backgroundTest = { buildLocalPaddleBubbleItems, normalizeBaiduOcrItem, buildLocalSolidPaintBox, mergeOcrCandidateGroup, collapseDuplicateLocalPaddleTranslations, setCache, isTranslationCacheKey, isStorageQuotaError, buildCacheSafeTranslationResult, translationResultNeedsCleanedImage };`,
  context,
  { filename: "background.js" }
);

test("translation cache cleanup recognizes old cache versions and quota errors", () => {
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_cache_v2:abc"), true);
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_cache_v4:def"), true);
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_api_key"), false);
  assert.equal(
    context.__backgroundTest.isStorageQuotaError(new Error("Resource::kQuotaBytes quota exceeded")),
    true
  );
});

test("translation cache excludes large image and debug payloads", () => {
  const result = context.__backgroundTest.buildCacheSafeTranslationResult({
    bubbles: [{ id: "t0", translated_text: "译文" }],
    cleanedImage: "data:image/png;base64,large",
    debug: { rawItems: new Array(100).fill("large") }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    bubbles: [{ id: "t0", translated_text: "译文" }]
  });
});

test("complex-background cache entries retain the cleaned-image requirement", () => {
  const result = context.__backgroundTest.buildCacheSafeTranslationResult({
    bubbles: [{ id: "t0", bg_type: "none", translated_text: "译文" }],
    cleanedImage: "data:image/png;base64,large"
  });

  assert.equal(result.cleanedImage, undefined);
  assert.equal(result.requiresCleanedImage, true);
  assert.equal(context.__backgroundTest.translationResultNeedsCleanedImage(result), true);
});

test("translation cache automatically clears old entries and retries after quota failure", async () => {
  const stored = {
    "mt_cache_v2:old": { timestamp: 1, value: { bubbles: [] } },
    mt_api_key: "keep-setting"
  };
  let writeAttempts = 0;

  context.chrome.storage.local.get = (keys, callback) => {
    callback(keys === null ? { ...stored } : Object.fromEntries(keys.map((key) => [key, stored[key]])));
  };
  context.chrome.storage.local.remove = (keys, callback) => {
    keys.forEach((key) => delete stored[key]);
    callback();
  };
  context.chrome.storage.local.set = (value, callback) => {
    writeAttempts += 1;
    if (writeAttempts === 1) {
      context.chrome.runtime.lastError = { message: "Resource::kQuotaBytes quota exceeded" };
      callback();
      context.chrome.runtime.lastError = null;
      return;
    }
    Object.assign(stored, value);
    callback();
  };

  const cached = await context.__backgroundTest.setCache("mt_cache_v4:new", {
    bubbles: [{ id: "t0", translated_text: "译文" }],
    cleanedImage: "data:image/png;base64,large"
  });

  assert.equal(cached, true);
  assert.equal(writeAttempts, 2);
  assert.equal(stored["mt_cache_v2:old"], undefined);
  assert.equal(stored.mt_api_key, "keep-setting");
  assert.deepEqual(JSON.parse(JSON.stringify(stored["mt_cache_v4:new"].value)), {
    bubbles: [{ id: "t0", translated_text: "译文" }]
  });
});

test("stitched OCR clusters all panel lines before owner filtering", async () => {
  const region = {
    region_id: "region-1",
    region_type: "caption_panel",
    region_polygon: [[100, 220], [500, 220], [500, 380], [100, 380]],
    region_box: { left: 100, top: 220, width: 400, height: 160 },
    bg_color: "#b8a898",
    text_color: "#111111",
    stroke_color: "#ffffff",
    region_confidence: 0.92,
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0
  };
  const payload = {
    imageWidth: 760,
    imageHeight: 900,
    items: [
      { ...region, text: "오오", box: { left: 300, top: 270, width: 120, height: 36 } },
      { ...region, text: "이번 회", box: { left: 285, top: 312, width: 150, height: 36 } },
      { ...region, text: "참가 신청자들!", box: { left: 240, top: 354, width: 240, height: 36 } }
    ]
  };

  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    payload,
    { width: 760, height: 900 },
    "",
    true,
    null,
    undefined,
    null,
    { stitch: { ownerTop: 300, ownerHeight: 300 } }
  );

  assert.equal(result.length, 1);
  assert.match(result[0].words, /오오/);
  assert.match(result[0].words, /이번 회/);
  assert.match(result[0].words, /참가 신청자들!/);
  assert.equal(result[0].sourceLineCount, 3);
});

test("stitched OCR drops a completed cluster owned by the adjacent slice", async () => {
  const payload = {
    imageWidth: 760,
    imageHeight: 900,
    items: [{
      text: "이웃 대사",
      score: 0.98,
      box: { left: 260, top: 120, width: 180, height: 40 },
      region_id: "region-neighbor",
      region_type: "speech_bubble",
      region_polygon: [[220, 80], [480, 80], [480, 200], [220, 200]],
      region_box: { left: 220, top: 80, width: 260, height: 120 },
      bg_color: "#ffffff"
    }]
  };

  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    payload,
    { width: 760, height: 900 },
    "",
    true,
    null,
    undefined,
    null,
    { stitch: { ownerTop: 300, ownerHeight: 300 } }
  );

  assert.equal(result.length, 0);
});

test("adjacent text in different physical panels stays in separate translation groups", async () => {
  const base = {
    score: 0.98,
    region_type: "speech_bubble",
    bg_color: "#ffffff",
    text_color: "#111111",
    stroke_color: "#ffffff"
  };
  const payload = {
    imageWidth: 760,
    imageHeight: 900,
    items: [
      {
        ...base,
        text: "첫 번째 대사",
        box: { left: 120, top: 340, width: 180, height: 42 },
        region_id: "region-left",
        region_polygon: [[80, 300], [330, 300], [330, 430], [80, 430]],
        region_box: { left: 80, top: 300, width: 250, height: 130 }
      },
      {
        ...base,
        text: "두 번째 대사",
        box: { left: 390, top: 345, width: 180, height: 42 },
        region_id: "region-right",
        region_polygon: [[350, 300], [620, 300], [620, 430], [350, 430]],
        region_box: { left: 350, top: 300, width: 270, height: 130 }
      }
    ]
  };

  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    payload,
    { width: 760, height: 900 },
    "",
    true,
    null,
    undefined,
    null,
    { stitch: { ownerTop: 300, ownerHeight: 300 } }
  );

  assert.equal(result.length, 2);
  assert.deepEqual(Array.from(result, (item) => item.localOcrContainerId).sort(), ["region-left", "region-right"]);
});

test("solid regions use a bounded local paint box while outline text keeps the OCR box", () => {
  const normalize = context.__backgroundTest.normalizeBaiduOcrItem;
  const solid = normalize(
    {
      words: "??",
      location: { left: 200, top: 100, width: 100, height: 40 },
      regionBox: { left: 80, top: 60, width: 300, height: 200 },
      adaptiveBackground: { type: "solid", color: "#f8f8f8", confidence: 0.9 },
      regionPolygon: [[80, 60], [380, 60], [380, 260], [80, 260]],
      polygon: [[200, 100], [300, 100], [300, 140], [200, 140]],
      rotation_deg: 12
    },
    0,
    { width: 500, height: 400 }
  );

  assert.equal(solid.bg_type, "solid");
  assert.equal(solid.x, 40);
  assert.equal(solid.y, 25);
  assert.equal(solid.w, 20);
  assert.equal(solid.h, 10);
  assert.equal(JSON.stringify(solid.polygon), JSON.stringify([
    { x: 40, y: 25 }, { x: 60, y: 25 }, { x: 60, y: 35 }, { x: 40, y: 35 }
  ]));
  assert.equal(solid.rotation_deg, 12);
  assert.deepEqual({ ...solid.rawBox }, { left: 200, top: 100, width: 100, height: 40 });
  assert.deepEqual({ ...solid.fill_box }, { x: 38, y: 23.5, w: 24, h: 13 });
  assert.ok(((solid.fill_box.w / 100) * 500) * ((solid.fill_box.h / 100) * 400) <= solid.rawBox.width * solid.rawBox.height * 2);
  assert.equal(JSON.stringify(solid.region_polygon), JSON.stringify([
    { x: 16, y: 15 },
    { x: 76, y: 15 },
    { x: 76, y: 65 },
    { x: 16, y: 65 }
  ]));

  const outline = normalize(
    {
      words: "??",
      location: { left: 200, top: 100, width: 100, height: 40 },
      regionBox: { left: 80, top: 60, width: 300, height: 200 },
      adaptiveBackground: { type: "outline", color: "", confidence: 0 },
      textColor: "#000000",
      strokeColor: "#ffffff"
    },
    1,
    { width: 500, height: 400 }
  );

  assert.equal(outline.bg_type, "none");
  assert.ok(Math.abs(outline.x - 39.8) < 1e-9);
  assert.ok(Math.abs(outline.w - 20.4) < 1e-9);
  assert.equal(outline.text_color, "#000000");
  assert.equal(outline.stroke_color, "#ffffff");
});

test("oversized solid paint boxes downgrade to transparent outline", () => {
  const paintBox = context.__backgroundTest.buildLocalSolidPaintBox(
    { left: 200, top: 100, right: 300, bottom: 140, width: 100, height: 40 },
    { left: 0, top: 0, width: 500, height: 400 },
    { width: 500, height: 400 }
  );

  assert.ok(paintBox);
  assert.ok(paintBox.width * paintBox.height <= 100 * 40 * 2);
});

test("same-line OCR fragments merge their solid paint boxes", () => {
  const merged = context.__backgroundTest.mergeOcrCandidateGroup([
    {
      x: 10, y: 20, w: 20, h: 10,
      fill_box: { x: 8, y: 18.5, w: 24, h: 13 },
      bg_type: "solid", bg_color: "#512014", region_id: "region-line",
      original_text: "옛날", rawBox: { left: 100, top: 80, width: 200, height: 40 }
    },
    {
      x: 35, y: 20, w: 25, h: 10,
      fill_box: { x: 32.5, y: 18.5, w: 30, h: 13 },
      bg_type: "solid", bg_color: "#512014", region_id: "region-line",
      original_text: "미국 토크쇼", rawBox: { left: 350, top: 80, width: 250, height: 40 }
    }
  ], 0);

  assert.equal(merged.bg_type, "solid");
  assert.deepEqual({ ...merged.fill_box }, { x: 8, y: 18.5, w: 54.5, h: 13 });
  assert.ok(merged.fill_box.w * merged.fill_box.h <= merged.w * merged.h * 2);
});

test("overlapping translated substring keeps only the complete sentence", () => {
  const collapse = context.__backgroundTest.collapseDuplicateLocalPaddleTranslations;
  const result = collapse([
    {
      x: 35, y: 20, w: 20, h: 10,
      fill_box: { x: 34, y: 19, w: 22, h: 12 },
      original_text: "아, 물론",
      translated_text: "啊，当然",
      source_line_count: 1
    },
    {
      x: 20, y: 18, w: 60, h: 36,
      fill_box: { x: 18, y: 16, w: 64, h: 40 },
      original_text: "아, 물론 이대로 모든 게 끝나는 건 아닙니다!",
      translated_text: "啊，当然——一切不会就这么结束的！",
      source_line_count: 3
    }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].translated_text, "啊，当然——一切不会就这么结束的！");
  assert.equal(result[0].original_text, "아, 물론 이대로 모든 게 끝나는 건 아닙니다!");
  assert.equal(result[0].source_line_count, 3);
  assert.deepEqual({ ...result[0].fill_box }, { x: 18, y: 16, w: 64, h: 40 });
});

test("translated substring in a separate region is not collapsed", () => {
  const collapse = context.__backgroundTest.collapseDuplicateLocalPaddleTranslations;
  const result = collapse([
    { x: 10, y: 10, w: 20, h: 8, original_text: "아, 물론", translated_text: "啊，当然" },
    { x: 60, y: 60, w: 30, h: 20, original_text: "full", translated_text: "啊，当然还有别的事情" }
  ]);

  assert.equal(result.length, 2);
});
