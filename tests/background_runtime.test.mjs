import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const glossarySource = fs.readFileSync(path.join(root, "glossary-core.js"), "utf8");
const termDiscoverySource = fs.readFileSync(path.join(root, "term-discovery-core.js"), "utf8");
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
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(
  `${glossarySource}\n${termDiscoverySource}\n${source}\nglobalThis.__backgroundTest = { buildLocalPaddleBubbleItems, clusterLocalPaddleWords, shouldMergeLocalPaddleSameLine, shouldMergeLocalPaddleParagraphLines, coalesceOverlappingOcrCandidates, collectSourceImageOcrPayload, buildBlockTranslationCacheKey, buildCanonicalTranslationFingerprint, buildOpenAICompatibleTranslationPrompt, buildOcrCacheKey, buildProviderNeutralObservationResult, filterSeamOcrCandidates, stableHash128, normalizeProvider, normalizeBaiduOcrItem, buildLocalSolidPaintBox, mergeOcrCandidateGroup, collapseDuplicateLocalPaddleTranslations, getDefaultOcrTuning, getOcrWordDropReason, getFinalCandidateDropReason, setCache, isTranslationCacheKey, isStorageQuotaError, buildCacheSafeTranslationResult, buildCacheSafeOcrResult, translationResultNeedsCleanedImage, buildCacheKey, buildLocalOcrDebugId, normalizeImageMeta, normalizeCleanedMasks, buildCleanedMasksFingerprint, handleOcrDataUrl, handleTranslateTextBlocks, requestCanonicalTextTranslations, requestLegacyTranslatedResultFromOcr, requestLocalPaddleOcr, sendOpenAICompatibleTranslationRequest, sendOpenAICompatibleOnce, setBackgroundTestHooks, isTermExtractorCoolingDown, markTermExtractorOffline, markTermExtractorOnline, getTermExtractorStatusSnapshot, handleConfirmTermCandidates, handleDiscoverTerms, detectLocalPaddleRegionType };`,
  context,
  { filename: "background.js" }
);

test("term extractor enters cooldown after failure and recovers after success", () => {
  const background = context.__backgroundTest;
  background.markTermExtractorOffline(new Error("offline"), 1000);
  assert.equal(background.isTermExtractorCoolingDown(1001), true);
  assert.equal(background.getTermExtractorStatusSnapshot().state, "offline");
  background.markTermExtractorOnline(2000);
  assert.equal(background.isTermExtractorCoolingDown(2001), false);
  assert.equal(background.getTermExtractorStatusSnapshot().state, "online");
});

