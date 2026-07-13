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
  `${source}\nglobalThis.__backgroundTest = { buildLocalPaddleBubbleItems, clusterLocalPaddleWords, shouldMergeLocalPaddleSameLine, shouldMergeLocalPaddleParagraphLines, collectSourceImageOcrPayload, buildBlockTranslationCacheKey, normalizeBaiduOcrItem, buildLocalSolidPaintBox, mergeOcrCandidateGroup, collapseDuplicateLocalPaddleTranslations, setCache, isTranslationCacheKey, isStorageQuotaError, buildCacheSafeTranslationResult, translationResultNeedsCleanedImage, buildCacheKey, buildLocalOcrDebugId, normalizeImageMeta };`,
  context,
  { filename: "background.js" }
);

test("translation cache cleanup recognizes old cache versions and quota errors", () => {
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_cache_v2:abc"), true);
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_cache_v4:def"), true);
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_api_key"), false);
  assert.match(context.__backgroundTest.buildCacheKey({ dataUrl: "" }), /^mt_cache_v14:/);
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

test("translation cache key separates OCR mode, source token, and fallback reason", () => {
  const base = {
    provider: "local_paddle_deepseek",
    model: "model",
    baseUrl: "https://api.example.test",
    captureMode: "direct",
    localOcrBaseUrl: "http://127.0.0.1:8765",
    localOcrLang: "korean",
    localOcrMode: "enhanced",
    imageUrl: "https://page-edge.kakao.com/sdownload/resource?kid=a",
    targetKey: "owner-key",
    dataUrl: "data:image/png;base64,AAAA"
  };

  const stitch = context.__backgroundTest.buildCacheKey({
    ...base,
    ocrMode: "stitch",
    sourceToken: "https://page-edge.kakao.com/sdownload/resource?kid=a"
  });
  const fallback = context.__backgroundTest.buildCacheKey({
    ...base,
    ocrMode: "single-fallback",
    sourceToken: "https://page-edge.kakao.com/sdownload/resource?kid=a",
    fallbackReason: "stitched OCR dropped all bubbles"
  });
  const reusedNode = context.__backgroundTest.buildCacheKey({
    ...base,
    ocrMode: "stitch",
    sourceToken: "https://page-edge.kakao.com/sdownload/resource?kid=b"
  });

  assert.notEqual(stitch, fallback);
  assert.notEqual(stitch, reusedNode);
});

test("local OCR debug id includes OCR request mode", () => {
  const meta = context.__backgroundTest.normalizeImageMeta({
    width: 760,
    height: 1000,
    ocrMode: "single-fallback",
    fallbackReason: "stitched OCR dropped all bubbles"
  });
  const debugId = context.__backgroundTest.buildLocalOcrDebugId("owner-key", meta);

  assert.match(debugId, /mode-single-fallback/);
  assert.match(debugId, /reason-/);
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

test("fragmented caption regions and unassigned words merge into complete paragraphs", async () => {
  const region = (id, box) => ({
    region_id: id,
    region_type: "caption_panel",
    region_box: box,
    region_polygon: [
      [box.left, box.top],
      [box.left + box.width, box.top],
      [box.left + box.width, box.top + box.height],
      [box.left, box.top + box.height]
    ],
    bg_color: "#000000",
    text_color: "#fcfcfc",
    stroke_color: "#000000",
    region_confidence: 0.94
  });
  const upperLeft = region("upper-left", { left: 27, top: 278, width: 260, height: 180 });
  const upperRight = region("upper-right", { left: 298, top: 281, width: 463, height: 266 });
  const lower = region("lower", { left: 568, top: 601, width: 189, height: 116 });
  const item = (text, left, top, width, height, extra = {}) => ({
    text,
    box: { left, top, width, height },
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0,
    ...extra
  });
  const payload = {
    imageWidth: 760,
    imageHeight: 1380,
    items: [
      item("middle", 249, 336, 115, 62),
      item("upper left", 76, 338, 163, 59, upperLeft),
      item("upper right", 383, 339, 260, 56, upperRight),
      item("second middle", 298, 433, 137, 59),
      item("second left", 79, 434, 209, 56),
      item("second right", 456, 434, 221, 56, upperRight),
      item("third left", 77, 530, 306, 56),
      item("third right", 368, 530, 105, 58),
      item("lower heading", 603, 640, 118, 38, lower),
      item("lower line one", 298, 696, 420, 37),
      item("lower line two", 435, 753, 283, 33),
      item("lower line three", 263, 806, 455, 38),
      item("lower last right", 524, 861, 193, 37),
      item("lower last left", 337, 864, 184, 33)
    ]
  };

  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    payload,
    { width: 760, height: 1380 },
    "",
    false
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].sourceLineCount, 3);
  assert.equal(result[1].sourceLineCount, 5);
  assert.match(result[0].words, /upper left/);
  assert.match(result[0].words, /third right/);
  assert.match(result[1].words, /lower heading/);
  assert.match(result[1].words, /lower last right/);
  assert.equal(result[0].adaptiveBackground.type, "solid");
  assert.equal(result[1].adaptiveBackground.type, "solid");
  assert.equal(result[0].localOcrContainerId, "");
});

test("global OCR line dedupe keeps the strongest overlapping recognition", () => {
  const debug = {};
  const result = context.__backgroundTest.clusterLocalPaddleWords([
    {
      words: "같은 문장입니다",
      confidence: 0.96,
      location: { left: 100, top: 80, width: 220, height: 40 }
    },
    {
      words: "같은문장입니다",
      confidence: 0.72,
      location: { left: 103, top: 81, width: 216, height: 39 }
    }
  ], { width: 760, height: 900 }, null, debug);

  assert.equal(result.length, 1);
  assert.equal(debug.dedupedItems.length, 1);
  assert.equal(debug.duplicateItems.length, 1);
  assert.equal(result[0].confidence, 0.96);
});

test("same-line merge accepts emphasis colors but rejects a title-sized fragment", () => {
  const box = (left, top, width, height) => ({
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    centerX: left + width / 2,
    centerY: top + height / 2
  });
  const base = {
    text: "강조",
    rotation: 0,
    container: null,
    box: box(100, 100, 120, 40)
  };
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleSameLine(
    { ...base, kind: "effectText", color: { redScore: 0.8 } },
    { ...base, text: "문장", kind: "normalOutsideText", color: { redScore: 0 }, box: box(230, 102, 100, 38) }
  ), true);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleSameLine(
    base,
    { ...base, text: "작은 본문", box: box(230, 112, 100, 20) }
  ), false);
});

