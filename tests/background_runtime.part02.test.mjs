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
test("stitched OCR clusters all panel lines before owner filtering", async () => {
  const region = {
    region_id: "region-1",
    region_type: "caption_panel",
    region_polygon: [[100, 220], [500, 220], [500, 380], [100, 380]],
    region_box: {
      left: 100,
      top: 220,
      width: 400,
      height: 160
    },
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
    items: [{
      ...region,
      text: "오오",
      box: {
        left: 300,
        top: 270,
        width: 120,
        height: 36
      }
    }, {
      ...region,
      text: "이번 회",
      box: {
        left: 285,
        top: 312,
        width: 150,
        height: 36
      }
    }, {
      ...region,
      text: "참가 신청자들!",
      box: {
        left: 240,
        top: 354,
        width: 240,
        height: 36
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
    region_polygon: [[box.left, box.top], [box.left + box.width, box.top], [box.left + box.width, box.top + box.height], [box.left, box.top + box.height]],
    bg_color: "#000000",
    text_color: "#fcfcfc",
    stroke_color: "#000000",
    region_confidence: 0.94
  });
  const upperLeft = region("upper-left", {
    left: 27,
    top: 278,
    width: 260,
    height: 180
  });
  const upperRight = region("upper-right", {
    left: 298,
    top: 281,
    width: 463,
    height: 266
  });
  const lower = region("lower", {
    left: 568,
    top: 601,
    width: 189,
    height: 116
  });
  const item = (text, left, top, width, height, extra = {}) => ({
    text,
    box: {
      left,
      top,
      width,
      height
    },
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0,
    ...extra
  });
  const payload = {
    imageWidth: 760,
    imageHeight: 1380,
    items: [item("middle", 249, 336, 115, 62), item("upper left", 76, 338, 163, 59, upperLeft), item("upper right", 383, 339, 260, 56, upperRight), item("second middle", 298, 433, 137, 59), item("second left", 79, 434, 209, 56), item("second right", 456, 434, 221, 56, upperRight), item("third left", 77, 530, 306, 56), item("third right", 368, 530, 105, 58), item("lower heading", 603, 640, 118, 38, lower), item("lower line one", 298, 696, 420, 37), item("lower line two", 435, 753, 283, 33), item("lower line three", 263, 806, 455, 38), item("lower last right", 524, 861, 193, 37), item("lower last left", 337, 864, 184, 33)]
  };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(payload, {
    width: 760,
    height: 1380
  }, "", false);
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
test("a nested false speech region cannot split one caption sentence", async () => {
  const region = (id, type, box, color) => ({
    region_id: id,
    region_type: type,
    region_box: box,
    region_polygon: [[box.left, box.top], [box.left + box.width, box.top], [box.left + box.width, box.top + box.height], [box.left, box.top + box.height]],
    bg_color: color,
    text_color: "#6c3c24",
    stroke_color: "#ffffff",
    region_confidence: 0.94,
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0
  });
  const panel = region("caption-parent", "caption_panel", {
    left: 354.61,
    top: 848.16,
    width: 215.66,
    height: 179.47
  }, "#fef9f0");
  const nestedFalseBubble = region("nested-false-bubble", "speech_bubble", {
    left: 492.11,
    top: 903.16,
    width: 83.95,
    height: 70.92
  }, "#fef8f4");
  const payload = {
    imageWidth: 720,
    imageHeight: 1100,
    items: [{
      ...panel,
      text: "그런",
      box: {
        left: 439,
        top: 864,
        width: 64,
        height: 41
      }
    }, {
      ...panel,
      text: "의미에서",
      box: {
        left: 377,
        top: 919,
        width: 121,
        height: 40
      }
    }, {
      ...nestedFalseBubble,
      text: "고른",
      box: {
        left: 502,
        top: 919,
        width: 64,
        height: 40
      }
    }, {
      ...panel,
      text: "이름이에요.",
      box: {
        left: 391,
        top: 973,
        width: 157,
        height: 40
      }
    }]
  };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems(payload, {
    width: 720,
    height: 1100
  }, "", false);
  assert.equal(result.length, 1);
  assert.match(result[0].words, /의미에서 고른/);
  assert.equal(result[0].sourceLineCount, 3);
});
test("adjacent independent caption and speech regions remain separate", async () => {
  const item = (text, id, type, regionBox, box) => ({
    text,
    box,
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0,
    region_id: id,
    region_type: type,
    region_box: regionBox,
    region_polygon: [[regionBox.left, regionBox.top], [regionBox.left + regionBox.width, regionBox.top], [regionBox.left + regionBox.width, regionBox.top + regionBox.height], [regionBox.left, regionBox.top + regionBox.height]],
    bg_color: "#fffaf2",
    region_confidence: 0.96
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 720,
    imageHeight: 1100,
    items: [item("왼쪽 문장", "left-caption", "caption_panel", {
      left: 80,
      top: 300,
      width: 220,
      height: 120
    }, {
      left: 120,
      top: 340,
      width: 150,
      height: 40
    }), item("오른쪽 문장", "right-speech", "speech_bubble", {
      left: 310,
      top: 300,
      width: 220,
      height: 120
    }, {
      left: 274,
      top: 340,
      width: 150,
      height: 40
    })]
  }, {
    width: 720,
    height: 1100
  }, "", false);
  assert.equal(result.length, 2);
});
test("global OCR line dedupe keeps the strongest overlapping recognition", () => {
  const debug = {};
  const result = context.__backgroundTest.clusterLocalPaddleWords([{
    words: "같은 문장입니다",
    confidence: 0.96,
    location: {
      left: 100,
      top: 80,
      width: 220,
      height: 40
    }
  }, {
    words: "같은문장입니다",
    confidence: 0.72,
    location: {
      left: 103,
      top: 81,
      width: 216,
      height: 39
    }
  }], {
    width: 760,
    height: 900
  }, null, debug);
  assert.equal(result.length, 1);
  assert.equal(debug.dedupedItems.length, 1);
  assert.equal(debug.duplicateItems.length, 1);
  assert.equal(result[0].confidence, 0.96);
});
test("enabled local OCR debug keeps its boolean flag separate from the writable debug session", async () => {
  const imageSize = { width: 720, height: 1100 };
  const tuning = context.__backgroundTest.getDefaultOcrTuning();
  const debugSession = context.__backgroundTest.createOcrDebugSession(
    "local_paddle",
    imageSize,
    tuning
  );
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    items: [{
      text: "\ud14c\uc2a4\ud2b8",
      score: 0.98,
      det_score: 0.96,
      box: { left: 100, top: 120, width: 180, height: 42 }
    }]
  }, imageSize, "", true, null, tuning, debugSession);
  assert.equal(result.length, 1);
  assert.equal(debugSession.dedupedItems.length, 1);
  assert.equal(debugSession.lineItems.length, 1);
});
test("same-line merge accepts emphasis colors but rejects a title-sized fragment", () => {
  const box = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
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
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleSameLine({
    ...base,
    kind: "effectText",
    color: {
      redScore: 0.8
    }
  }, {
    ...base,
    text: "문장",
    kind: "normalOutsideText",
    color: {
      redScore: 0
    },
    box: box(230, 102, 100, 38)
  }), true);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleSameLine(base, {
    ...base,
    text: "작은 본문",
    box: box(230, 112, 100, 20)
  }), false);
});
test("chat-style metadata and body keep separate visual/font candidates", async () => {
  const item = (text, left, top, width, height) => ({
    text,
    box: {
      left,
      top,
      width,
      height
    },
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 760,
    imageHeight: 900,
    items: [item("사용자", 100, 100, 110, 20), item("오후 5:14", 225, 100, 90, 18), item("아 밥에 미친 서호윤", 100, 128, 300, 43)]
  }, {
    width: 760,
    height: 900
  }, "", false);
  assert.equal(result.length, 3);
  const nickname = result.find(row => row.translation_role === "chat_nickname");
  const time = result.find(row => row.translation_role === "chat_time");
  const body = result.find(row => row.translation_role === "chat_body");
  assert.ok(nickname);
  assert.ok(time);
  assert.ok(body);
  assert.equal(nickname.nonTranslate, false);
  assert.equal(time.nonTranslate, false);
  assert.equal(body.nonTranslate, false);
  assert.equal(nickname.alignment, "left");
  assert.equal(time.alignment, "left");
  assert.equal(body.alignment, "left");
  assert.equal(Number(time.fontWeight), 400);
  assert.equal(Number(nickname.fontWeight), 600);
  assert.equal(Number(body.fontWeight), 700);
  assert.ok(Number(time.fontHeight) < Number(body.fontHeight));
});
test("chat nickname and timestamp in one OCR box split into separate translatable roles", async () => {
  const item = (text, left, top, width, height) => ({
    text,
    box: {
      left,
      top,
      width,
      height
    },
    score: 0.98,
    det_score: 0.95,
    rotation_deg: 0
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 760,
    imageHeight: 900,
    items: [item("hoyami \uC624\uD6C4 5:15", 90, 100, 190, 20), item("\uC9C4\uC815\uD55C \uBC25 \uAD11\uC778", 90, 128, 260, 42)]
  }, {
    width: 760,
    height: 900
  }, "", false);
  assert.equal(result.length, 3);
  assert.deepEqual(Array.from(result, row => row.translation_role).sort(), ["chat_body", "chat_nickname", "chat_time"]);
  assert.equal(result.some(row => row.nonTranslate === true), false);
  assert.equal(result.every(row => row.alignment === "left"), true);
});
test("OCR polygon supplies a fallback tilt angle when the provider omits rotation", () => {
  const result = context.__backgroundTest.clusterLocalPaddleWords([{
    words: "기울어진 글자",
    confidence: 0.98,
    location: {
      left: 100,
      top: 100,
      width: 220,
      height: 40
    },
    polygon: [{
      x: 100,
      y: 100
    }, {
      x: 316,
      y: 138
    }, {
      x: 310,
      y: 178
    }, {
      x: 94,
      y: 140
    }]
  }], {
    width: 760,
    height: 900
  }, null, null);
  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].rotation_deg - 10) < 0.5);
});
test("paragraph merge rejects large whitespace, title/body scale, remote columns, and Chinese overlays", () => {
  const box = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    centerX: left + width / 2,
    centerY: top + height / 2
  });
  const entry = text => ({
    text,
    container: null
  });
  const line = (text, left, top, width, height) => ({
    text,
    rotation: 0,
    box: box(left, top, width, height),
    entries: [entry(text)]
  });
  const first = line("첫 번째 줄", 100, 100, 300, 40);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("두 번째 줄", 110, 148, 285, 42)), true);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("먼 줄", 110, 210, 285, 42)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("작은 본문", 110, 148, 285, 20)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("오른쪽 글", 500, 148, 220, 40)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, line("中文覆盖层", 110, 148, 285, 40)), false);
  assert.equal(context.__backgroundTest.shouldMergeLocalPaddleParagraphLines(first, {
    ...line("가운데 기울임", 165, 148, 170, 55),
    rotation: -7
  }), true);
});
test("short Hangul utterances inside reliable speech bubbles survive every OCR filter", async () => {
  const cases = [{
    name: "single-syllable reply",
    // 短页作为相邻页拼入高画布后，文字框本身不变，但面积占比会显著下降。
    imageSize: {
      width: 864,
      height: 1616
    },
    text: "…!네!",
    score: 0.7288035750389099,
    box: {
      left: 608,
      top: 9,
      width: 115,
      height: 65
    },
    regionBox: {
      left: 574.11,
      top: 0,
      width: 181.89,
      height: 140.97
    },
    regionConfidence: 0.9921
  }, {
    name: "single-syllable hesitation",
    imageSize: {
      width: 760,
      height: 1350
    },
    text: "음.",
    score: 0.8876966834068298,
    box: {
      left: 288,
      top: 1246,
      width: 46,
      height: 46
    },
    regionBox: {
      left: 273.55,
      top: 1199.01,
      width: 76.38,
      height: 140.33
    },
    regionConfidence: 0.9981
  }, {
    name: "two-syllable reply",
    imageSize: {
      width: 760,
      height: 1350
    },
    text: "나도.",
    score: 0.8707183003425598,
    box: {
      left: 514,
      top: 70,
      width: 71,
      height: 44
    },
    regionBox: {
      left: 492.04,
      top: 24.87,
      width: 115.46,
      height: 135
    },
    regionConfidence: 0.9607
  }];
  for (const item of cases) {
    const region = {
      region_id: "speech-region",
      region_type: "speech_bubble",
      region_box: item.regionBox,
      region_polygon: [[item.regionBox.left, item.regionBox.top], [item.regionBox.left + item.regionBox.width, item.regionBox.top], [item.regionBox.left + item.regionBox.width, item.regionBox.top + item.regionBox.height], [item.regionBox.left, item.regionBox.top + item.regionBox.height]],
      bg_color: "#ffffff",
      region_confidence: item.regionConfidence
    };
    const merged = await context.__backgroundTest.buildLocalPaddleBubbleItems({
      imageWidth: item.imageSize.width,
      imageHeight: item.imageSize.height,
      items: [{
        ...region,
        text: item.text,
        score: item.score,
        box: item.box
      }]
    }, item.imageSize, "", false);
    assert.equal(merged.length, 1, `${item.name}: cluster stage`);
    const candidate = context.__backgroundTest.normalizeBaiduOcrItem(merged[0], 0, item.imageSize);
    assert.equal(context.__backgroundTest.getFinalCandidateDropReason(candidate, item.imageSize, context.__backgroundTest.getDefaultOcrTuning(), "local_paddle"), "", `${item.name}: final stage`);
  }
});
test("mojibake or weak tiny OCR fragments remain filtered as noise", async () => {
  const imageSize = {
    width: 760,
    height: 1350
  };
  const meaningful = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    items: [{
      text: "음.",
      score: 0.8876966834068298,
      box: {
        left: 288,
        top: 1246,
        width: 46,
        height: 46
      }
    }]
  }, imageSize, "", false);
  assert.equal(meaningful.length, 1, "legal short Hangul should survive without a speech-bubble region");
  const cases = [{
    name: "mojibake short fragment",
    text: "\u979a?"
  }, {
    name: "isolated jamo",
    text: "ㄱ"
  }, {
    name: "caption panel",
    text: "\u979a?",
    region_id: "caption-region",
    region_type: "caption_panel",
    region_confidence: 0.9981
  }, {
    name: "weak speech-bubble region",
    text: "\u979a?",
    region_id: "weak-region",
    region_type: "speech_bubble",
    region_confidence: 0.7
  }, {
    name: "weak OCR",
    text: "음.",
    region_id: "speech-region",
    region_type: "speech_bubble",
    region_confidence: 0.9981,
    score: 0.35
  }];
  for (const item of cases) {
    const merged = await context.__backgroundTest.buildLocalPaddleBubbleItems({
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
      items: [{
        text: item.text,
        score: item.score ?? 0.8876966834068298,
        box: {
          left: 288,
          top: 1246,
          width: 46,
          height: 46
        },
        ...item
      }]
    }, imageSize, "", false);
    assert.equal(merged.length, 0, item.name);
  }
});
