import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = {
  addListener() {}
};
const context = vm.createContext({
  chrome: {
    runtime: {
      onInstalled: listeners,
      onStartup: listeners,
      onMessage: listeners
    },
    tabs: {},
    storage: {
      local: {}
    }
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
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});
function installMemoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.runtime.lastError = null;
  context.chrome.storage.local.get = (keys, callback) => {
    if (keys === null) {
      callback({
        ...stored
      });
      return;
    }
    const list = Array.isArray(keys) ? keys : [keys];
    callback(Object.fromEntries(list.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  context.chrome.storage.local.remove = (keys, callback) => {
    (Array.isArray(keys) ? keys : [keys]).forEach(key => delete stored[key]);
    callback();
  };
  return stored;
}
function separatedConfiguration({
  ocrProvider = "local_paddle",
  baiduApiKey = "",
  baiduSecretKey = "",
  localOcrBaseUrl = "http://127.0.0.1:8765",
  translationApiKey = "",
  translationBaseUrl = "https://api.deepseek.com",
  translationModel = "deepseek-chat"
} = {}) {
  return {
    mt_ocr_config_v1: {
      provider: ocrProvider,
      baidu: {
        apiKey: baiduApiKey,
        secretKey: baiduSecretKey
      },
      localPaddle: {
        baseUrl: localOcrBaseUrl
      }
    },
    mt_translation_config_v1: {
      provider: "openai_compatible",
      apiKey: translationApiKey,
      baseUrl: translationBaseUrl,
      model: translationModel
    }
  };
}
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
    mt_glossary_v2: {
      entries: [{
        source: "성현", target: "晟玄", scope: "series", scopeKey: "kakao:1"
      }]
    },
    mt_glossary_pending_v1: {
      chapters: [{
        key: "https://example.test/chapter/1",
        url: "https://example.test/chapter/1",
        candidates: [{
          source: "성현",
          kind: "proper_noun",
          score: 0.9
        }]
      }, {
        key: "https://example.test/chapter/2",
        url: "https://example.test/chapter/2",
        candidates: [{
          source: "성현",
          kind: "proper_noun",
          score: 0.9
        }]
      }]
    }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  const response = await context.__backgroundTest.handleConfirmTermCandidates({
    entries: [{
      source: "성현",
      target: "成贤",
      note: "角色名"
    }, {
      source: "空项",
      target: ""
    }]
  });
  assert.equal(response.ok, true);
  assert.equal(stored.mt_glossary_v2.entries.length, 2);
  assert.equal(stored.mt_glossary_v2.entries.find(entry => entry.scope === "global").target, "成贤");
  assert.equal(stored.mt_glossary_v2.entries.find(entry => entry.scope === "work").target, "晟玄");
  assert.equal(stored.mt_glossary_pending_v1.chapters.every(chapter => chapter.candidates.length === 0), true);
});
test("confirming an edited source stores the correction and removes the original partial candidate", async () => {
  const stored = {
    mt_glossary_v1: {
      entries: []
    },
    mt_glossary_pending_v1: {
      chapters: [{
        key: "https://example.test/chapter/name-fix",
        url: "https://example.test/chapter/name-fix",
        candidates: [{
          source: "김솔",
          kind: "proper_noun",
          score: 0.9
        }, {
          source: "김솔음",
          kind: "person",
          score: 0.8
        }]
      }]
    }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  const response = await context.__backgroundTest.handleConfirmTermCandidates({
    entries: [{
      candidateSource: "김솔",
      source: "김솔음",
      target: "金索音"
    }]
  });
  assert.equal(response.ok, true);
  assert.equal(stored.mt_glossary_v2.entries[0].source, "김솔음");
  assert.equal(stored.mt_glossary_v2.entries[0].target, "金索音");
  assert.equal(stored.mt_glossary_pending_v1.chapters.length, 0);
});
test("novel chunk retries only rejected paragraphs and enforces the book glossary", async () => {
  const stored = installMemoryStorage({
    ...separatedConfiguration({ translationApiKey: "test-key" }),
    mt_glossary_v2: {
      entries: [
        { source: "성현", target: "成贤", scope: "global" },
        { source: "성현", target: "晟玄", scope: "series", scopeKey: "kakao:65171279" }
      ]
    }
  });
  const calls = [];
  context.__backgroundTest.setBackgroundTestHooks({
    requestNovelChunk({ items }) {
      calls.push(items.map(item => item.id));
      if (calls.length === 1) {
        return {
          translations: [
            { id: "p1", translated_text: "晟玄来了。" },
            { id: "p2", translated_text: "成贤离开了。" }
          ],
          memory_delta: { summary: "人物登场" }
        };
      }
      if (items[0].id === "p3") {
        return { translations: [{ id: "p3", translated_text: "这是普通的一天。" }] };
      }
      return {
        translations: [{ id: "p2", translated_text: "晟玄离开了。" }],
        memory_delta: { unresolved: ["去向"] }
      };
    }
  });
  const response = await context.__backgroundTest.handleTranslateNovelChunk({
    scopeKey: "kakao:65171279",
    seriesId: "65171279",
    chapterId: "70081892",
    chapterOrder: 399,
    items: [
      { id: "p1", original_text: "성현이 왔다." },
      { id: "p2", original_text: "성현이 떠났다." },
      { id: "p3", original_text: "평범한 하루였다." }
    ]
  });
  assert.equal(response.ok, true);
  assert.equal(response.partial, false);
  assert.equal(response.warnings.length, 0);
  assert.deepEqual(Array.from(calls, ids => Array.from(ids)), [["p1", "p2", "p3"], ["p2"], ["p3"]]);
  assert.deepEqual(
    Array.from(response.translations, row => row.translated_text),
    ["晟玄来了。", "晟玄离开了。", "这是普通的一天。"]
  );
  assert.deepEqual(
    Array.from(response.diagnostics, item => Array.from(item.itemIds)),
    [["p1", "p2", "p3"], ["p2"], ["p3"]]
  );
  assert.deepEqual(
    Array.from(response.diagnostics[0].validationErrors, error => error.code),
    ["glossary_violation", "missing_translation"]
  );
  assert.ok(Object.keys(stored).some(key => key.startsWith("mt_cache_v23:novel:")));
  let partialCall = 0;
  context.__backgroundTest.setBackgroundTestHooks({
    requestNovelChunk() {
      partialCall += 1;
      if (partialCall > 1) throw new Error("retry timeout");
      return { translations: [{ id: "p3", translated_text: "第一段。" }] };
    }
  });
  const partial = await context.__backgroundTest.handleTranslateNovelChunk({
    scopeKey: "kakao:65171279",
    chapterId: "partial",
    chapterOrder: 400,
    items: [
      { id: "p3", original_text: "첫 문단." },
      { id: "p4", original_text: "둘째 문단." }
    ]
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.partial, true);
  assert.deepEqual(Array.from(partial.translations, row => row.id), ["p3"]);
  assert.equal(partial.errors[0].id, "p4");
  assert.equal(partial.diagnostics.at(-1).status, "request_failed");
  context.__backgroundTest.setBackgroundTestHooks(null);
});
test("novel memory commits a complete checkpoint and excludes later chapters on back-read", async () => {
  installMemoryStorage({});
  const background = context.__backgroundTest;
  await background.handleSaveNovelMemory({
    scopeKey: "kakao:1", chapterId: "c1", chapterOrder: 1,
    memoryDeltas: [{ summary: "第一章" }]
  });
  await background.handleSaveNovelMemory({
    scopeKey: "kakao:1", chapterId: "c3", chapterOrder: 3,
    memoryDeltas: [{ summary: "第三章" }]
  });
  const response = await background.handleGetNovelMemory({
    scopeKey: "kakao:1", chapterId: "c2", chapterOrder: 2
  });
  assert.equal(response.ok, true);
  assert.match(response.context.memory.summary, /第一章/u);
  assert.doesNotMatch(response.context.memory.summary, /第三章/u);
});
test("offline term discovery cools down without surfacing a translation failure", async () => {
  const stored = {
    mt_term_discovery_enabled: true,
    mt_glossary_v1: {
      entries: []
    },
    mt_glossary_pending_v1: {
      chapters: []
    },
    mt_glossary_ignored_v1: {
      sources: []
    },
    mt_local_ocr_base_url: "http://127.0.0.1:8765",
    mt_local_service_auth_v1: { token: "test-local-service-token" }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map(key => [key, stored[key]])));
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
    blocks: [{
      id: "b1",
      originalText: "김성현",
      translatedText: "金成贤"
    }]
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
  assert.match(context.__backgroundTest.buildCacheKey({
    dataUrl: ""
  }), /^mt_cache_v21:/);
  assert.equal(context.__backgroundTest.isStorageQuotaError(new Error("Resource::kQuotaBytes quota exceeded")), true);
});
test("translation cache excludes large image and debug payloads", () => {
  const result = context.__backgroundTest.buildCacheSafeTranslationResult({
    bubbles: [{
      id: "t0",
      translated_text: "译文"
    }],
    cleanedImage: "data:image/png;base64,large",
    debug: {
      rawItems: new Array(100).fill("large")
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    bubbles: [{
      id: "t0",
      translated_text: "译文"
    }]
  });
});
test("provider-neutral OCR debug payload preserves overlay mode", () => {
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-a"],
      imageRevisionByPage: {
        "page-a": "rev-a"
      },
      imageDigest: "digest-a"
    },
    imageSize: {
      width: 100,
      height: 100
    },
    normalized: [],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: {
      version: 1,
      imageWidth: 100,
      imageHeight: 100,
      rawItems: [{
        id: "raw-1",
        percent: {
          x: 1,
          y: 2,
          w: 3,
          h: 4
        }
      }],
      finalBubbles: []
    },
    ignoreSimplifiedChinese: false,
    debugOverlayMode: "raw",
    debug: true
  });
  assert.equal(result.debug.debugOverlayMode, "raw");
});
test("complex-background cache entries retain the cleaned-image requirement", () => {
  const result = context.__backgroundTest.buildCacheSafeTranslationResult({
    bubbles: [{
      id: "t0",
      bg_type: "none",
      translated_text: "译文"
    }],
    cleanedImage: "data:image/png;base64,large"
  });
  assert.equal(result.cleanedImage, undefined);
  assert.equal(result.requiresCleanedImage, true);
  assert.equal(context.__backgroundTest.translationResultNeedsCleanedImage(result), true);
});
test("translation cache key separates OCR mode, source token, and fallback reason", () => {
  const base = {
    provider: "local_paddle",
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
test("meaningful single Hangul syllables survive OCR filtering and final observations", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 500,
    height: 700
  };
  const word = {
    words: "더",
    confidence: 0.76,
    location: {
      left: 120,
      top: 180,
      width: 18,
      height: 18
    },
    rawBox: {
      left: 120,
      top: 180,
      width: 18,
      height: 18
    }
  };
  assert.equal(background.isMeaningfulOcrText("더"), true);
  assert.equal(background.getOcrWordDropReason(word, imageSize, background.getDefaultOcrTuning()), "");
  const candidate = background.normalizeBaiduOcrItem(word, 0, imageSize);
  assert.ok(candidate);
  assert.equal(background.getFinalCandidateDropReason(candidate, imageSize, background.getDefaultOcrTuning(), "local_paddle"), "");
  const result = background.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-a"],
      imageRevisionByPage: {
        "page-a": "rev-a"
      },
      imageDigest: "digest-a"
    },
    imageSize,
    normalized: [candidate],
    ocrTuning: background.getDefaultOcrTuning(),
    ocrDebug: null,
    ignoreSimplifiedChinese: false
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].originalText, "더");
  assert.equal(result.filteredObservations.length, 0);
});
test("left-aligned comment boxes infer left alignment and keep font-size groups separate", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 420,
    height: 700
  };
  const boxes = [{
    left: 40,
    top: 40,
    right: 110,
    bottom: 52,
    centerX: 75,
    width: 70,
    height: 12
  }, {
    left: 40,
    top: 66,
    right: 250,
    bottom: 92,
    centerX: 145,
    width: 210,
    height: 26
  }, {
    left: 40,
    top: 101,
    right: 185,
    bottom: 127,
    centerX: 112.5,
    width: 145,
    height: 26
  }];
  assert.equal(background.inferTextAlignmentFromBoxes(boxes, imageSize, "chat"), "left");
  const small = {
    text: "user",
    box: boxes[0],
    container: null
  };
  const large = {
    text: "본문",
    box: boxes[1],
    container: null
  };
  assert.equal(background.shouldMergeLocalPaddleParagraphLines({
    text: small.text,
    box: small.box,
    rotation: 0,
    entries: [small]
  }, {
    text: large.text,
    box: large.box,
    rotation: 0,
    entries: [large]
  }), false);
});
test("single chat rows align left while ordinary bubble rows remain centered", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 420,
    height: 700
  };
  const box = {
    left: 40,
    top: 66,
    right: 250,
    bottom: 92,
    centerX: 145,
    width: 210,
    height: 26
  };
  assert.equal(background.inferTextAlignmentFromBoxes([box], imageSize, "chat"), "left");
  assert.equal(background.inferTextAlignmentFromBoxes([box], imageSize, "speech_bubble"), "center");
});
test("nested speech-bubble rows prefer their shared center over loose edge tolerance", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 720,
    height: 1100
  };
  const centeredRows = [{
    left: 310,
    top: 370,
    right: 490,
    bottom: 450,
    centerX: 400,
    width: 180,
    height: 80
  }, {
    left: 220,
    top: 470,
    right: 580,
    bottom: 552,
    centerX: 400,
    width: 360,
    height: 82
  }];
  const leftAlignedRows = [{
    left: 100,
    top: 620,
    right: 280,
    bottom: 670,
    centerX: 190,
    width: 180,
    height: 50
  }, {
    left: 104,
    top: 684,
    right: 450,
    bottom: 736,
    centerX: 277,
    width: 346,
    height: 52
  }];
  assert.equal(background.inferTextAlignmentFromBoxes(centeredRows, imageSize, "speech_bubble"), "center");
  assert.equal(background.inferTextAlignmentFromBoxes(leftAlignedRows, imageSize, "speech_bubble"), "left");
});
test("rotated two-line candidate coalescing preserves visual top-to-bottom order", () => {
  const background = context.__backgroundTest;
  const lower = {
    x: 27,
    y: 28,
    w: 28,
    h: 5,
    original_text: "저런 거잖아!!",
    translated_text: "",
    rotation_deg: -18,
    bg_type: "none",
    confidence: 0.92
  };
  const upper = {
    x: 44,
    y: 20,
    w: 18,
    h: 5,
    original_text: "일부러",
    translated_text: "",
    rotation_deg: -18,
    bg_type: "none",
    confidence: 0.91
  };
  const sorted = background.sortOcrCandidatesByReadingOrder([lower, upper]);
  assert.deepEqual(Array.from(sorted, item => item.original_text), ["일부러", "저런 거잖아!!"]);
  const merged = background.mergeOcrCandidateGroup([lower, upper], 0);
  assert.equal(merged.original_text, "일부러\n저런 거잖아!!");
});
test("rotated OCR rows use polygon thickness instead of inflated axis-aligned height", () => {
  const background = context.__backgroundTest;
  const buildBox = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    centerX: left + width / 2,
    centerY: top + height / 2
  });
  const upper = {
    text: "일부러 보라고",
    rotation: -13.36,
    box: buildBox(448, 61, 170, 79),
    item: {
      words: "일부러 보라고",
      polygon: [{
        x: 448,
        y: 99
      }, {
        x: 608,
        y: 61
      }, {
        x: 618,
        y: 102
      }, {
        x: 458,
        y: 140
      }]
    }
  };
  const lower = {
    text: "저런 거잖아!!",
    rotation: -12.6,
    box: buildBox(457, 106, 172, 80),
    item: {
      words: "저런 거잖아!!",
      polygon: [{
        x: 457,
        y: 142
      }, {
        x: 618,
        y: 106
      }, {
        x: 629,
        y: 150
      }, {
        x: 467,
        y: 186
      }]
    }
  };
  assert.equal(background.estimateRotatedClusterLineCount([lower, upper], -12.6), 2);
  assert.equal(background.composeRotatedClusterWords([lower, upper], -12.6), "일부러 보라고\n저런 거잖아!!");
});
test("translation cache automatically clears old entries and retries after quota failure", async () => {
  const stored = {
    "mt_cache_v2:old": {
      timestamp: 1,
      value: {
        bubbles: []
      }
    },
    mt_api_key: "keep-setting"
  };
  let writeAttempts = 0;
  context.chrome.storage.local.get = (keys, callback) => {
    callback(keys === null ? {
      ...stored
    } : Object.fromEntries(keys.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.remove = (keys, callback) => {
    keys.forEach(key => delete stored[key]);
    callback();
  };
  context.chrome.storage.local.set = (value, callback) => {
    writeAttempts += 1;
    if (writeAttempts === 1) {
      context.chrome.runtime.lastError = {
        message: "Resource::kQuotaBytes quota exceeded"
      };
      callback();
      context.chrome.runtime.lastError = null;
      return;
    }
    Object.assign(stored, value);
    callback();
  };
  const cached = await context.__backgroundTest.setCache("mt_cache_v4:new", {
    bubbles: [{
      id: "t0",
      translated_text: "译文"
    }],
    cleanedImage: "data:image/png;base64,large"
  });
  assert.equal(cached, true);
  assert.equal(writeAttempts, 2);
  assert.equal(stored["mt_cache_v2:old"], undefined);
  assert.equal(stored.mt_api_key, "keep-setting");
  assert.deepEqual(JSON.parse(JSON.stringify(stored["mt_cache_v4:new"].value)), {
    bubbles: [{
      id: "t0",
      translated_text: "译文"
    }]
  });
});