test("paragraph merge rejects large whitespace, title/body scale, remote columns, and Chinese overlays", () => {
  const box = (left, top, width, height) => ({
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    centerX: left + width / 2,
    centerY: top + height / 2
  });
  const entry = (text) => ({ text, container: null });
  const line = (text, left, top, width, height) => ({
    text,
    rotation: 0,
    box: box(left, top, width, height),
    entries: [entry(text)]
  });
  const first = line("첫 번째 줄", 100, 100, 300, 40);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(
    first,
    line("두 번째 줄", 110, 148, 285, 42)
  ), true);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("먼 줄", 110, 210, 285, 42)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("작은 본문", 110, 148, 285, 20)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("오른쪽 글", 500, 148, 220, 40)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("中文覆盖层", 110, 148, 285, 40)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(
    first,
    { ...line("가운데 기울임", 165, 148, 170, 55), rotation: -7 }
  ), true);
});

test("slanted edge lettering stays separate from aligned dialog text in the same detected region", async () => {
  const region = {
    region_id: "region-dialog",
    region_type: "caption_panel",
    region_box: { left: 130, top: 230, width: 505, height: 335 },
    region_polygon: [[130, 230], [635, 230], [635, 565], [130, 565]],
    bg_color: "#ffffff",
    text_color: "#0c0c0c",
    stroke_color: "#ffffff",
    region_confidence: 0.98,
    score: 0.98,
    det_score: 0.91
  };
  const item = (text, left, top, width, height, rotation_deg = 0) => ({
    ...region,
    text,
    rotation_deg,
    box: { left, top, width, height }
  });
  const payload = {
    imageWidth: 760,
    imageHeight: 1700,
    items: [
      item("그래도", 300, 285, 100, 51),
      item("아직타이틀곡", 256, 338, 186, 48),
      item("무대는 남았으니까", 223, 390, 250, 47),
      item("같이보자", 404, 448, 138, 65, -6.96)
    ]
  };

  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    payload,
    { width: 760, height: 1700 },
    "",
    false
  );

  assert.equal(result.length, 2, JSON.stringify(result.map((entry) => entry.words)));
  assert.deepEqual(JSON.parse(JSON.stringify(result.map((entry) => entry.sourceLineCount))), [3, 1]);
  assert.match(result[0].words, /무대는 남았으니까/);
  assert.doesNotMatch(result[0].words, /같이보자/);
  assert.match(result[1].words, /같이보자/);
});