test("confirming a pending candidate writes the formal glossary and removes every same-source candidate", async () => {
  const stored = {
    mt_glossary_v1: { entries: [] },
    mt_glossary_pending_v1: {
      chapters: [
        {
          key: "https://example.test/chapter/1",
          url: "https://example.test/chapter/1",
          candidates: [{ source: "성현", kind: "proper_noun", score: 0.9 }]
        },
        {
          key: "https://example.test/chapter/2",
          url: "https://example.test/chapter/2",
          candidates: [{ source: "성현", kind: "proper_noun", score: 0.9 }]
        }
      ]
    }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map((key) => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };

  const response = await context.__backgroundTest.handleConfirmTermCandidates({
    entries: [{ source: "성현", target: "成贤", note: "角色名" }, { source: "空项", target: "" }]
  });

  assert.equal(response.ok, true);
  assert.equal(stored.mt_glossary_v1.entries.length, 1);
  assert.equal(stored.mt_glossary_v1.entries[0].target, "成贤");
  assert.equal(stored.mt_glossary_pending_v1.chapters.every((chapter) => chapter.candidates.length === 0), true);
});

test("confirming an edited source stores the correction and removes the original partial candidate", async () => {
  const stored = {
    mt_glossary_v1: { entries: [] },
    mt_glossary_pending_v1: {
      chapters: [
        {
          key: "https://example.test/chapter/name-fix",
          url: "https://example.test/chapter/name-fix",
          candidates: [
            { source: "김솔", kind: "proper_noun", score: 0.9 },
            { source: "김솔음", kind: "person", score: 0.8 }
          ]
        }
      ]
    }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map((key) => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };

  const response = await context.__backgroundTest.handleConfirmTermCandidates({
    entries: [{ candidateSource: "김솔", source: "김솔음", target: "金索音" }]
  });

  assert.equal(response.ok, true);
  assert.equal(stored.mt_glossary_v1.entries[0].source, "김솔음");
  assert.equal(stored.mt_glossary_v1.entries[0].target, "金索音");
  assert.equal(stored.mt_glossary_pending_v1.chapters.length, 0);
});

test("offline term discovery cools down without surfacing a translation failure", async () => {
  const stored = {
    mt_term_discovery_enabled: true,
    mt_glossary_v1: { entries: [] },
    mt_glossary_pending_v1: { chapters: [] },
    mt_glossary_ignored_v1: { sources: [] },
    mt_local_ocr_base_url: "http://127.0.0.1:8765"
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map((key) => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  let fetchCount = 0;
  context.fetch = async () => {
    fetchCount += 1;
    throw new Error("connection refused");
  };
  context.__backgroundTest.markTermExtractorOnline();
  const request = {
    pageUrl: "https://example.test/chapter/3",
    targetKey: "image-1",
    blocks: [{ id: "b1", originalText: "김성현", translatedText: "金成贤" }]
  };

  const first = await context.__backgroundTest.handleDiscoverTerms(request);
  const second = await context.__backgroundTest.handleDiscoverTerms(request);

  assert.equal(first.ok, true);
  assert.equal(first.reason, "offline");
  assert.equal(second.reason, "cooldown");
  assert.equal(fetchCount, 1);
});

test("translation cache cleanup recognizes old cache versions and quota errors", () => {
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_cache_v2:abc"), true);
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_cache_v4:def"), true);
  assert.equal(context.__backgroundTest.isTranslationCacheKey("mt_api_key"), false);
  assert.match(context.__backgroundTest.buildCacheKey({ dataUrl: "" }), /^mt_cache_v21:/);
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

test("chat-style metadata and body keep separate visual/font candidates", async () => {
  const item = (text, left, top, width, height) => ({
    text,
    box: { left, top, width, height },
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    {
      imageWidth: 760,
      imageHeight: 900,
      items: [
        item("사용자", 100, 100, 110, 20),
        item("오후 5:14", 225, 100, 90, 18),
        item("아 밥에 미친 서호윤", 100, 128, 300, 43)
      ]
    },
    { width: 760, height: 900 },
    "",
    false
  );

  assert.equal(result.length, 2);
  const metadata = result.find((row) => row.nonTranslate === true);
  const body = result.find((row) => row.words.includes("서호윤"));
  assert.ok(metadata);
  assert.ok(body);
  assert.match(metadata.words, /오후 5:14/);
  assert.equal(body.nonTranslate, false);
  assert.ok(Number(metadata.fontHeight) < Number(body.fontHeight));
});

test("OCR polygon supplies a fallback tilt angle when the provider omits rotation", () => {
  const result = context.__backgroundTest.clusterLocalPaddleWords([
    {
      words: "기울어진 글자",
      confidence: 0.98,
      location: { left: 100, top: 100, width: 220, height: 40 },
      polygon: [
        { x: 100, y: 100 },
        { x: 316, y: 138 },
        { x: 310, y: 178 },
        { x: 94, y: 140 }
      ]
    }
  ], { width: 760, height: 900 }, null, null);

  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].rotation_deg - 10) < 0.5);
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

test("short Hangul utterances inside reliable speech bubbles survive every OCR filter", async () => {
  const cases = [
    {
      name: "single-syllable reply",
      // 短页作为相邻页拼入高画布后，文字框本身不变，但面积占比会显著下降。
      imageSize: { width: 864, height: 1616 },
      text: "…!네!",
      score: 0.7288035750389099,
      box: { left: 608, top: 9, width: 115, height: 65 },
      regionBox: { left: 574.11, top: 0, width: 181.89, height: 140.97 },
      regionConfidence: 0.9921
    },
    {
      name: "single-syllable hesitation",
      imageSize: { width: 760, height: 1350 },
      text: "음.",
      score: 0.8876966834068298,
      box: { left: 288, top: 1246, width: 46, height: 46 },
      regionBox: { left: 273.55, top: 1199.01, width: 76.38, height: 140.33 },
      regionConfidence: 0.9981
    },
    {
      name: "two-syllable reply",
      imageSize: { width: 760, height: 1350 },
      text: "나도.",
      score: 0.8707183003425598,
      box: { left: 514, top: 70, width: 71, height: 44 },
      regionBox: { left: 492.04, top: 24.87, width: 115.46, height: 135 },
      regionConfidence: 0.9607
    }
  ];

  for (const item of cases) {
    const region = {
      region_id: "speech-region",
      region_type: "speech_bubble",
      region_box: item.regionBox,
      region_polygon: [
        [item.regionBox.left, item.regionBox.top],
        [item.regionBox.left + item.regionBox.width, item.regionBox.top],
        [item.regionBox.left + item.regionBox.width, item.regionBox.top + item.regionBox.height],
        [item.regionBox.left, item.regionBox.top + item.regionBox.height]
      ],
      bg_color: "#ffffff",
      region_confidence: item.regionConfidence
    };
    const merged = await context.__backgroundTest.buildLocalPaddleBubbleItems(
      {
        imageWidth: item.imageSize.width,
        imageHeight: item.imageSize.height,
        items: [{ ...region, text: item.text, score: item.score, box: item.box }]
      },
      item.imageSize,
      "",
      false
    );

    assert.equal(merged.length, 1, `${item.name}: cluster stage`);
    const candidate = context.__backgroundTest.normalizeBaiduOcrItem(merged[0], 0, item.imageSize);
    assert.equal(
      context.__backgroundTest.getFinalCandidateDropReason(
        candidate,
        item.imageSize,
        context.__backgroundTest.getDefaultOcrTuning(),
        "local_paddle"
      ),
      "",
      `${item.name}: final stage`
    );
  }
});

test("isolated or weak tiny Hangul remains filtered as noise", async () => {
  const imageSize = { width: 760, height: 1350 };
  const cases = [
    { name: "no region" },
    {
      name: "caption panel",
      region_id: "caption-region",
      region_type: "caption_panel",
      region_confidence: 0.9981
    },
    {
      name: "weak speech-bubble region",
      region_id: "weak-region",
      region_type: "speech_bubble",
      region_confidence: 0.7
    },
    {
      name: "weak OCR",
      region_id: "speech-region",
      region_type: "speech_bubble",
      region_confidence: 0.9981,
      score: 0.55
    }
  ];

  for (const item of cases) {
    const merged = await context.__backgroundTest.buildLocalPaddleBubbleItems(
      {
        imageWidth: imageSize.width,
        imageHeight: imageSize.height,
        items: [{
          text: "음.",
          score: item.score ?? 0.8876966834068298,
          box: { left: 288, top: 1246, width: 46, height: 46 },
          ...item
        }]
      },
      imageSize,
      "",
      false
    );

    assert.equal(merged.length, 0, item.name);
  }
});

test("slanted edge lettering stays separate across owner and adjacent-page OCR variants", async () => {
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
  const variants = [
    [
      item("그래도", 300, 285, 100, 51),
      item("아직타이틀곡", 256, 338, 186, 48),
      item("무대는 남았으니까", 223, 390, 250, 47),
      item("같이보자", 404, 448, 138, 65, -6.96)
    ],
    [
      item("그래도", 301, 1289, 97, 44),
      item("아직타이틀곡", 258, 1342, 182, 43),
      item("무대는 남았으니까", 225, 1390, 246, 48),
      item("같이보자", 408, 1455, 132, 55, -4.47)
    ]
  ];

  for (const items of variants) {
    const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
      { imageWidth: 760, imageHeight: 1700, items },
      { width: 760, height: 1700 },
      "",
      false
    );

    assert.equal(result.length, 2, JSON.stringify(result.map((entry) => entry.words)));
    assert.deepEqual(JSON.parse(JSON.stringify(result.map((entry) => entry.sourceLineCount))), [3, 1]);
    assert.match(result[0].words, /무대는 남았으니까/);
    assert.doesNotMatch(result[0].words, /같이보자/);
    assert.match(result[1].words, /같이보자/);

    const finalCandidates = context.__backgroundTest.coalesceOverlappingOcrCandidates(
      result.map((entry, index) => context.__backgroundTest.normalizeBaiduOcrItem(
        entry,
        index,
        { width: 760, height: 1700 }
      ))
    );
    assert.equal(finalCandidates.length, 2, JSON.stringify(finalCandidates.map((entry) => entry.original_text)));
    assert.doesNotMatch(finalCandidates[0].original_text, /같이보자/);
    assert.match(finalCandidates[1].original_text, /같이보자/);
  }
});

test("local paragraph display box stays tight and its solid background uses the same bounds", async () => {
  const region = {
    region_id: "region-panel",
    region_type: "caption_panel",
    region_box: { left: 150, top: 100, width: 500, height: 320 },
    region_polygon: [[150, 100], [650, 100], [650, 420], [150, 420]],
    bg_color: "#303030",
    text_color: "#ffffff",
    stroke_color: "#000000",
    region_confidence: 0.96,
    score: 0.98,
    det_score: 0.92,
    rotation_deg: 0
  };
  const item = (text, left, top, width, height) => ({
    ...region,
    text,
    box: { left, top, width, height }
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    {
      imageWidth: 760,
      imageHeight: 900,
      items: [
        item("조심해", 280, 150, 120, 50),
        item("빨리 도망치지 않으면", 200, 210, 360, 52),
        item("죽을 거야", 300, 272, 160, 48)
      ]
    },
    { width: 760, height: 900 },
    "",
    false
  );

  assert.equal(result.length, 1);
  const block = result[0];
  assert.ok(block.location.width <= 360 * 1.08, JSON.stringify(block.location));
  assert.ok(block.location.height <= 170 * 1.09, JSON.stringify(block.location));
  assert.ok(block.location.left >= 187 && block.location.top >= 143, JSON.stringify(block.location));

  const candidate = context.__backgroundTest.normalizeBaiduOcrItem(block, 0, { width: 760, height: 900 });
  const fillLeft = (candidate.fill_box.x / 100) * 760;
  const fillTop = (candidate.fill_box.y / 100) * 900;
  const fillRight = fillLeft + (candidate.fill_box.w / 100) * 760;
  const fillBottom = fillTop + (candidate.fill_box.h / 100) * 900;
  assert.ok(Math.abs(fillLeft - block.location.left) < 1e-9);
  assert.ok(Math.abs(fillTop - block.location.top) < 1e-9);
  assert.ok(Math.abs(fillRight - (block.location.left + block.location.width)) < 1e-9);
  assert.ok(Math.abs(fillBottom - (block.location.top + block.location.height)) < 1e-9);
});

test("high-confidence speech bubbles use their interior region for layout and paint", async () => {
  const regionBox = { left: 120, top: 160, width: 360, height: 220 };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    {
      imageWidth: 760,
      imageHeight: 900,
      items: [{
        region_id: "speech-interior",
        region_type: "speech_bubble",
        region_box: regionBox,
        region_polygon: [[120, 160], [480, 160], [480, 380], [120, 380]],
        region_confidence: 0.96,
        bg_color: "#ffffff",
        text: "짧은 대사",
        score: 0.98,
        box: { left: 245, top: 245, width: 110, height: 40 }
      }]
    },
    { width: 760, height: 900 },
    "",
    false
  );

  assert.equal(result.length, 1);
  assert.ok(result[0].location.width > 200, JSON.stringify(result[0].location));
  const candidate = context.__backgroundTest.normalizeBaiduOcrItem(result[0], 0, { width: 760, height: 900 });
  assert.equal(candidate.bg_type, "solid");
  assert.ok(candidate.fill_box.w > 20, JSON.stringify(candidate.fill_box));
  assert.ok(candidate.fill_box.h > 15, JSON.stringify(candidate.fill_box));
});

test("shifted multi-line paragraphs stay separate through final candidate coalescing", async () => {
  const item = (text, left, top, width, height) => ({
    text,
    score: 0.97,
    det_score: 0.91,
    rotation_deg: 0,
    box: { left, top, width, height }
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    {
      imageWidth: 760,
      imageHeight: 1700,
      items: [
        item("네?!그게 무슨..", 181, 882, 223, 46),
        item("여긴 서울..아니에요?", 161, 935, 287, 46),
        item("전 그냥", 395, 1022, 104, 46),
        item("지하철을 타려고", 338, 1073, 217, 43),
        item("했을 뿐인데....", 347, 1121, 168, 50)
      ]
    },
    { width: 760, height: 1700 },
    "",
    false
  );

  assert.equal(result.length, 2, JSON.stringify(result.map((entry) => entry.words)));
  assert.deepEqual(JSON.parse(JSON.stringify(result.map((entry) => entry.sourceLineCount))), [2, 3]);
  assert.match(result[0].words, /여긴 서울/);
  assert.doesNotMatch(result[0].words, /지하철/);
  assert.match(result[1].words, /지하철을 타려고/);

  const finalCandidates = context.__backgroundTest.coalesceOverlappingOcrCandidates(
    result.map((entry, index) => context.__backgroundTest.normalizeBaiduOcrItem(
      entry,
      index,
      { width: 760, height: 1700 }
    ))
  );
  assert.equal(finalCandidates.length, 2, JSON.stringify(finalCandidates.map((entry) => entry.original_text)));
  assert.doesNotMatch(finalCandidates[0].original_text, /지하철/);
  assert.match(finalCandidates[1].original_text, /지하철을 타려고/);
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

test("glossary fingerprint invalidates full-image and block translation caches", () => {
  const base = {
    provider: "local_paddle_deepseek",
    model: "model",
    dataUrl: "data:image/png;base64,AAAA"
  };
  const item = { original_text: "성현", rawBox: { left: 10, top: 20, width: 30, height: 40 } };

  assert.notEqual(
    context.__backgroundTest.buildCacheKey({ ...base, glossaryFingerprint: "g1-old" }),
    context.__backgroundTest.buildCacheKey({ ...base, glossaryFingerprint: "g1-new" })
  );
  assert.notEqual(
    context.__backgroundTest.buildBlockTranslationCacheKey("source", item, "model", "base", "g1-old"),
    context.__backgroundTest.buildBlockTranslationCacheKey("source", item, "model", "base", "g1-new")
  );
});

test("text translation prompt injects matching glossary entries", () => {
  const prompt = context.__backgroundTest.buildOpenAICompatibleTranslationPrompt(
    [{ id: "t0", original_text: "성현 공작이 왔다" }],
    {
      entries: [
        { source: "성현 공작", target: "成贤公爵", enabled: true },
        { source: "마법사", target: "魔法师", enabled: true }
      ]
    }
  );

  assert.match(prompt, /Mandatory terminology glossary/);
  assert.match(prompt, /成贤公爵/);
  assert.doesNotMatch(prompt, /魔法师/);
  assert.equal(context.__backgroundTest.normalizeProvider("anthropic"), "baidu_deepseek");
  assert.equal(context.__backgroundTest.normalizeProvider("openai_compatible"), "baidu_deepseek");
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

function installMemoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.runtime.lastError = null;
  context.chrome.storage.local.get = (keys, callback) => {
    if (keys === null) {
      callback({ ...stored });
      return;
    }
    const list = Array.isArray(keys) ? keys : [keys];
    callback(Object.fromEntries(list.map((key) => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  context.chrome.storage.local.remove = (keys, callback) => {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete stored[key]);
    callback();
  };
  return stored;
}

test("v22 OCR cache separates image evidence and excludes translation and render settings", () => {
  const build = context.__backgroundTest.buildOcrCacheKey;
  const request = {
    imageDigest: "digest-a",
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: { "page-a": "revision-a" },
    imageMeta: { width: 760, height: 1200, pageSpans: [] }
  };
  const settings = {
    provider: "local_paddle_deepseek",
    localOcrBaseUrl: "http://127.0.0.1:8765",
    localOcrLang: "korean",
    localOcrMode: "fast",
    localOcrDetThresh: 0.3,
    localOcrDetBoxThresh: 0.6,
    localOcrDetUnclipRatio: 1.2,
    ocrConfidenceThreshold: 0.72,
    ocrMinBoxArea: 36,
    ocrMaxBoxArea: 0.35,
    ocrMinBoxWidth: 6,
    ocrMinBoxHeight: 6,
    ocrMaxAspectRatio: 18,
    ocrMergeLineGap: 1.65,
    visionOcrEnabled: false,
    ignoreSimplifiedChinese: false,
    model: "model-a",
    glossaryFingerprint: "glossary-a",
    overwriteFontScale: 1,
    overwriteCoverPadding: 1.2
  };
  const first = build({ request, settings });
  const translationAndRenderChanged = build({
    request,
    settings: {
      ...settings,
      model: "model-b",
      glossaryFingerprint: "glossary-b",
      overwriteFontScale: 2,
      overwriteCoverPadding: 0.2
    }
  });
  const newImage = build({ request: { ...request, imageDigest: "digest-b" }, settings });
  const newRevision = build({
    request: { ...request, imageRevisionByPage: { "page-a": "revision-b" } },
    settings
  });
  const newChineseFilter = build({
    request,
    settings: { ...settings, ignoreSimplifiedChinese: true }
  });
  const newCleanedMask = build({
    request: {
      ...request,
      cleanedMasks: [{ coordinateSpace: "percent", box: { x: 20, y: 90, w: 50, h: 10 } }]
    },
    settings
  });

  assert.match(first, /^mt_cache_v22:ocr:/);
  assert.equal(first, translationAndRenderChanged);
  assert.equal(first, newCleanedMask, "render-only masks must not split semantic OCR cache entries");
  assert.notEqual(first, newImage);
  assert.notEqual(first, newRevision);
  assert.notEqual(first, newChineseFilter);
});

test("cleaned masks clamp, quantize, deduplicate, sort, and reject non-percent geometry", () => {
  const normalize = context.__backgroundTest.normalizeCleanedMasks;
  const duplicateBox = {
    coordinate_space: "percent",
    box: { left: -10, top: 89.99996, width: 30, height: 20 }
  };
  const masks = normalize([
    { coordinateSpace: "pixel", box: { x: 0, y: 0, w: 5, h: 5 } },
    { coordinateSpace: "percent", box: { x: 25, y: 30, w: 0, h: 10 } },
    {
      coordinateSpace: "percent",
      polygon: [[110, -5], { x: 80.00004, y: 10 }, { x: 70, y: 30 }, { x: 110, y: -5 }]
    },
    duplicateBox,
    { coordinateSpace: "percent", box: { x: -10.00001, y: 90, w: 30.00001, h: 10 } }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(masks)), [
    {
      coordinateSpace: "percent",
      box: { x: 0, y: 90, w: 20, h: 10 }
    },
    {
      coordinateSpace: "percent",
      polygon: [{ x: 70, y: 30 }, { x: 100, y: 0 }, { x: 80, y: 10 }]
    }
  ]);
});

test("cleaned mask normalization is order-stable and caps the artifact contract at 200 masks", () => {
  const background = context.__backgroundTest;
  const inputs = Array.from({ length: 205 }, (_value, index) => ({
    coordinateSpace: "percent",
    box: {
      x: index % 100,
      y: Math.floor(index / 100),
      w: 0.25,
      h: 0.25
    }
  }));
  const forward = background.normalizeCleanedMasks(inputs);
  const reverse = background.normalizeCleanedMasks([...inputs].reverse());

  assert.equal(forward.length, 200);
  assert.deepEqual(forward, reverse);
  assert.equal(
    background.buildCleanedMasksFingerprint([...inputs, inputs[0]]),
    background.buildCleanedMasksFingerprint([...inputs].reverse())
  );
  assert.notEqual(
    background.buildCleanedMasksFingerprint(inputs),
    background.buildCleanedMasksFingerprint([{ coordinateSpace: "percent", box: { x: 1, y: 1, w: 1, h: 1 } }])
  );
  const polygon = [{ x: 10, y: 10 }, { x: 80, y: 20 }, { x: 70, y: 60 }, { x: 20, y: 70 }];
  assert.equal(
    background.buildCleanedMasksFingerprint([{ coordinateSpace: "percent", polygon }]),
    background.buildCleanedMasksFingerprint([{
      coordinateSpace: "percent",
      polygon: [polygon[2], polygon[1], polygon[0], polygon[3]]
    }])
  );
});

test("v22 semantic fingerprints do not inherit known 32-bit hash collisions", () => {
  const background = context.__backgroundTest;
  const first = "Q>B!~RW8=-.F";
  const second = "7ehK<NLY3wX7";

  assert.notEqual(first, second);
  assert.equal(background.stableHash128(first).length, 32);
  assert.notEqual(background.stableHash128(first), background.stableHash128(second));
});

test("canonical translation fingerprint preserves punctuation and all translation dimensions", () => {
  const build = context.__backgroundTest.buildCanonicalTranslationFingerprint;
  const base = {
    originalText: "  오늘은 간다!  ",
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    model: "model-a",
    baseUrl: "https://api.example.test/",
    promptVersion: "prompt-a",
    glossaryFingerprint: "glossary-a",
    translationOptions: { tone: "manga" }
  };
  const first = build(base);

  assert.equal(first, build({ ...base, originalText: "오늘은   간다!", baseUrl: "https://api.example.test" }));
  assert.notEqual(first, build({ ...base, originalText: "오늘은 간다?" }));
  assert.notEqual(first, build({ ...base, sourceLanguage: "ja" }));
  assert.notEqual(first, build({ ...base, targetLanguage: "en" }));
  assert.notEqual(first, build({ ...base, model: "model-b" }));
  assert.notEqual(first, build({ ...base, promptVersion: "prompt-b" }));
  assert.notEqual(first, build({ ...base, glossaryFingerprint: "glossary-b" }));
  assert.notEqual(first, build({ ...base, translationOptions: { tone: "literal" } }));
});

test("provider-neutral OCR observations are immutable, filtered with reasons, and expose edge evidence", () => {
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-a"],
      imageRevisionByPage: { "page-a": "revision-a" },
      imageDigest: "digest-a",
      imageMeta: { pageSpans: [] }
    },
    imageSize: { width: 760, height: 1200 },
    normalized: [
      {
        x: 20,
        y: 93,
        w: 40,
        h: 5,
        original_text: "다음 페이지로 이어진다!",
        confidence: 0.99,
        rawBox: { left: 152, top: 1116, width: 304, height: 60 },
        bg_type: "solid",
        region_type: "speech_bubble"
      },
      {
        x: 30,
        y: 96,
        w: 2,
        h: 1,
        original_text: "A",
        confidence: 0.2,
        rawBox: { left: 228, top: 1152, width: 15, height: 12 },
        bg_type: "none"
      }
    ],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: { filterReasons: [] },
    ignoreSimplifiedChinese: false,
    debug: false
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.filteredObservations.length, 1);
  assert.ok(result.filteredObservations[0].filterReason);
  assert.equal(result.edgeSignals.bottom.detected, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.observations[0]), true);
  assert.equal("translated_text" in result.observations[0], false);
  assert.deepEqual(Array.from(result.observations[0].pageIds), ["page-a"]);
});

test("seam OCR rejects complete page text and keeps only strict cross-boundary evidence", () => {
  const background = context.__backgroundTest;
  const imageSize = { width: 720, height: 192 };
  const request = {
    sourceType: "seam",
    imageMeta: {
      pageSpans: [
        {
          pageId: "page-upper",
          canvasBox: { x: 0, y: 0, w: 720, h: 96 },
          pageBox: { x: 0, y: 1004, w: 720, h: 96 },
          pageWidth: 720,
          pageHeight: 1100
        },
        {
          pageId: "page-lower",
          canvasBox: { x: 0, y: 96, w: 720, h: 96 },
          pageBox: { x: 0, y: 0, w: 720, h: 96 },
          pageWidth: 720,
          pageHeight: 1100
        }
      ]
    }
  };
  const candidate = (text, rawBox) => ({
    original_text: text,
    x: rawBox.left / imageSize.width * 100,
    y: rawBox.top / imageSize.height * 100,
    w: rawBox.width / imageSize.width * 100,
    h: rawBox.height / imageSize.height * 100,
    rawBox,
    confidence: 0.99,
    bg_type: "solid",
    region_type: "speech_bubble"
  });

  const result = background.filterSeamOcrCandidates([
    candidate("upper complete bubble", { left: 140, top: 20, width: 240, height: 28 }),
    candidate("lower publish button", { left: 600, top: 132, width: 72, height: 20 }),
    candidate("crosses the real page seam", { left: 220, top: 84, width: 240, height: 24 }),
    candidate("oversized mixed seam scene", { left: 20, top: 0, width: 680, height: 192 })
  ], request, imageSize);

  assert.deepEqual(Array.from(result.retained, (item) => item.original_text), ["crosses the real page seam"]);
  assert.equal(result.rejected.length, 3);
  assert.equal(result.rejected.every((item) => item.reason === "seam_not_cross_boundary"), true);
});

test("seam OCR can join only compatible fragments immediately above and below the boundary", () => {
  const background = context.__backgroundTest;
  const imageSize = { width: 720, height: 192 };
  const request = {
    sourceType: "seam",
    imageMeta: {
      pageSpans: [
        {
          pageId: "page-upper",
          canvasBox: { x: 0, y: 0, w: 720, h: 96 },
          pageBox: { x: 0, y: 1004, w: 720, h: 96 },
          pageWidth: 720,
          pageHeight: 1100
        },
        {
          pageId: "page-lower",
          canvasBox: { x: 0, y: 96, w: 720, h: 96 },
          pageBox: { x: 0, y: 0, w: 720, h: 96 },
          pageWidth: 720,
          pageHeight: 1100
        }
      ]
    }
  };
  const candidate = (text, rawBox) => ({
    original_text: text,
    x: rawBox.left / imageSize.width * 100,
    y: rawBox.top / imageSize.height * 100,
    w: rawBox.width / imageSize.width * 100,
    h: rawBox.height / imageSize.height * 100,
    rawBox,
    confidence: 0.99,
    bg_type: "solid",
    region_type: "speech_bubble",
    rotation_deg: 0
  });

  const result = background.filterSeamOcrCandidates([
    candidate("upper fragment", { left: 220, top: 76, width: 220, height: 16 }),
    candidate("lower fragment", { left: 226, top: 100, width: 214, height: 16 }),
    candidate("unrelated lower UI", { left: 600, top: 102, width: 60, height: 16 })
  ], request, imageSize);

  assert.equal(result.retained.length, 1);
  assert.equal(result.retained[0].original_text, "upper fragment\nlower fragment");
  assert.equal(result.retained[0].source_line_count, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "seam_not_cross_boundary");
});

test("visual fill regions trigger seam evidence even when the OCR text box is interior", () => {
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-visual-edge"],
      imageRevisionByPage: { "page-visual-edge": "revision-visual-edge" },
      imageDigest: "digest-visual-edge",
      imageMeta: { pageSpans: [] }
    },
    imageSize: { width: 800, height: 1600 },
    normalized: [{
      x: 25,
      y: 45,
      w: 40,
      h: 8,
      fill_box: { x: 24, y: 94, w: 42, h: 5 },
      original_text: "테스트 대사",
      confidence: 0.99,
      rawBox: { left: 200, top: 720, width: 320, height: 128 },
      bg_type: "solid",
      region_id: "visual-edge-region",
      region_type: "speech_bubble"
    }],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: { filterReasons: [] },
    ignoreSimplifiedChinese: false,
    debug: false
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].pageSpans[0].box.y < 80, true);
  assert.equal(result.edgeSignals.bottom.detected, true);
  assert.equal(result.edgeSignals.bottom.visualDetected, true);
});

test("chat metadata is retained as filtered evidence but never enters translation observations", () => {
  const base = (text, top, nonTranslate = false) => ({
    x: 10,
    y: top,
    w: 30,
    h: 4,
    original_text: text,
    confidence: 0.99,
    bg_type: "solid",
    region_type: "chat",
    non_translate: nonTranslate,
    rawBox: { left: 80, top: top * 10, width: 240, height: 32 }
  });
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["chat-page"],
      imageRevisionByPage: { "chat-page": "revision-chat" },
      imageDigest: "digest-chat",
      imageMeta: { pageSpans: [] }
    },
    imageSize: { width: 800, height: 800 },
    normalized: [base("사용자", 10, true), base("오늘의 본문입니다", 20)],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: { filterReasons: [] },
    ignoreSimplifiedChinese: false,
    debug: false
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].originalText, "오늘의 본문입니다");
  assert.equal(result.filteredObservations[0].originalText, "사용자");
  assert.equal(result.filteredObservations[0].filterReason, "non-translatable-chat-metadata");
});

test("provider-neutral OCR accounts for every max-bubbles overflow as filtered evidence", () => {
  const normalized = Array.from({ length: 405 }, (_, index) => ({
    x: 10,
    y: 30,
    w: 20,
    h: 8,
    original_text: `테스트대사${index}`,
    confidence: 0.99,
    rawBox: { left: 76, top: 360, width: 152, height: 96 },
    bg_type: "solid",
    region_id: `region-${index}`,
    region_type: "speech_bubble"
  }));
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-overflow"],
      imageRevisionByPage: { "page-overflow": "revision-overflow" },
      imageDigest: "digest-overflow",
      imageMeta: { pageSpans: [] }
    },
    imageSize: { width: 760, height: 1200 },
    normalized,
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: { filterReasons: [] },
    ignoreSimplifiedChinese: false,
    debug: false
  });

  assert.equal(result.observations.length, 400);
  assert.equal(result.filteredObservations.filter((item) => item.filterReason === "max_bubbles").length, 5);
  assert.equal(result.observations.length + result.filteredObservations.length, normalized.length);
});

