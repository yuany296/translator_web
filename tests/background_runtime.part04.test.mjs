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
test("overlapping translated substring keeps only the complete sentence", () => {
  const collapse = context.__backgroundTest.collapseDuplicateLocalPaddleTranslations;
  const result = collapse([{
    x: 35,
    y: 20,
    w: 20,
    h: 10,
    fill_box: {
      x: 34,
      y: 19,
      w: 22,
      h: 12
    },
    original_text: "아, 물론",
    translated_text: "啊，当然",
    source_line_count: 1
  }, {
    x: 20,
    y: 18,
    w: 60,
    h: 36,
    fill_box: {
      x: 18,
      y: 16,
      w: 64,
      h: 40
    },
    original_text: "아, 물론 이대로 모든 게 끝나는 건 아닙니다!",
    translated_text: "啊，当然——一切不会就这么结束的！",
    source_line_count: 3
  }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].translated_text, "啊，当然——一切不会就这么结束的！");
  assert.equal(result[0].original_text, "아, 물론 이대로 모든 게 끝나는 건 아닙니다!");
  assert.equal(result[0].source_line_count, 3);
  assert.deepEqual({
    ...result[0].fill_box
  }, {
    x: 18,
    y: 16,
    w: 64,
    h: 40
  });
});
test("lightly touching translated substring boxes keep only the complete sentence", () => {
  const collapse = context.__backgroundTest.collapseDuplicateLocalPaddleTranslations;
  const result = collapse([{
    x: 35,
    y: 20,
    w: 20,
    h: 8,
    original_text: "short",
    translated_text: "啊，当然"
  }, {
    x: 25,
    y: 27,
    w: 50,
    h: 24,
    original_text: "full",
    translated_text: "啊，当然一切不会这样结束"
  }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].translated_text, "啊，当然一切不会这样结束");
});
test("translated substring in a separate region is not collapsed", () => {
  const collapse = context.__backgroundTest.collapseDuplicateLocalPaddleTranslations;
  const result = collapse([{
    x: 10,
    y: 10,
    w: 20,
    h: 8,
    original_text: "아, 물론",
    translated_text: "啊，当然"
  }, {
    x: 60,
    y: 60,
    w: 30,
    h: 20,
    original_text: "full",
    translated_text: "啊，当然还有别的事情"
  }]);
  assert.equal(result.length, 2);
});
test("v28 OCR cache invalidates old observation semantics and excludes translation and render settings", () => {
  const build = context.__backgroundTest.buildOcrCacheKey;
  const request = {
    imageDigest: "digest-a",
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: {
      "page-a": "revision-a"
    },
    imageMeta: {
      width: 760,
      height: 1200,
      pageSpans: []
    }
  };
  const settings = {
    provider: "local_paddle",
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
  const first = build({
    request,
    settings
  });
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
  const newImage = build({
    request: {
      ...request,
      imageDigest: "digest-b"
    },
    settings
  });
  const newRevision = build({
    request: {
      ...request,
      imageRevisionByPage: {
        "page-a": "revision-b"
      }
    },
    settings
  });
  const newChineseFilter = build({
    request,
    settings: {
      ...settings,
      ignoreSimplifiedChinese: true
    }
  });
  const originalGeometryVersion = context.__backgroundTest.LOCAL_OCR_GEOMETRY_VERSION;
  context.__backgroundTest.LOCAL_OCR_GEOMETRY_VERSION = `${originalGeometryVersion}-future`;
  const newGeometryContract = build({
    request,
    settings
  });
  context.__backgroundTest.LOCAL_OCR_GEOMETRY_VERSION = originalGeometryVersion;
  const newCleanedMask = build({
    request: {
      ...request,
      cleanedMasks: [{
        coordinateSpace: "percent",
        box: {
          x: 20,
          y: 90,
          w: 50,
          h: 10
        }
      }]
    },
    settings
  });
  assert.match(first, /^mt_cache_v28:ocr:/);
  assert.doesNotMatch(first, /^mt_cache_v2[5-7]:ocr:/);
  assert.equal(first, translationAndRenderChanged);
  assert.equal(first, newCleanedMask, "render-only masks must not split semantic OCR cache entries");
  assert.notEqual(first, newImage);
  assert.notEqual(first, newRevision);
  assert.notEqual(first, newChineseFilter);
  assert.notEqual(first, newGeometryContract, "OCR geometry contract changes must invalidate semantic OCR cache entries");
});
test("seam OCR preserves real line groups before joining a boundary-overshoot row to the next page", async () => {
  const background = context.__backgroundTest;
  const imageSize = { width: 760, height: 192 };
  const pageSpans = [{
    pageId: "page-upper",
    canvasBox: { x: 0, y: 0, w: 760, h: 96 },
    pageBox: { x: 0, y: 904, w: 760, h: 96 },
    pageWidth: 760,
    pageHeight: 1000
  }, {
    pageId: "page-lower",
    canvasBox: { x: 0, y: 96, w: 760, h: 96 },
    pageBox: { x: 0, y: 0, w: 760, h: 96 },
    pageWidth: 760,
    pageHeight: 1000
  }];
  const item = (text, left, top, width, height, regionType = "effect_text") => ({
    text,
    score: 0.92,
    box: { left, top, width, height },
    region_type: regionType,
    region_id: regionType === "caption_panel" ? "region-1" : "",
    region_box: regionType === "caption_panel" ? { left: 369, top: 0, width: 391, height: 153 } : null,
    bg_color: regionType === "caption_panel" ? "#000000" : "",
    text_color: "#fcfcfc",
    stroke_color: "#000000"
  });
  const debugSession = { filterReasons: [] };
  const clustered = await background.buildLocalPaddleBubbleItems({
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    items: [
      item("잡초(민들레", 59, 68, 216, 46),
      item("추정)를", 288, 69, 139, 43),
      item("뜯어서 기계에", 441, 68, 254, 45, "caption_panel"),
      item("두번 투입.", 57, 145, 194, 46)
    ]
  }, imageSize, "", false, null, background.getDefaultOcrTuning(), debugSession, { pageSpans });
  const request = {
    sourceType: "seam",
    pageIds: ["page-upper", "page-lower"],
    imageRevisionByPage: { "page-upper": "revision-upper", "page-lower": "revision-lower" },
    imageDigest: "real-boundary-overshoot",
    imageMeta: { sourceType: "seam", pageSpans }
  };
  const result = background.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request,
    imageSize,
    normalized: clustered.map((entry, index) => background.normalizeBaiduOcrItem(entry, index, imageSize)).filter(Boolean),
    ocrTuning: background.getDefaultOcrTuning(),
    ocrDebug: debugSession,
    ignoreSimplifiedChinese: false,
    debug: false
  });
  assert.equal(result.observations.length, 1, JSON.stringify({
    clustered,
    filtered: result.filteredObservations
  }, null, 2));
  assert.match(result.observations[0].originalText.replace(/\s+/gu, ""), /잡초.*두번투입\./u);
  assert.deepEqual(Array.from(result.observations[0].pageSpans, span => span.pageId), ["page-upper", "page-lower"]);
});
test("cleaned masks clamp, quantize, deduplicate, sort, and reject non-percent geometry", () => {
  const normalize = context.__backgroundTest.normalizeCleanedMasks;
  const duplicateBox = {
    coordinate_space: "percent",
    box: {
      left: -10,
      top: 89.99996,
      width: 30,
      height: 20
    }
  };
  const masks = normalize([{
    coordinateSpace: "pixel",
    box: {
      x: 0,
      y: 0,
      w: 5,
      h: 5
    }
  }, {
    coordinateSpace: "percent",
    box: {
      x: 25,
      y: 30,
      w: 0,
      h: 10
    }
  }, {
    coordinateSpace: "percent",
    polygon: [[110, -5], {
      x: 80.00004,
      y: 10
    }, {
      x: 70,
      y: 30
    }, {
      x: 110,
      y: -5
    }]
  }, duplicateBox, {
    coordinateSpace: "percent",
    box: {
      x: -10.00001,
      y: 90,
      w: 30.00001,
      h: 10
    }
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(masks)), [{
    coordinateSpace: "percent",
    box: {
      x: 0,
      y: 90,
      w: 20,
      h: 10
    }
  }, {
    coordinateSpace: "percent",
    polygon: [{
      x: 70,
      y: 30
    }, {
      x: 100,
      y: 0
    }, {
      x: 80,
      y: 10
    }]
  }]);
});
test("cleaned mask normalization is order-stable and caps the artifact contract at 200 masks", () => {
  const background = context.__backgroundTest;
  const inputs = Array.from({
    length: 205
  }, (_value, index) => ({
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
  assert.equal(background.buildCleanedMasksFingerprint([...inputs, inputs[0]]), background.buildCleanedMasksFingerprint([...inputs].reverse()));
  assert.notEqual(background.buildCleanedMasksFingerprint(inputs), background.buildCleanedMasksFingerprint([{
    coordinateSpace: "percent",
    box: {
      x: 1,
      y: 1,
      w: 1,
      h: 1
    }
  }]));
  const polygon = [{
    x: 10,
    y: 10
  }, {
    x: 80,
    y: 20
  }, {
    x: 70,
    y: 60
  }, {
    x: 20,
    y: 70
  }];
  assert.equal(background.buildCleanedMasksFingerprint([{
    coordinateSpace: "percent",
    polygon
  }]), background.buildCleanedMasksFingerprint([{
    coordinateSpace: "percent",
    polygon: [polygon[2], polygon[1], polygon[0], polygon[3]]
  }]));
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
    translationOptions: {
      tone: "manga"
    }
  };
  const first = build(base);
  assert.equal(first, build({
    ...base,
    originalText: "오늘은   간다!",
    baseUrl: "https://api.example.test"
  }));
  assert.notEqual(first, build({
    ...base,
    originalText: "오늘은 간다?"
  }));
  assert.notEqual(first, build({
    ...base,
    sourceLanguage: "ja"
  }));
  assert.notEqual(first, build({
    ...base,
    targetLanguage: "en"
  }));
  assert.notEqual(first, build({
    ...base,
    model: "model-b"
  }));
  assert.notEqual(first, build({
    ...base,
    promptVersion: "prompt-b"
  }));
  assert.notEqual(first, build({
    ...base,
    glossaryFingerprint: "glossary-b"
  }));
  assert.notEqual(first, build({
    ...base,
    translationOptions: {
      tone: "literal"
    }
  }));
});
test("provider-neutral OCR observations are immutable, filtered with reasons, and expose edge evidence", () => {
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-a"],
      imageRevisionByPage: {
        "page-a": "revision-a"
      },
      imageDigest: "digest-a",
      imageMeta: {
        pageSpans: []
      }
    },
    imageSize: {
      width: 760,
      height: 1200
    },
    normalized: [{
      x: 20,
      y: 93,
      w: 40,
      h: 5,
      original_text: "다음 페이지로 이어진다!",
      confidence: 0.99,
      rawBox: {
        left: 152,
        top: 1116,
        width: 304,
        height: 60
      },
      bg_type: "solid",
      region_type: "speech_bubble"
    }, {
      x: 30,
      y: 96,
      w: 2,
      h: 1,
      original_text: "A",
      confidence: 0.2,
      rawBox: {
        left: 228,
        top: 1152,
        width: 15,
        height: 12
      },
      bg_type: "none"
    }],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: {
      filterReasons: []
    },
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
test("retained OCR evidence cannot be shadowed by a debug filtered observation with the same id", () => {
  const candidate = {
    x: 8.75,
    y: 41.67,
    w: 54.58,
    h: 19.79,
    original_text: "경계를 가로지르는 대사",
    confidence: 0.99,
    rawBox: {
      left: 63,
      top: 80,
      width: 393,
      height: 38
    },
    bg_type: "solid",
    region_type: "speech_bubble"
  };
  const request = {
    sourceType: "seam",
    pageIds: ["page-upper", "page-lower"],
    imageRevisionByPage: {
      "page-upper": "rev-upper",
      "page-lower": "rev-lower"
    },
    imageDigest: "digest-seam",
    imageMeta: {
      pageSpans: [{
        pageId: "page-upper",
        canvasBox: {
          x: 0,
          y: 0,
          w: 720,
          h: 96
        },
        pageBox: {
          x: 0,
          y: 1004,
          w: 720,
          h: 96
        },
        pageWidth: 720,
        pageHeight: 1100
      }, {
        pageId: "page-lower",
        canvasBox: {
          x: 0,
          y: 96,
          w: 720,
          h: 96
        },
        pageBox: {
          x: 0,
          y: 0,
          w: 720,
          h: 96
        },
        pageWidth: 720,
        pageHeight: 1100
      }]
    }
  };
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request,
    imageSize: {
      width: 720,
      height: 192
    },
    normalized: [candidate],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: {
      filterReasons: [{
        stage: "filter",
        reason: "duplicate-provider-variant",
        item: {
          text: candidate.original_text,
          confidence: candidate.confidence,
          rawBox: candidate.rawBox,
          percent: {
            x: candidate.x,
            y: candidate.y,
            w: candidate.w,
            h: candidate.h
          }
        }
      }]
    },
    ignoreSimplifiedChinese: false,
    debug: true
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.filteredObservations.length, 0);
  assert.equal(result.counts.filteredShadowedByRetained, 1);
});
test("legacy OCR cache payload drops filtered observations that conflict with retained ids", () => {
  const observation = {
    id: "obs-shared",
    originalText: "경계 대사"
  };
  const result = context.__backgroundTest.deepFreezeObservationResult({
    observations: [observation],
    filteredObservations: [{
      ...observation,
      filterReason: "legacy-debug-filter"
    }],
    counts: {
      retained: 1,
      filtered: 1
    }
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.filteredObservations.length, 0);
  assert.equal(result.counts.filteredShadowedByRetained, 1);
  assert.equal(Object.isFrozen(result), true);
});
