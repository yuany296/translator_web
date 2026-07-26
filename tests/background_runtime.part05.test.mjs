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
test("seam OCR rejects complete page text and keeps only strict cross-boundary evidence", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 720,
    height: 192
  };
  const request = {
    sourceType: "seam",
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
  const result = background.filterSeamOcrCandidates([candidate("upper complete bubble", {
    left: 140,
    top: 20,
    width: 240,
    height: 28
  }), candidate("lower publish button", {
    left: 600,
    top: 132,
    width: 72,
    height: 20
  }), candidate("crosses the real page seam", {
    left: 220,
    top: 84,
    width: 240,
    height: 24
  }), candidate("oversized mixed seam scene", {
    left: 20,
    top: 0,
    width: 680,
    height: 192
  })], request, imageSize);
  assert.deepEqual(Array.from(result.retained, item => item.original_text), ["crosses the real page seam"]);
  assert.equal(result.rejected.length, 3);
  assert.equal(result.rejected.every(item => item.reason === "seam_not_cross_boundary"), true);
});
test("seam OCR can join only compatible fragments immediately above and below the boundary", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 720,
    height: 192
  };
  const request = {
    sourceType: "seam",
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
  const result = background.filterSeamOcrCandidates([candidate("upper fragment", {
    left: 220,
    top: 76,
    width: 220,
    height: 16
  }), candidate("lower fragment", {
    left: 226,
    top: 100,
    width: 214,
    height: 16
  }), candidate("unrelated lower UI", {
    left: 600,
    top: 102,
    width: 60,
    height: 16
  })], request, imageSize);
  assert.equal(result.retained.length, 1);
  assert.equal(result.retained[0].original_text, "upper fragment\nlower fragment");
  assert.equal(result.retained[0].source_line_count, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "seam_not_cross_boundary");
});
test("seam OCR keeps boundary text when its reliable speech region crosses both pages", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 720,
    height: 192
  };
  const request = {
    sourceType: "seam",
    pageIds: ["page-upper", "page-lower"],
    imageRevisionByPage: {
      "page-upper": "revision-upper",
      "page-lower": "revision-lower"
    },
    imageDigest: "digest-live-boundary-bubble",
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
  const result = background.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request,
    imageSize,
    normalized: [{
      original_text: "밥이요?\n네, 먹었죠.",
      x: 61.94,
      y: 0.52,
      w: 21.11,
      h: 48.96,
      rawBox: {
        left: 446,
        top: 1,
        width: 152,
        height: 94
      },
      fill_box: {
        x: 58,
        y: 4,
        w: 28,
        h: 58
      },
      region_polygon: [{
        x: 57.08,
        y: 0
      }, {
        x: 87.78,
        y: 0
      }, {
        x: 87.78,
        y: 66.15
      }, {
        x: 57.08,
        y: 66.15
      }],
      confidence: 0.96,
      bg_type: "solid",
      bg_confidence: 0.98,
      region_type: "speech_bubble"
    }],
    ocrTuning: background.getDefaultOcrTuning(),
    ocrDebug: {
      filterReasons: []
    },
    ignoreSimplifiedChinese: false,
    debug: false
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.filteredObservations.length, 0);
  assert.equal(result.observations[0].originalText, "밥이요? 네, 먹었죠.");
  assert.deepEqual(Array.from(result.observations[0].pageSpans, span => span.pageId), ["page-upper", "page-lower"]);
  assert.equal(result.observations[0].pageSpans.every(span => span.overlapRatio > 0), true);
});
test("seam OCR keeps both page spans after overlapping speech containers are unified", async () => {
  const background = context.__backgroundTest;
  const imageSize = { width: 760, height: 192 };
  const item = (text, box, side) => ({
    text,
    box,
    score: 0.99,
    det_score: 0.95,
    rotation_deg: 0,
    region_id: `seam-bubble-${side}`,
    region_type: "speech_bubble",
    region_confidence: 0.95,
    bg_color: side === "left" ? "#f3edec" : "#fbf7f6",
    text_color: "#240c0c",
    stroke_color: "#ffffff",
    region_polygon: side === "left" ? [[187, 19], [385, 19], [385, 192], [187, 192]] : [[289, 27], [595, 27], [595, 192], [289, 192]],
    region_box: side === "left" ? { left: 187, top: 19, width: 198, height: 173 } : { left: 289, top: 27, width: 306, height: 165 }
  });
  const clustered = await background.buildLocalPaddleBubbleItems({
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    items: [
      item("<화요", { left: 223, top: 73, width: 114, height: 54 }, "left"),
      item("퀴즈쇼>의", { left: 344, top: 77, width: 196, height: 47 }, "right"),
      item("A등급", { left: 223, top: 134, width: 126, height: 53 }, "left"),
      item("재조정은", { left: 360, top: 136, width: 176, height: 52 }, "right")
    ]
  }, imageSize, "", false);
  assert.equal(clustered.length, 1);
  const normalized = background.normalizeBaiduOcrItem(clustered[0], 0, imageSize);
  const result = background.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "seam",
      pageIds: ["page-upper", "page-lower"],
      imageRevisionByPage: { "page-upper": "rev-upper", "page-lower": "rev-lower" },
      imageDigest: "digest-overlapping-seam-regions",
      imageMeta: {
        pageSpans: [{
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
        }]
      }
    },
    imageSize,
    normalized: [normalized],
    ocrTuning: background.getDefaultOcrTuning(),
    ocrDebug: { filterReasons: [] },
    ignoreSimplifiedChinese: false,
    debug: false
  });
  assert.equal(result.observations.length, 1);
  assert.deepEqual(Array.from(result.observations[0].pageSpans, span => span.pageId), ["page-upper", "page-lower"]);
  assert.equal(result.observations[0].pageSpans.every(span => span.overlapRatio > 0), true);
});
test("seam OCR does not use oversized visual regions to promote one-page text", () => {
  const background = context.__backgroundTest;
  const imageSize = {
    width: 720,
    height: 192
  };
  const request = {
    sourceType: "seam",
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
  const rawBox = {
    left: 220,
    top: 64,
    width: 220,
    height: 24
  };
  const result = background.filterSeamOcrCandidates([{
    original_text: "ordinary upper-page text",
    x: rawBox.left / imageSize.width * 100,
    y: rawBox.top / imageSize.height * 100,
    w: rawBox.width / imageSize.width * 100,
    h: rawBox.height / imageSize.height * 100,
    rawBox,
    region_polygon: [{
      x: 1,
      y: 0
    }, {
      x: 99,
      y: 0
    }, {
      x: 99,
      y: 100
    }, {
      x: 1,
      y: 100
    }],
    confidence: 0.99,
    bg_type: "solid",
    bg_confidence: 0.99,
    region_type: "speech_bubble"
  }], request, imageSize);
  assert.equal(result.retained.length, 0);
  assert.equal(result.rejected[0].reason, "seam_not_cross_boundary");
});
test("visual fill regions trigger seam evidence even when the OCR text box is interior", () => {
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-visual-edge"],
      imageRevisionByPage: {
        "page-visual-edge": "revision-visual-edge"
      },
      imageDigest: "digest-visual-edge",
      imageMeta: {
        pageSpans: []
      }
    },
    imageSize: {
      width: 800,
      height: 1600
    },
    normalized: [{
      x: 25,
      y: 45,
      w: 40,
      h: 8,
      fill_box: {
        x: 24,
        y: 94,
        w: 42,
        h: 5
      },
      original_text: "테스트 대사",
      confidence: 0.99,
      rawBox: {
        left: 200,
        top: 720,
        width: 320,
        height: 128
      },
      bg_type: "solid",
      region_id: "visual-edge-region",
      region_type: "speech_bubble"
    }],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: {
      filterReasons: []
    },
    ignoreSimplifiedChinese: false,
    debug: false
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].pageSpans[0].box.y < 80, true);
  assert.equal(result.edgeSignals.bottom.detected, true);
  assert.equal(result.edgeSignals.bottom.visualDetected, true);
});
test("chat metadata remains translatable observations instead of filtered evidence", () => {
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
    rawBox: {
      left: 80,
      top: top * 10,
      width: 240,
      height: 32
    }
  });
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["chat-page"],
      imageRevisionByPage: {
        "chat-page": "revision-chat"
      },
      imageDigest: "digest-chat",
      imageMeta: {
        pageSpans: []
      }
    },
    imageSize: {
      width: 800,
      height: 800
    },
    normalized: [base("사용자", 10, true), base("오늘의 본문입니다", 20)],
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: {
      filterReasons: []
    },
    ignoreSimplifiedChinese: false,
    debug: false
  });
  assert.equal(result.observations.length, 2);
  assert.equal(result.filteredObservations.length, 0);
  assert.equal(result.observations.every(row => row.visual && row.visual.regionType === "chat"), true);
});
test("provider-neutral OCR accounts for every max-bubbles overflow as filtered evidence", () => {
  const normalized = Array.from({
    length: 405
  }, (_, index) => ({
    x: 10,
    y: 30,
    w: 20,
    h: 8,
    original_text: `테스트대사${index}`,
    confidence: 0.99,
    rawBox: {
      left: 76,
      top: 360,
      width: 152,
      height: 96
    },
    bg_type: "solid",
    region_id: `region-${index}`,
    region_type: "speech_bubble"
  }));
  const result = context.__backgroundTest.buildProviderNeutralObservationResult({
    provider: "local_paddle",
    request: {
      sourceType: "page",
      pageIds: ["page-overflow"],
      imageRevisionByPage: {
        "page-overflow": "revision-overflow"
      },
      imageDigest: "digest-overflow",
      imageMeta: {
        pageSpans: []
      }
    },
    imageSize: {
      width: 760,
      height: 1200
    },
    normalized,
    ocrTuning: context.__backgroundTest.getDefaultOcrTuning(),
    ocrDebug: {
      filterReasons: []
    },
    ignoreSimplifiedChinese: false,
    debug: false
  });
  assert.equal(result.observations.length, 400);
  assert.equal(result.filteredObservations.filter(item => item.filterReason === "max_bubbles").length, 5);
  assert.equal(result.observations.length + result.filteredObservations.length, normalized.length);
});
test("OCR_DATA_URL validates only provider OCR credentials and never invokes translation", async () => {
  const background = context.__backgroundTest;
  const dataUrl = "data:image/png;base64,QUJDRA==";
  let ocrCalls = 0;
  let translationCalls = 0;
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({
      request,
      settings
    }) => {
      ocrCalls += 1;
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: {
          hasAny: false
        }
      };
    },
    requestCanonicalTranslationBatch: async () => {
      translationCalls += 1;
      return [];
    }
  });
  installMemoryStorage(separatedConfiguration({
    ocrProvider: "baidu",
    baiduApiKey: "ak",
    baiduSecretKey: "sk"
  }));
  const baidu = await background.handleOcrDataUrl({
    dataUrl,
    sourceType: "page",
    pageIds: ["page-baidu"],
    imageRevision: "revision-baidu"
  });
  assert.equal(baidu.ok, true);
  assert.equal(baidu.result.provider, "baidu");
  installMemoryStorage(separatedConfiguration());
  const local = await background.handleOcrDataUrl({
    dataUrl: "data:image/png;base64,RUZHSA==",
    sourceType: "page",
    pageIds: ["page-local"],
    imageRevision: "revision-local"
  });
  background.setBackgroundTestHooks(null);
  assert.equal(local.ok, true);
  assert.equal(local.result.provider, "local_paddle");
  assert.equal(ocrCalls, 2);
  assert.equal(translationCalls, 0);
});
test("OCR cache removes cleaned image bytes while retaining the refresh requirement", () => {
  const safe = context.__backgroundTest.buildCacheSafeOcrResult({
    observations: [{
      id: "obs-a",
      visual: {
        bgType: "none"
      }
    }],
    filteredObservations: [],
    cleanedImage: "data:image/png;base64,QUJDRA==",
    cleanedImageToken: "artifact-token",
    debug: {
      large: true
    }
  });
  assert.equal(safe.cleanedImage, undefined);
  assert.equal(safe.cleanedImageToken, undefined);
  assert.equal(safe.debug, undefined);
  assert.equal(safe.requiresCleanedImage, true);
  const solid = context.__backgroundTest.buildCacheSafeOcrResult({
    observations: [{
      id: "obs-solid",
      visual: {
        bgType: "solid"
      }
    }],
    cleanedImage: "data:image/png;base64,QUJDRA=="
  });
  assert.equal(solid.cleanedImage, undefined);
  assert.equal(solid.requiresCleanedImage, undefined);
});