test("OCR_DATA_URL validates only provider OCR credentials and never invokes translation", async () => {
  const background = context.__backgroundTest;
  const dataUrl = "data:image/png;base64,QUJDRA==";
  let ocrCalls = 0;
  let translationCalls = 0;
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({ request, settings }) => {
      ocrCalls += 1;
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: { hasAny: false }
      };
    },
    requestCanonicalTranslationBatch: async () => {
      translationCalls += 1;
      return [];
    }
  });

  installMemoryStorage({
    mt_provider: "baidu_deepseek",
    mt_baidu_api_key: "ak",
    mt_baidu_secret_key: "sk",
    mt_api_key: ""
  });
  const baidu = await background.handleOcrDataUrl({
    dataUrl,
    sourceType: "page",
    pageIds: ["page-baidu"],
    imageRevision: "revision-baidu"
  });
  assert.equal(baidu.ok, true);
  assert.equal(baidu.result.provider, "baidu_deepseek");

  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_local_ocr_base_url: "http://127.0.0.1:8765",
    mt_api_key: ""
  });
  const local = await background.handleOcrDataUrl({
    dataUrl: "data:image/png;base64,RUZHSA==",
    sourceType: "page",
    pageIds: ["page-local"],
    imageRevision: "revision-local"
  });
  background.setBackgroundTestHooks(null);

  assert.equal(local.ok, true);
  assert.equal(local.result.provider, "local_paddle_deepseek");
  assert.equal(ocrCalls, 2);
  assert.equal(translationCalls, 0);
});