test("Kakao comment panel keeps every long standalone OCR row", async () => {
  const item = (text, left, top, width, height) => ({
    text,
    score: 0.96,
    det_score: 0.92,
    rotation_deg: 0,
    region_type: "effect_text",
    box: { left, top, width, height }
  });
  const payload = {
    imageWidth: 760,
    imageHeight: 1700,
    items: [
      item("솔직히편집이개노잼이었음N", 53, 407, 367, 34),
      item("자막너무오글거려", 49, 490, 244, 45),
      item("저 구성과 컨셉으로 지루한것도 신기하더라", 53, 584, 493, 32),
      item("테스타도나오고그외남돌라이징들다나왔는데", 53, 627, 579, 34),
      item("국대출신 아이돌도 있었는데 화면을 그거밖에 못뽑아내", 55, 717, 657, 34),
      item("유튜브에서 팬들이 재편집해놨는데 그거봐봐 존잼임", 55, 806, 597, 32),
      item("화랑소재는잘잡아놓고ㅠㅠㅠ", 53, 892, 384, 34),
      item("가나다라", 30, 960, 700, 20)
    ]
  };

  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    payload,
    { width: 760, height: 1700 },
    "",
    false
  );
  const texts = result.map((entry) => entry.words);

  assert.equal(result.length, 6, JSON.stringify(texts));
  assert.ok(texts.some((text) => text.includes("국대출신 아이돌도")));
  assert.ok(texts.some((text) => text.includes("유튜브에서 팬들이")));
  assert.ok(!texts.some((text) => text.includes("가나다라")));
});

test("screenshot crop OCR coordinates accumulate in the original image space", () => {
  const payload = context.__backgroundTest.collectSourceImageOcrPayload(
    {
      imageWidth: 400,
      imageHeight: 300,
      items: [{ text: "원문", score: 0.9, box: { left: 40, top: 30, width: 80, height: 60 } }]
    },
    { width: 400, height: 300 },
    {
      coordinateSpace: "source-image-v1",
      sourceImageId: "image-a",
      sourceWidth: 800,
      sourceHeight: 1200,
      targetCssWidth: 400,
      targetCssHeight: 600,
      cropCssX: 0,
      cropCssY: 150,
      cropCssWidth: 400,
      cropCssHeight: 300,
      stitch: null
    }
  );

  assert.equal(payload.imageWidth, 800);
  assert.equal(payload.imageHeight, 1200);
  assert.deepEqual({ ...payload.items[0].box }, { left: 80, top: 360, width: 160, height: 120 });
});

test("block translation cache key depends on source image, normalized text, and bbox", () => {
  const item = { original_text: " 같은 문장 ", rawBox: { left: 10, top: 20, width: 30, height: 40 } };
  const first = context.__backgroundTest.buildBlockTranslationCacheKey("source-a", item, "model", "base");
  const normalized = context.__backgroundTest.buildBlockTranslationCacheKey("source-a", { ...item, original_text: "같은문장" }, "model", "base");
  const moved = context.__backgroundTest.buildBlockTranslationCacheKey("source-a", { ...item, rawBox: { left: 20, top: 20, width: 30, height: 40 } }, "model", "base");
  const otherImage = context.__backgroundTest.buildBlockTranslationCacheKey("source-b", item, "model", "base");
  assert.equal(first, normalized);
  assert.notEqual(first, moved);
  assert.notEqual(first, otherImage);
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

  // Stitch ownership filtering moved to content.js mapKakaoStitchedResult();
  // background.js no longer pre-filters — all clustered items pass through.
  assert.equal(result.length, 1);
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

test("lightly touching translated substring boxes keep only the complete sentence", () => {
  const collapse = context.__backgroundTest.collapseDuplicateLocalPaddleTranslations;
  const result = collapse([
    { x: 35, y: 20, w: 20, h: 8, original_text: "short", translated_text: "啊，当然" },
    { x: 25, y: 27, w: 50, h: 24, original_text: "full", translated_text: "啊，当然一切不会这样结束" }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].translated_text, "啊，当然一切不会这样结束");
});

test("translated substring in a separate region is not collapsed", () => {
  const collapse = context.__backgroundTest.collapseDuplicateLocalPaddleTranslations;
  const result = collapse([
    { x: 10, y: 10, w: 20, h: 8, original_text: "아, 물론", translated_text: "啊，当然" },
    { x: 60, y: 60, w: 30, h: 20, original_text: "full", translated_text: "啊，当然还有别的事情" }
  ]);

  assert.equal(result.length, 2);
});
