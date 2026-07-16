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
test("slanted edge lettering stays separate across owner and adjacent-page OCR variants", async () => {
  const region = {
    region_id: "region-dialog",
    region_type: "caption_panel",
    region_box: {
      left: 130,
      top: 230,
      width: 505,
      height: 335
    },
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
    box: {
      left,
      top,
      width,
      height
    }
  });
  const variants = [[item("그래도", 300, 285, 100, 51), item("아직타이틀곡", 256, 338, 186, 48), item("무대는 남았으니까", 223, 390, 250, 47), item("같이보자", 404, 448, 138, 65, -6.96)], [item("그래도", 301, 1289, 97, 44), item("아직타이틀곡", 258, 1342, 182, 43), item("무대는 남았으니까", 225, 1390, 246, 48), item("같이보자", 408, 1455, 132, 55, -4.47)]];
  for (const items of variants) {
    const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
      imageWidth: 760,
      imageHeight: 1700,
      items
    }, {
      width: 760,
      height: 1700
    }, "", false);
    assert.equal(result.length, 2, JSON.stringify(result.map(entry => entry.words)));
    assert.deepEqual(JSON.parse(JSON.stringify(result.map(entry => entry.sourceLineCount))), [3, 1]);
    assert.match(result[0].words, /무대는 남았으니까/);
    assert.doesNotMatch(result[0].words, /같이보자/);
    assert.match(result[1].words, /같이보자/);
    const finalCandidates = context.__backgroundTest.coalesceOverlappingOcrCandidates(result.map((entry, index) => context.__backgroundTest.normalizeBaiduOcrItem(entry, index, {
      width: 760,
      height: 1700
    })));
    assert.equal(finalCandidates.length, 2, JSON.stringify(finalCandidates.map(entry => entry.original_text)));
    assert.doesNotMatch(finalCandidates[0].original_text, /같이보자/);
    assert.match(finalCandidates[1].original_text, /같이보자/);
  }
});
test("local paragraph display box stays tight and its solid background uses the same bounds", async () => {
  const region = {
    region_id: "region-panel",
    region_type: "caption_panel",
    region_box: {
      left: 150,
      top: 100,
      width: 500,
      height: 320
    },
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
    box: {
      left,
      top,
      width,
      height
    }
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 760,
    imageHeight: 900,
    items: [item("조심해", 280, 150, 120, 50), item("빨리 도망치지 않으면", 200, 210, 360, 52), item("죽을 거야", 300, 272, 160, 48)]
  }, {
    width: 760,
    height: 900
  }, "", false);
  assert.equal(result.length, 1);
  const block = result[0];
  assert.ok(block.location.width <= 360 * 1.08, JSON.stringify(block.location));
  assert.ok(block.location.height <= 170 * 1.09, JSON.stringify(block.location));
  assert.ok(block.location.left >= 187 && block.location.top >= 143, JSON.stringify(block.location));
  const candidate = context.__backgroundTest.normalizeBaiduOcrItem(block, 0, {
    width: 760,
    height: 900
  });
  const fillLeft = candidate.fill_box.x / 100 * 760;
  const fillTop = candidate.fill_box.y / 100 * 900;
  const fillRight = fillLeft + candidate.fill_box.w / 100 * 760;
  const fillBottom = fillTop + candidate.fill_box.h / 100 * 900;
  assert.ok(Math.abs(fillLeft - block.location.left) < 1e-9);
  assert.ok(Math.abs(fillTop - block.location.top) < 1e-9);
  assert.ok(Math.abs(fillRight - (block.location.left + block.location.width)) < 1e-9);
  assert.ok(Math.abs(fillBottom - (block.location.top + block.location.height)) < 1e-9);
});
test("high-confidence speech bubbles use their interior region for layout and paint", async () => {
  const regionBox = {
    left: 120,
    top: 160,
    width: 360,
    height: 220
  };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
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
      box: {
        left: 245,
        top: 245,
        width: 110,
        height: 40
      }
    }]
  }, {
    width: 760,
    height: 900
  }, "", false);
  assert.equal(result.length, 1);
  assert.ok(result[0].location.width > 200, JSON.stringify(result[0].location));
  const candidate = context.__backgroundTest.normalizeBaiduOcrItem(result[0], 0, {
    width: 760,
    height: 900
  });
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
    box: {
      left,
      top,
      width,
      height
    }
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 760,
    imageHeight: 1700,
    items: [item("네?!그게 무슨..", 181, 882, 223, 46), item("여긴 서울..아니에요?", 161, 935, 287, 46), item("전 그냥", 395, 1022, 104, 46), item("지하철을 타려고", 338, 1073, 217, 43), item("했을 뿐인데....", 347, 1121, 168, 50)]
  }, {
    width: 760,
    height: 1700
  }, "", false);
  assert.equal(result.length, 2, JSON.stringify(result.map(entry => entry.words)));
  assert.deepEqual(JSON.parse(JSON.stringify(result.map(entry => entry.sourceLineCount))), [2, 3]);
  assert.match(result[0].words, /여긴 서울/);
  assert.doesNotMatch(result[0].words, /지하철/);
  assert.match(result[1].words, /지하철을 타려고/);
  const finalCandidates = context.__backgroundTest.coalesceOverlappingOcrCandidates(result.map((entry, index) => context.__backgroundTest.normalizeBaiduOcrItem(entry, index, {
    width: 760,
    height: 1700
  })));
  assert.equal(finalCandidates.length, 2, JSON.stringify(finalCandidates.map(entry => entry.original_text)));
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
    box: {
      left,
      top,
      width,
      height
    }
  });
  const payload = {
    imageWidth: 760,
    imageHeight: 1700,
    items: [item("솔직히편집이개노잼이었음N", 53, 407, 367, 34), item("자막너무오글거려", 49, 490, 244, 45), item("저 구성과 컨셉으로 지루한것도 신기하더라", 53, 584, 493, 32), item("테스타도나오고그외남돌라이징들다나왔는데", 53, 627, 579, 34), item("국대출신 아이돌도 있었는데 화면을 그거밖에 못뽑아내", 55, 717, 657, 34), item("유튜브에서 팬들이 재편집해놨는데 그거봐봐 존잼임", 55, 806, 597, 32), item("화랑소재는잘잡아놓고ㅠㅠㅠ", 53, 892, 384, 34), item("가나다라", 30, 960, 700, 20)]
  };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(payload, {
    width: 760,
    height: 1700
  }, "", false);
  const texts = result.map(entry => entry.words);
  assert.equal(result.length, 6, JSON.stringify(texts));
  assert.ok(texts.some(text => text.includes("국대출신 아이돌도")));
  assert.ok(texts.some(text => text.includes("유튜브에서 팬들이")));
  assert.ok(!texts.some(text => text.includes("가나다라")));
});
test("screenshot crop OCR coordinates accumulate in the original image space", () => {
  const payload = context.__backgroundTest.collectSourceImageOcrPayload({
    imageWidth: 400,
    imageHeight: 300,
    items: [{
      text: "원문",
      score: 0.9,
      box: {
        left: 40,
        top: 30,
        width: 80,
        height: 60
      }
    }]
  }, {
    width: 400,
    height: 300
  }, {
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
  });
  assert.equal(payload.imageWidth, 800);
  assert.equal(payload.imageHeight, 1200);
  assert.deepEqual({
    ...payload.items[0].box
  }, {
    left: 80,
    top: 360,
    width: 160,
    height: 120
  });
});
test("block translation cache key depends on source image, normalized text, and bbox", () => {
  const item = {
    original_text: " 같은 문장 ",
    rawBox: {
      left: 10,
      top: 20,
      width: 30,
      height: 40
    }
  };
  const first = context.__backgroundTest.buildBlockTranslationCacheKey("source-a", item, "model", "base");
  const normalized = context.__backgroundTest.buildBlockTranslationCacheKey("source-a", {
    ...item,
    original_text: "같은문장"
  }, "model", "base");
  const moved = context.__backgroundTest.buildBlockTranslationCacheKey("source-a", {
    ...item,
    rawBox: {
      left: 20,
      top: 20,
      width: 30,
      height: 40
    }
  }, "model", "base");
  const otherImage = context.__backgroundTest.buildBlockTranslationCacheKey("source-b", item, "model", "base");
  assert.equal(first, normalized);
  assert.notEqual(first, moved);
  assert.notEqual(first, otherImage);
});
test("glossary fingerprint invalidates full-image and block translation caches", () => {
  const base = {
    provider: "local_paddle",
    model: "model",
    dataUrl: "data:image/png;base64,AAAA"
  };
  const item = {
    original_text: "성현",
    rawBox: {
      left: 10,
      top: 20,
      width: 30,
      height: 40
    }
  };
  assert.notEqual(context.__backgroundTest.buildCacheKey({
    ...base,
    glossaryFingerprint: "g1-old"
  }), context.__backgroundTest.buildCacheKey({
    ...base,
    glossaryFingerprint: "g1-new"
  }));
  assert.notEqual(context.__backgroundTest.buildBlockTranslationCacheKey("source", item, "model", "base", "g1-old"), context.__backgroundTest.buildBlockTranslationCacheKey("source", item, "model", "base", "g1-new"));
});
test("text translation prompt injects matching glossary entries", () => {
  const prompt = context.__backgroundTest.buildOpenAICompatibleTranslationPrompt([{
    id: "t0",
    original_text: "성현 공작이 왔다"
  }], {
    entries: [{
      source: "성현 공작",
      target: "成贤公爵",
      enabled: true
    }, {
      source: "마법사",
      target: "魔法师",
      enabled: true
    }]
  });
  assert.match(prompt, /Mandatory terminology glossary/);
  assert.match(prompt, /成贤公爵/);
  assert.doesNotMatch(prompt, /魔法师/);
  assert.deepEqual(Array.from(context.__backgroundTest.ocrProviders.ids()), ["baidu", "local_paddle"]);
  assert.deepEqual(Array.from(context.__backgroundTest.translationProviders.ids()), ["openai_compatible"]);
});
test("stitched OCR drops a completed cluster owned by the adjacent slice", async () => {
  const payload = {
    imageWidth: 760,
    imageHeight: 900,
    items: [{
      text: "이웃 대사",
      score: 0.98,
      box: {
        left: 260,
        top: 120,
        width: 180,
        height: 40
      },
      region_id: "region-neighbor",
      region_type: "speech_bubble",
      region_polygon: [[220, 80], [480, 80], [480, 200], [220, 200]],
      region_box: {
        left: 220,
        top: 80,
        width: 260,
        height: 120
      },
      bg_color: "#ffffff"
    }]
  };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(payload, {
    width: 760,
    height: 900
  }, "", true, null, undefined, null, {
    stitch: {
      ownerTop: 300,
      ownerHeight: 300
    }
  });

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
    items: [{
      ...base,
      text: "첫 번째 대사",
      box: {
        left: 120,
        top: 340,
        width: 180,
        height: 42
      },
      region_id: "region-left",
      region_polygon: [[80, 300], [330, 300], [330, 430], [80, 430]],
      region_box: {
        left: 80,
        top: 300,
        width: 250,
        height: 130
      }
    }, {
      ...base,
      text: "두 번째 대사",
      box: {
        left: 390,
        top: 345,
        width: 180,
        height: 42
      },
      region_id: "region-right",
      region_polygon: [[350, 300], [620, 300], [620, 430], [350, 430]],
      region_box: {
        left: 350,
        top: 300,
        width: 270,
        height: 130
      }
    }]
  };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(payload, {
    width: 760,
    height: 900
  }, "", true, null, undefined, null, {
    stitch: {
      ownerTop: 300,
      ownerHeight: 300
    }
  });
  assert.equal(result.length, 2);
  assert.deepEqual(Array.from(result, item => item.localOcrContainerId).sort(), ["region-left", "region-right"]);
});
test("solid regions use a bounded local paint box while outline text keeps the OCR box", () => {
  const normalize = context.__backgroundTest.normalizeBaiduOcrItem;
  const solid = normalize({
    words: "??",
    location: {
      left: 200,
      top: 100,
      width: 100,
      height: 40
    },
    regionBox: {
      left: 80,
      top: 60,
      width: 300,
      height: 200
    },
    adaptiveBackground: {
      type: "solid",
      color: "#f8f8f8",
      confidence: 0.9
    },
    regionPolygon: [[80, 60], [380, 60], [380, 260], [80, 260]],
    polygon: [[200, 100], [300, 100], [300, 140], [200, 140]],
    rotation_deg: 12
  }, 0, {
    width: 500,
    height: 400
  });
  assert.equal(solid.bg_type, "solid");
  assert.equal(solid.x, 40);
  assert.equal(solid.y, 25);
  assert.equal(solid.w, 20);
  assert.equal(solid.h, 10);
  assert.equal(JSON.stringify(solid.polygon), JSON.stringify([{
    x: 40,
    y: 25
  }, {
    x: 60,
    y: 25
  }, {
    x: 60,
    y: 35
  }, {
    x: 40,
    y: 35
  }]));
  assert.equal(solid.rotation_deg, 12);
  assert.deepEqual({
    ...solid.rawBox
  }, {
    left: 200,
    top: 100,
    width: 100,
    height: 40
  });
  assert.deepEqual({
    ...solid.fill_box
  }, {
    x: 38,
    y: 23.5,
    w: 24,
    h: 13
  });
  assert.ok(solid.fill_box.w / 100 * 500 * (solid.fill_box.h / 100 * 400) <= solid.rawBox.width * solid.rawBox.height * 2);
  assert.equal(JSON.stringify(solid.region_polygon), JSON.stringify([{
    x: 16,
    y: 15
  }, {
    x: 76,
    y: 15
  }, {
    x: 76,
    y: 65
  }, {
    x: 16,
    y: 65
  }]));
  const outline = normalize({
    words: "??",
    location: {
      left: 200,
      top: 100,
      width: 100,
      height: 40
    },
    regionBox: {
      left: 80,
      top: 60,
      width: 300,
      height: 200
    },
    adaptiveBackground: {
      type: "outline",
      color: "",
      confidence: 0
    },
    textColor: "#000000",
    strokeColor: "#ffffff"
  }, 1, {
    width: 500,
    height: 400
  });
  assert.equal(outline.bg_type, "none");
  assert.ok(Math.abs(outline.x - 39.8) < 1e-9);
  assert.ok(Math.abs(outline.w - 20.4) < 1e-9);
  assert.equal(outline.text_color, "#000000");
  assert.equal(outline.stroke_color, "#ffffff");
});
test("oversized solid paint boxes downgrade to transparent outline", () => {
  const paintBox = context.__backgroundTest.buildLocalSolidPaintBox({
    left: 200,
    top: 100,
    right: 300,
    bottom: 140,
    width: 100,
    height: 40
  }, {
    left: 0,
    top: 0,
    width: 500,
    height: 400
  }, {
    width: 500,
    height: 400
  });
  assert.ok(paintBox);
  assert.ok(paintBox.width * paintBox.height <= 100 * 40 * 2);
});
test("same-line OCR fragments merge their solid paint boxes", () => {
  const merged = context.__backgroundTest.mergeOcrCandidateGroup([{
    x: 10,
    y: 20,
    w: 20,
    h: 10,
    fill_box: {
      x: 8,
      y: 18.5,
      w: 24,
      h: 13
    },
    bg_type: "solid",
    bg_color: "#512014",
    region_id: "region-line",
    original_text: "옛날",
    rawBox: {
      left: 100,
      top: 80,
      width: 200,
      height: 40
    }
  }, {
    x: 35,
    y: 20,
    w: 25,
    h: 10,
    fill_box: {
      x: 32.5,
      y: 18.5,
      w: 30,
      h: 13
    },
    bg_type: "solid",
    bg_color: "#512014",
    region_id: "region-line",
    original_text: "미국 토크쇼",
    rawBox: {
      left: 350,
      top: 80,
      width: 250,
      height: 40
    }
  }], 0);
  assert.equal(merged.bg_type, "solid");
  assert.deepEqual({
    ...merged.fill_box
  }, {
    x: 8,
    y: 18.5,
    w: 54.5,
    h: 13
  });
  assert.ok(merged.fill_box.w * merged.fill_box.h <= merged.w * merged.h * 2);
});