test("OCR cache removes cleaned image bytes while retaining the refresh requirement", () => {
  const safe = context.__backgroundTest.buildCacheSafeOcrResult({
    observations: [{ id: "obs-a", visual: { bgType: "none" } }],
    filteredObservations: [],
    cleanedImage: "data:image/png;base64,QUJDRA==",
    cleanedImageToken: "artifact-token",
    debug: { large: true }
  });

  assert.equal(safe.cleanedImage, undefined);
  assert.equal(safe.cleanedImageToken, undefined);
  assert.equal(safe.debug, undefined);
  assert.equal(safe.requiresCleanedImage, true);

  const solid = context.__backgroundTest.buildCacheSafeOcrResult({
    observations: [{ id: "obs-solid", visual: { bgType: "solid" } }],
    cleanedImage: "data:image/png;base64,QUJDRA=="
  });
  assert.equal(solid.cleanedImage, undefined);
  assert.equal(solid.requiresCleanedImage, undefined);
});

test("warm OCR cache refreshes only required cleaned artifacts and preserves cached observations", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_local_ocr_base_url: "http://127.0.0.1:8765"
  });
  const callsByPage = new Map();
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({ request }) => {
      const pageId = request.pageIds[0];
      const call = (callsByPage.get(pageId) || 0) + 1;
      callsByPage.set(pageId, call);
      const needsCleaned = pageId === "page-none";
      return {
        provider: "local_paddle_deepseek",
        sourceType: "page",
        pageIds: [pageId],
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [{
          id: call === 1 ? `${pageId}-stable` : `${pageId}-changed-by-refresh`,
          visual: { bgType: needsCleaned ? "none" : "solid" }
        }],
        filteredObservations: [],
        edgeSignals: {},
        cleanedImage: `data:image/png;base64,${call === 1 ? "QUJDRA==" : "RUZHSA=="}`,
        cleanedImageToken: `artifact-${pageId}-${call}`
      };
    }
  });

  const solidRequest = {
    dataUrl: "data:image/png;base64,U09MSUQ=",
    sourceType: "page",
    pageIds: ["page-solid"],
    imageRevision: "ignored",
    requireCleanedImage: true
  };
  await background.handleOcrDataUrl(solidRequest);
  const solidWarm = await background.handleOcrDataUrl(solidRequest);
  assert.equal(solidWarm.cached, true);
  assert.equal(callsByPage.get("page-solid"), 1);
  const forcedSolidArtifact = await background.handleOcrDataUrl({
    ...solidRequest,
    forceCleanedImageArtifact: true
  });
  assert.equal(callsByPage.get("page-solid"), 2);
  assert.equal(forcedSolidArtifact.result.observations[0].id, "page-solid-stable");
  assert.match(forcedSolidArtifact.result.cleanedImage, /^data:image\/png;base64,/);
  assert.equal(forcedSolidArtifact.result.cleanedImageToken, "artifact-page-solid-2");

  const noneRequest = {
    dataUrl: "data:image/png;base64,Tk9ORQ==",
    sourceType: "page",
    pageIds: ["page-none"],
    imageRevision: "ignored",
    requireCleanedImage: true
  };
  const noneCold = await background.handleOcrDataUrl(noneRequest);
  const noneWarm = await background.handleOcrDataUrl(noneRequest);
  background.setBackgroundTestHooks(null);

  assert.equal(noneCold.result.observations[0].id, "page-none-stable");
  assert.equal(callsByPage.get("page-none"), 2);
  assert.equal(noneWarm.cached, false);
  assert.equal(noneWarm.result.observations[0].id, "page-none-stable");
  assert.match(noneWarm.result.cleanedImage, /^data:image\/png;base64,/);
});

