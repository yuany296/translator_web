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
test("a forced cleaned-image OCR request does not reuse a plain in-flight request", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  let markFirstStarted;
  let releaseRequests;
  const firstStarted = new Promise(resolve => {
    markFirstStarted = resolve;
  });
  const requestGate = new Promise(resolve => {
    releaseRequests = resolve;
  });
  const artifactFlags = [];
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({
      request,
      settings
    }) => {
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
        edgeSignals: {
          hasAny: false
        },
        ...(request.requireCleanedImage ? {
          cleanedImage: "data:image/png;base64,Q0xFQU4="
        } : {})
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
  await new Promise(resolve => setImmediate(resolve));
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
  installMemoryStorage(separatedConfiguration());
  let releaseRequests;
  const requestGate = new Promise(resolve => {
    releaseRequests = resolve;
  });
  const receivedMasks = [];
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({
      request,
      settings
    }) => {
      receivedMasks.push(request.cleanedMasks);
      await requestGate;
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: {
          hasAny: false
        },
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
  const firstMasks = [{
    coordinateSpace: "percent",
    box: {
      x: 20,
      y: 90,
      w: 40,
      h: 10
    }
  }];
  const secondMasks = [{
    coordinateSpace: "percent",
    box: {
      x: 20,
      y: 85,
      w: 40,
      h: 15
    }
  }];
  const first = background.handleOcrDataUrl({
    ...base,
    cleanedMasks: firstMasks
  });
  const second = background.handleOcrDataUrl({
    ...base,
    cleanedMasks: secondMasks
  });
  await new Promise(resolve => setImmediate(resolve));
  releaseRequests();
  const results = await Promise.all([first, second]);
  background.setBackgroundTestHooks(null);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(receivedMasks.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(receivedMasks)).map(masks => JSON.stringify(masks)).sort(), [firstMasks, secondMasks].map(masks => JSON.stringify(masks)).sort());
});
test("equivalent cleaned masks share one artifact request after normalization", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  let providerCalls = 0;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => {
    markFirstStarted = resolve;
  });
  let releaseRequest;
  const requestGate = new Promise(resolve => {
    releaseRequest = resolve;
  });
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({
      request,
      settings
    }) => {
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
        edgeSignals: {
          hasAny: false
        },
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
  const firstMasks = [{
    coordinateSpace: "percent",
    box: {
      x: 40,
      y: 90,
      w: 20,
      h: 10
    }
  }, {
    coordinateSpace: "percent",
    box: {
      x: 20,
      y: 85,
      w: 50,
      h: 15
    }
  }];
  const equivalentMasks = [{
    coordinate_space: "percent",
    box: {
      left: 20,
      top: 85,
      width: 50,
      height: 15
    }
  }, {
    coordinateSpace: "percent",
    box: {
      x: 40.00001,
      y: 90,
      w: 19.99999,
      h: 10
    }
  }, firstMasks[0]];
  assert.deepEqual(JSON.parse(JSON.stringify(background.normalizeCleanedMasks(firstMasks))), JSON.parse(JSON.stringify(background.normalizeCleanedMasks(equivalentMasks))));
  assert.equal(background.buildCleanedMasksFingerprint(firstMasks), background.buildCleanedMasksFingerprint(equivalentMasks));
  const first = background.handleOcrDataUrl({
    ...base,
    cleanedMasks: firstMasks
  });
  await firstStarted;
  await new Promise(resolve => setImmediate(resolve));
  const second = background.handleOcrDataUrl({
    ...base,
    cleanedMasks: equivalentMasks
  });
  // 两次调用都要先完成异步 SHA-256/storage 读取，再进入 inflight map；
  // 保持首个 provider 请求挂起，给第二次调用足够时间加入同一 promise。
  await new Promise(resolve => setTimeout(resolve, 30));
  releaseRequest();
  const results = await Promise.all([first, second]);
  background.setBackgroundTestHooks(null);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(providerCalls, 1);
});
test("multi-line brown lettering does not inherit an anomalous black first-line color", async () => {
  const region = {
    region_id: "brown-panel",
    region_type: "caption_panel",
    region_box: {
      left: 80,
      top: 80,
      width: 420,
      height: 260
    },
    region_polygon: [[80, 80], [500, 80], [500, 340], [80, 340]],
    bg_color: "#fff8ef",
    region_confidence: 0.97,
    score: 0.98
  };
  const row = (text, top, textColor) => ({
    ...region,
    text,
    text_color: textColor,
    stroke_color: "#ffffff",
    box: {
      left: 150,
      top,
      width: 260,
      height: 46
    }
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 600,
    imageHeight: 500,
    items: [row("그런", 120, "#000000"), row("의미에서", 170, "#845424"), row("고른", 220, "#84543c"), row("이름이에요", 270, "#6c3c24")]
  }, {
    width: 600,
    height: 500
  }, "", false);
  assert.equal(result.length, 1);
  assert.notEqual(result[0].textColor, "#000000");
  assert.match(result[0].textColor, /^#(?:6c3c24|845424|84543c)$/i);
});
test("conflicting lower-confidence OCR read is removed but a real adjacent row remains", () => {
  const result = context.__backgroundTest.clusterLocalPaddleWords([{
    words: "맛있는",
    confidence: 0.999,
    region_id: "same",
    location: {
      left: 388,
      top: 343,
      width: 94,
      height: 32
    }
  }, {
    words: "벗었는",
    confidence: 0.820,
    region_id: "same",
    location: {
      left: 392,
      top: 363,
      width: 86,
      height: 22
    }
  }, {
    words: "치킨타임",
    confidence: 0.95,
    region_id: "same",
    location: {
      left: 390,
      top: 410,
      width: 120,
      height: 30
    }
  }], {
    width: 760,
    height: 900
  }, null, null);
  const text = result.map(item => item.words).join("\n");
  assert.match(text, /맛있는/);
  assert.doesNotMatch(text, /벗었는/);
  assert.match(text, /치킨타임/);
});
test("isolated Latin marks stay in raw debug data but never become a translated overlay", async () => {
  const ocrDebug = {};
  const payloadItems = [{
    text: "치킨은",
    score: 0.99,
    box: {
      left: 300,
      top: 520,
      width: 160,
      height: 48
    }
  }, {
    text: "먹어도 되나요?",
    score: 0.99,
    box: {
      left: 250,
      top: 575,
      width: 260,
      height: 52
    }
  }, {
    text: "TOTN",
    score: 0.98,
    box: {
      left: 310,
      top: 690,
      width: 150,
      height: 70
    }
  }];
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 760,
    imageHeight: 900,
    items: payloadItems,
    rawItems: payloadItems
  }, {
    width: 760,
    height: 900
  }, "", false, null, undefined, ocrDebug);
  assert.equal(ocrDebug.rawItems.some(item => item.text === "TOTN"), true);
  assert.equal(result.some(item => /TOTN/.test(item.words)), false);
  assert.equal(result.some(item => /치킨은/.test(item.words)), true);
});
test("Korean relative time splits nickname, time and body without overlapping roles", async () => {
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 760,
    imageHeight: 900,
    items: [{
      text: "hoyami 3분 전",
      score: 0.98,
      box: {
        left: 90,
        top: 100,
        width: 210,
        height: 22
      }
    }, {
      text: "오늘도 기다릴게",
      score: 0.98,
      box: {
        left: 90,
        top: 132,
        width: 280,
        height: 44
      }
    }]
  }, {
    width: 760,
    height: 900
  }, "", false);
  assert.deepEqual(Array.from(result, row => row.translation_role).sort(), ["chat_body", "chat_nickname", "chat_time"]);
  const boxes = result.map(row => row.location);
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const overlapX = Math.max(0, Math.min(boxes[left].left + boxes[left].width, boxes[right].left + boxes[right].width) - Math.max(boxes[left].left, boxes[right].left));
      const overlapY = Math.max(0, Math.min(boxes[left].top + boxes[left].height, boxes[right].top + boxes[right].height) - Math.max(boxes[left].top, boxes[right].top));
      assert.equal(overlapX * overlapY, 0);
    }
  }
});
test("slanted chat rows share one reliable angle and size from polygon thickness", async () => {
  const slanted = (text, box, polygon, rotation) => ({
    text,
    score: 0.98,
    box,
    polygon,
    rotation_deg: rotation
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 1000,
    imageHeight: 1100,
    items: [slanted("milkyway 오후 7:14", {
      left: 72,
      top: 90,
      width: 300,
      height: 101
    }, [[72, 150], [360, 82], [372, 123], [84, 191]], -13.1), slanted("오늘 라이브 진짜 재밌었어요", {
      left: 280,
      top: 115,
      width: 528,
      height: 170
    }, [[280, 230], [790, 104], [808, 159], [298, 285]], -13.9)]
  }, {
    width: 1000,
    height: 1100
  }, "", false);
  assert.ok(result.length >= 2);
  assert.equal(new Set(result.map(row => row.rotation_deg.toFixed(1))).size, 1, JSON.stringify(result.map(row => ({ text: row.words, rotation: row.rotation_deg, role: row.translation_role }))));
  assert.equal(result.every(row => Math.abs(row.rotation_deg) <= 25), true);
  assert.equal(result.every(row => row.fontHeight < 65), true, JSON.stringify(result.map(row => row.fontHeight)));
  assert.equal(result.every(row => row.location.height < 90), true, JSON.stringify(result.map(row => row.location)));
});
test("chat clusters preserve reliable rotations beyond 25 degrees", () => {
  const cluster = [{
    rotation: -30,
    box: {
      left: 100,
      top: 100,
      right: 300,
      bottom: 160,
      width: 200,
      height: 60,
      centerX: 200,
      centerY: 130
    }
  }];
  assert.equal(context.__backgroundTest.getReliableSharedClusterRotation(cluster, "chat"), -30);
});
test("strongly slanted equal-size rows group by their text axes instead of AABB height", async () => {
  const angle = -14 * Math.PI / 180;
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -axis.y, y: axis.x };
  const row = (text, line, length) => {
    const start = { x: 100 + normal.x * line * 58, y: 160 + normal.y * line * 58 };
    const end = { x: start.x + axis.x * length, y: start.y + axis.y * length };
    const polygon = [start, end, { x: end.x + normal.x * 40, y: end.y + normal.y * 40 }, { x: start.x + normal.x * 40, y: start.y + normal.y * 40 }];
    const left = Math.min(...polygon.map(point => point.x));
    const top = Math.min(...polygon.map(point => point.y));
    const right = Math.max(...polygon.map(point => point.x));
    const bottom = Math.max(...polygon.map(point => point.y));
    return {
      text,
      score: 0.98,
      rotation_deg: -14,
      polygon: polygon.map(point => [point.x, point.y]),
      box: { left, top, width: right - left, height: bottom - top }
    };
  };
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 1000,
    imageHeight: 900,
    items: [row("첫 번째 긴 문장입니다", 0, 620), row("두 번째 줄", 1, 280), row("세 번째 문장도 이어집니다", 2, 540)]
  }, { width: 1000, height: 900 }, "", false);
  assert.equal(result.length, 1, JSON.stringify(result.map(item => item.words)));
  assert.equal(result[0].sourceLineCount, 3);
  assert.equal(result[0].words, "첫 번째 긴 문장입니다\n두 번째 줄\n세 번째 문장도 이어집니다");
  assert.ok(Math.abs(result[0].rotation_deg + 14) < 0.1);
});
test("comment footer glyphs cannot enlarge or contaminate a body cluster", async () => {
  const panel = {
    region_id: "large-white-card",
    region_type: "speech_bubble",
    region_box: { left: 69, top: 17, width: 850, height: 501 },
    region_polygon: [[69, 17], [919, 17], [919, 518], [69, 518]],
    region_confidence: 0.956,
    bg_color: "#ffffff"
  };
  const item = (text, left, top, width, height, score = 0.98, overrides = {}) => ({
    ...panel,
    text,
    score,
    box: { left, top, width, height },
    polygon: [[left, top], [left + width, top], [left + width, top + height], [left, top + height]],
    ...overrides
  });
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 919,
    imageHeight: 568,
    items: [
      item("벌써 3시간이 넘어가고 있다", 245, 170, 560, 56),
      item("치킨은 시킨거니", 247, 239, 321, 53),
      item("애들 왜 이렇게 팬사랑이 넘쳐", 244, 306, 588, 56),
      item("그", 507, 416, 43, 44, 0.672),
      item("1", 841, 435, 17, 26, 0.952, {
        region_id: "footer-count",
        region_type: "caption_panel",
        region_box: { left: 834, top: 408, width: 31, height: 81 },
        region_polygon: [[834, 408], [865, 408], [865, 489], [834, 489]]
      })
    ]
  }, { width: 919, height: 568 }, "", false);
  assert.equal(result.length, 1, JSON.stringify(result.map(row => row.words)));
  assert.equal(result[0].words, "벌써 3시간이 넘어가고 있다\n치킨은 시킨거니\n애들 왜 이렇게 팬사랑이 넘쳐");
  assert.ok(result[0].location.top + result[0].location.height < 400, JSON.stringify(result[0].location));
});
test("reliable solid speech regions keep cleanup on the final blue text box", async () => {
  const result = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    imageWidth: 500,
    imageHeight: 500,
    items: [{
      text: "엥잠만",
      score: 0.99,
      region_id: "panel",
      region_type: "speech_bubble",
      region_box: {
        left: 40,
        top: 300,
        width: 200,
        height: 100
      },
      region_polygon: [[40, 300], [240, 300], [240, 400], [40, 400]],
      region_confidence: 0.96,
      bg_color: "#ffffff",
      box: {
        left: 80,
        top: 320,
        width: 120,
        height: 34
      },
      polygon: [[80, 320], [200, 320], [200, 354], [80, 354]]
    }]
  }, {
    width: 500,
    height: 500
  }, "", false);
  const candidate = context.__backgroundTest.normalizeBaiduOcrItem(result[0], 0, {
    width: 500,
    height: 500
  });
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.fill_box)), {
    x: candidate.x,
    y: candidate.y,
    w: candidate.w,
    h: candidate.h
  });
  assert.ok(candidate.fill_box.w < 40 && candidate.fill_box.h < 20, JSON.stringify(candidate.fill_box));
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.polygon)), [{
    x: 16,
    y: 64
  }, {
    x: 40,
    y: 64
  }, {
    x: 40,
    y: 70.8
  }, {
    x: 16,
    y: 70.8
  }]);
});