test("canonical text translation reports omitted IDs as partial errors without original-text fallback", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_api_key: "translation-key",
    mt_model: "model-a",
    mt_base_url: "https://api.example.test"
  });
  background.setBackgroundTestHooks({
    requestCanonicalTranslationBatch: async ({ items }) => [{
      id: items[0].id,
      translated_text: "第一句"
    }]
  });
  const response = await background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [
      { id: "canonical-a", revision: 2, original_text: "첫 문장" },
      { id: "canonical-b", revision: 7, original_text: "둘째 문장" }
    ]
  });
  background.setBackgroundTestHooks(null);

  assert.equal(response.ok, true);
  assert.equal(response.partial, true);
  assert.equal(response.translations.length, 1);
  assert.equal(response.translations[0].id, "canonical-a");
  assert.equal(response.translations[0].revision, 2);
  assert.equal(response.errors[0].id, "canonical-b");
  assert.equal(response.errors[0].revision, 7);
  assert.equal(response.translations.some((item) => item.translated_text === "둘째 문장"), false);
});

test("canonical text translation rejects array-position identities", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_api_key: "translation-key"
  });
  const response = await background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [{ revision: 1, original_text: "안녕" }]
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /stable canonical id/i);
});

test("canonical text translation keeps same-ID revisions distinct within one request", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_api_key: "translation-key",
    mt_model: "model-revisions",
    mt_base_url: "https://api.example.test"
  });
  background.setBackgroundTestHooks({
    requestCanonicalTranslationBatch: async ({ items }) => items.map((item, index) => ({
      id: item.id,
      translated_text: index === 0 ? "第一版" : "第二版"
    }))
  });
  const response = await background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [
      { id: "canonical-same", revision: 1, original_text: "첫 버전" },
      { id: "canonical-same", revision: 2, original_text: "둘째 버전" }
    ]
  });
  background.setBackgroundTestHooks(null);

  assert.equal(response.ok, true);
  assert.equal(response.partial, false);
  assert.equal(response.translations[0].revision, 1);
  assert.equal(response.translations[0].translated_text, "第一版");
  assert.equal(response.translations[1].revision, 2);
  assert.equal(response.translations[1].translated_text, "第二版");
});

test("concurrent canonical fingerprints share one external request and warm cache performs zero calls", async () => {
  const background = context.__backgroundTest;
  const stored = installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_api_key: "translation-key",
    mt_model: "model-a",
    mt_base_url: "https://api.example.test"
  });
  let externalCalls = 0;
  background.setBackgroundTestHooks({
    requestCanonicalTranslationBatch: async ({ items }) => {
      externalCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return items.map((item) => ({ id: item.id, translated_text: "共享译文" }));
    }
  });
  const makeRequest = (id, revision) => background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [{ id, revision, original_text: "같은 문장!" }]
  });
  const [first, second] = await Promise.all([
    makeRequest("canonical-a", 1),
    makeRequest("canonical-b", 4)
  ]);
  const warm = await makeRequest("canonical-c", 9);
  background.setBackgroundTestHooks(null);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.translations[0].revision, 1);
  assert.equal(second.translations[0].revision, 4);
  assert.equal(first.translations[0].translationFingerprint, second.translations[0].translationFingerprint);
  assert.equal(warm.translations[0].cached, true);
  assert.equal(externalCalls, 1);
  assert.ok(Object.keys(stored).some((key) => key.startsWith("mt_cache_v22:translation:")));
});

test("OpenAI-compatible text translation aborts a stalled fetch within its request deadline", async () => {
  const originalFetch = context.fetch;
  context.fetch = () => new Promise(() => {});
  try {
    const outcome = await Promise.race([
      context.__backgroundTest.sendOpenAICompatibleTranslationRequest(
        "https://api.example.test/chat/completions",
        "translation-key",
        { model: "model-a", messages: [] },
        20
      ).then(
        () => "resolved",
        (error) => `rejected:${error && error.message}`
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 120))
    ]);

    assert.match(outcome, /^rejected:.*timed out/i);
  } finally {
    context.fetch = originalFetch;
  }
});

test("OpenAI-compatible text translation timeout includes stalled JSON body reads", async () => {
  const originalFetch = context.fetch;
  let requestSignal = null;
  context.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("body read aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    };
  };
  try {
    const outcome = await Promise.race([
      context.__backgroundTest.sendOpenAICompatibleTranslationRequest(
        "https://api.example.test/chat/completions",
        "translation-key",
        { model: "model-a", messages: [] },
        20
      ).then(
        () => "resolved",
        (error) => `rejected:${error && error.message}`
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 120))
    ]);

    assert.match(outcome, /^rejected:.*timed out/i);
    assert.equal(requestSignal && requestSignal.aborted, true);
  } finally {
    context.fetch = originalFetch;
  }
});

test("low-confidence Vision OCR aborts a stalled fetch within its request deadline", async () => {
  const originalFetch = context.fetch;
  context.fetch = () => new Promise(() => {});
  try {
    const outcome = await Promise.race([
      context.__backgroundTest.sendOpenAICompatibleOnce({
        endpoint: "https://vision.example.test/chat/completions",
        model: "vision-model",
        apiKey: "vision-key",
        dataUrl: "data:image/png;base64,AQID",
        prompt: "read text",
        useJsonResponseFormat: true,
        requestTimeoutMs: 20
      }).then(
        () => "resolved",
        (error) => `rejected:${error && error.message}`
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 120))
    ]);

    assert.match(outcome, /^rejected:.*timed out/i);
  } finally {
    context.fetch = originalFetch;
  }
});

test("low-confidence Vision OCR timeout includes stalled JSON body reads", async () => {
  const originalFetch = context.fetch;
  let requestSignal = null;
  context.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("body read aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    };
  };
  try {
    const outcome = await Promise.race([
      context.__backgroundTest.sendOpenAICompatibleOnce({
        endpoint: "https://vision.example.test/chat/completions",
        model: "vision-model",
        apiKey: "vision-key",
        dataUrl: "data:image/png;base64,AQID",
        prompt: "read text",
        useJsonResponseFormat: true,
        requestTimeoutMs: 20
      }).then(
        () => "resolved",
        (error) => `rejected:${error && error.message}`
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 120))
    ]);

    assert.match(outcome, /^rejected:.*timed out/i);
    assert.equal(requestSignal && requestSignal.aborted, true);
  } finally {
    context.fetch = originalFetch;
  }
});

test("local OCR forwards the cleaned-image artifact flag to the service", async () => {
  const originalFetch = context.fetch;
  const requestBodies = [];
  context.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        items: [],
        imageWidth: 1,
        imageHeight: 1,
        ...(body.cleaned_mask_token ? { cleanedMaskToken: body.cleaned_mask_token } : {})
      })
    };
  };
  const baseRequest = {
    dataUrl: "data:image/png;base64,AQID",
    baseUrl: "http://127.0.0.1:8765",
    lang: "korean",
    mode: "fast",
    params: {},
    debug: false,
    debugId: "artifact-wire-test"
  };

  try {
    await context.__backgroundTest.requestLocalPaddleOcr(baseRequest);
    await context.__backgroundTest.requestLocalPaddleOcr({
      ...baseRequest,
      returnCleanedImage: true
    });
    await context.__backgroundTest.requestLocalPaddleOcr({
      ...baseRequest,
      returnCleanedImage: true,
      cleanedMasks: [{ coordinateSpace: "percent", box: { x: 20, y: 90, w: 50, h: 10 } }]
    });
  } finally {
    context.fetch = originalFetch;
  }

  assert.equal(requestBodies.length, 3);
  assert.equal(requestBodies[0].return_cleaned_image, false);
  assert.equal(requestBodies[0].cleaned_mask_token, "");
  assert.equal(requestBodies[1].return_cleaned_image, true);
  assert.deepEqual(requestBodies[1].cleaned_masks, []);
  assert.match(requestBodies[1].cleaned_mask_token, /^[a-f0-9]{32}$/);
  assert.equal(requestBodies[2].return_cleaned_image, true);
  assert.deepEqual(requestBodies[2].cleaned_masks, [
    { coordinateSpace: "percent", box: { x: 20, y: 90, w: 50, h: 10 } }
  ]);
  assert.match(requestBodies[2].cleaned_mask_token, /^[a-f0-9]{32}$/);
  assert.notEqual(requestBodies[1].cleaned_mask_token, requestBodies[2].cleaned_mask_token);
});

test("local OCR rejects a cleaned artifact when an old service does not acknowledge artifact support", async () => {
  const originalFetch = context.fetch;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      items: [],
      imageWidth: 1,
      imageHeight: 1,
      cleanedImage: "data:image/png;base64,AQID"
    })
  });
  try {
    await assert.rejects(
      context.__backgroundTest.requestLocalPaddleOcr({
        dataUrl: "data:image/png;base64,AQID",
        baseUrl: "http://127.0.0.1:8765",
        lang: "korean",
        mode: "fast",
        params: {},
        debug: false,
        debugId: "old-service-artifact-test",
        returnCleanedImage: true
      }),
      /重启 local-ocr-service/
    );
  } finally {
    context.fetch = originalFetch;
  }
});

test("local OCR body timeout rejects instead of returning an empty authoritative payload", async () => {
  const originalFetch = context.fetch;
  let requestSignal = null;
  context.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("body read aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    };
  };

  try {
    const outcome = await Promise.race([
      context.__backgroundTest.requestLocalPaddleOcr({
        dataUrl: "data:image/png;base64,AQID",
        baseUrl: "http://127.0.0.1:8765",
        lang: "korean",
        mode: "fast",
        params: {},
        debug: true,
        debugId: "stalled-local-body",
        requestTimeoutMs: 20
      }).then(
        (value) => `resolved:${JSON.stringify(value)}`,
        (error) => `rejected:${error && error.message}`
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 120))
    ]);

    assert.match(outcome, /^rejected:.*OCR.*超时/i);
    assert.equal(requestSignal && requestSignal.aborted, true);
  } finally {
    context.fetch = originalFetch;
  }
});

test("local OCR rejects an invalid successful JSON body instead of treating it as no text", async () => {
  const originalFetch = context.fetch;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => {
      throw new SyntaxError("invalid JSON");
    }
  });

  try {
    await assert.rejects(
      () => context.__backgroundTest.requestLocalPaddleOcr({
        dataUrl: "data:image/png;base64,AQID",
        baseUrl: "http://127.0.0.1:8765",
        lang: "korean",
        mode: "fast",
        params: {},
        debug: false,
        debugId: "invalid-local-json",
        requestTimeoutMs: 100
      }),
      /无效 JSON/
    );
  } finally {
    context.fetch = originalFetch;
  }
});

test("local OCR debug preserves raw detector boxes even when final OCR items are empty", async () => {
  const debug = {
    rawItems: [],
    filteredItems: [],
    mergedItems: [],
    filterReasons: []
  };
  const items = await context.__backgroundTest.buildLocalPaddleBubbleItems(
    {
      items: [],
      rawItems: [{
        text: "희미한글",
        score: 0.2,
        box: { left: 10, top: 20, width: 80, height: 24 },
        lang: "korean",
        variant: "perspective_fast_raw"
      }],
      imageWidth: 160,
      imageHeight: 80
    },
    { width: 160, height: 80 },
    "",
    false,
    null,
    context.__backgroundTest.getDefaultOcrTuning(),
    debug
  );

  assert.deepEqual(Array.from(items), []);
  assert.equal(debug.rawItems.length, 1);
  assert.equal(debug.rawItems[0].text, "희미한글");
  assert.deepEqual(JSON.parse(JSON.stringify(debug.rawItems[0].rawBox)), {
    left: 10,
    top: 20,
    width: 80,
    height: 24
  });
});

test("legacy combined adapter keeps its bubble wire shape and fails the whole request on a missing translation", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({});
  const observation = {
    id: "obs-legacy",
    originalText: "원문!",
    providerBlockId: "block-legacy",
    pageSpans: [{ pageId: "legacy", box: { x: 10, y: 20, w: 30, h: 8 }, overlapRatio: 1 }],
    visual: { bgType: "solid", bgColor: "#ffffff", sourceLineCount: 1 }
  };
  const args = {
    provider: "local_paddle_deepseek",
    dataUrl: "data:image/png;base64,TEVHQUNZ",
    imageMeta: {},
    targetKey: "legacy-target",
    ocrSettings: { provider: "local_paddle_deepseek" },
    translatorApiKey: "key",
    translatorBaseUrl: "https://api.example.test",
    translatorModel: "model-a",
    glossary: { entries: [] },
    glossaryFingerprint: ""
  };
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async () => ({
      observations: [observation],
      filteredObservations: [],
      edgeSignals: { hasAny: false }
    }),
    requestCanonicalTranslationBatch: async () => []
  });
  await assert.rejects(
    () => background.requestLegacyTranslatedResultFromOcr(args),
    /omitted 1 OCR block/
  );

  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async () => ({
      observations: [observation],
      filteredObservations: [],
      edgeSignals: { hasAny: false }
    }),
    requestCanonicalTranslationBatch: async ({ items }) => [{ id: items[0].id, translated_text: "译文！" }]
  });
  const result = await background.requestLegacyTranslatedResultFromOcr(args);
  background.setBackgroundTestHooks(null);

  assert.deepEqual(JSON.parse(JSON.stringify(result.bubbles)), [{
    x: 10,
    y: 20,
    w: 30,
    h: 8,
    fill_box: null,
    bg_type: "solid",
    bg_color: "#ffffff",
    bg_confidence: 0,
    region_id: "",
    region_type: "plain_text",
    region_polygon: null,
    text_color: "",
    stroke_color: "",
    polygon: null,
    rotation_deg: 0,
    source_line_count: 1,
    block_id: "block-legacy",
    original_text: "원문!",
    translated_text: "译文!"
  }]);
});

test("identical OCR fingerprints share one provider request and then use the warm v22 cache", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_local_ocr_base_url: "http://127.0.0.1:8765"
  });
  let providerCalls = 0;
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({ request, settings }) => {
      providerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: { hasAny: false }
      };
    }
  });
  const request = {
    dataUrl: "data:image/png;base64,T0NSLUlORkxJR0hU",
    sourceType: "page",
    pageIds: ["page-inflight"],
    imageRevision: "revision-inflight"
  };
  const [first, second] = await Promise.all([
    background.handleOcrDataUrl(request),
    background.handleOcrDataUrl(request)
  ]);
  const warm = await background.handleOcrDataUrl(request);
  background.setBackgroundTestHooks(null);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(warm.cached, true);
  assert.equal(providerCalls, 1);
});

test("a forced cleaned-image OCR request does not reuse a plain in-flight request", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_local_ocr_base_url: "http://127.0.0.1:8765"
  });
  let markFirstStarted;
  let releaseRequests;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const requestGate = new Promise((resolve) => { releaseRequests = resolve; });
  const artifactFlags = [];
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({ request, settings }) => {
      artifactFlags.push(request.requireCleanedImage === true || request.forceCleanedImageArtifact === true);
      markFirstStarted();
      await requestGate;
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: { hasAny: false },
        ...(request.requireCleanedImage ? { cleanedImage: "data:image/png;base64,Q0xFQU4=" } : {})
      };
    }
  });
  const request = {
    dataUrl: "data:image/png;base64,T0NSLUFSVElGQUNU",
    sourceType: "page",
    pageIds: ["page-artifact-inflight"],
    imageRevision: "revision-artifact-inflight"
  };

  const plain = background.handleOcrDataUrl(request);
  await firstStarted;
  const forced = background.handleOcrDataUrl({
    ...request,
    requireCleanedImage: true,
    forceCleanedImageArtifact: true
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseRequests();
  const [plainResult, forcedResult] = await Promise.all([plain, forced]);
  background.setBackgroundTestHooks(null);

  assert.equal(plainResult.ok, true);
  assert.equal(forcedResult.ok, true);
  assert.deepEqual(artifactFlags.sort(), [false, true]);
  assert.match(forcedResult.result.cleanedImage, /^data:image\/png;base64,/);
});

test("forced cleaned-image requests with different canonical masks do not share an artifact", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_local_ocr_base_url: "http://127.0.0.1:8765"
  });
  let releaseRequests;
  const requestGate = new Promise((resolve) => { releaseRequests = resolve; });
  const receivedMasks = [];
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({ request, settings }) => {
      receivedMasks.push(request.cleanedMasks);
      await requestGate;
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: { hasAny: false },
        cleanedImage: "data:image/png;base64,Q0xFQU4="
      };
    }
  });
  const base = {
    dataUrl: "data:image/png;base64,TUFTSy1JTkZMSUdIVA==",
    sourceType: "page",
    pageIds: ["page-mask-inflight"],
    imageRevision: "revision-mask-inflight",
    requireCleanedImage: true,
    forceCleanedImageArtifact: true
  };
  const firstMasks = [{ coordinateSpace: "percent", box: { x: 20, y: 90, w: 40, h: 10 } }];
  const secondMasks = [{ coordinateSpace: "percent", box: { x: 20, y: 85, w: 40, h: 15 } }];

  const first = background.handleOcrDataUrl({ ...base, cleanedMasks: firstMasks });
  const second = background.handleOcrDataUrl({ ...base, cleanedMasks: secondMasks });
  await new Promise((resolve) => setImmediate(resolve));
  releaseRequests();
  const results = await Promise.all([first, second]);
  background.setBackgroundTestHooks(null);

  assert.equal(results.every((result) => result.ok), true);
  assert.equal(receivedMasks.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(receivedMasks)), [firstMasks, secondMasks]);
});

test("equivalent cleaned masks share one artifact request after normalization", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage({
    mt_provider: "local_paddle_deepseek",
    mt_local_ocr_base_url: "http://127.0.0.1:8765"
  });
  let providerCalls = 0;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  let releaseRequest;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({ request, settings }) => {
      providerCalls += 1;
      if (providerCalls === 1) markFirstStarted();
      await requestGate;
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: { hasAny: false },
        cleanedImage: "data:image/png;base64,Q0xFQU4="
      };
    }
  });
  const base = {
    dataUrl: "data:image/png;base64,TUFTSy1TSEFSRUQ=",
    sourceType: "page",
    pageIds: ["page-mask-shared"],
    imageRevision: "revision-mask-shared",
    requireCleanedImage: true,
    forceCleanedImageArtifact: true
  };
  const firstMasks = [
    { coordinateSpace: "percent", box: { x: 40, y: 90, w: 20, h: 10 } },
    { coordinateSpace: "percent", box: { x: 20, y: 85, w: 50, h: 15 } }
  ];
  const equivalentMasks = [
    { coordinate_space: "percent", box: { left: 20, top: 85, width: 50, height: 15 } },
    { coordinateSpace: "percent", box: { x: 40.00001, y: 90, w: 19.99999, h: 10 } },
    firstMasks[0]
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.normalizeCleanedMasks(firstMasks))),
    JSON.parse(JSON.stringify(background.normalizeCleanedMasks(equivalentMasks)))
  );
  assert.equal(
    background.buildCleanedMasksFingerprint(firstMasks),
    background.buildCleanedMasksFingerprint(equivalentMasks)
  );

  const first = background.handleOcrDataUrl({ ...base, cleanedMasks: firstMasks });
  await firstStarted;
  await new Promise((resolve) => setImmediate(resolve));
  const second = background.handleOcrDataUrl({ ...base, cleanedMasks: equivalentMasks });
  // 两次调用都要先完成异步 SHA-256/storage 读取，再进入 inflight map；
  // 保持首个 provider 请求挂起，给第二次调用足够时间加入同一 promise。
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseRequest();
  const results = await Promise.all([first, second]);
  background.setBackgroundTestHooks(null);

  assert.equal(results.every((result) => result.ok), true);
  assert.equal(providerCalls, 1);
});
