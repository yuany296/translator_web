import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const contentRoot = path.resolve(import.meta.dirname, "..", "extension", "src", "content");
const contentSource = [fs.readFileSync(path.join(contentRoot, "configure.js"), "utf8"), ...fs.readdirSync(path.join(contentRoot, "modules"), {
  withFileTypes: true
}).filter(entry => entry.isFile() && entry.name.endsWith(".js")).sort((a, b) => a.name.localeCompare(b.name)).map(entry => fs.readFileSync(path.join(contentRoot, "modules", entry.name), "utf8"))].join("\n");
globalThis.location = {
  hostname: "page.kakao.com",
  pathname: "/content/1",
  search: "?episode=7",
  href: "https://page.kakao.com/content/1?episode=7#page-2",
  origin: "https://page.kakao.com"
};
globalThis.window = {
  scrollX: 0,
  scrollY: 0,
  innerWidth: 1200,
  innerHeight: 800
};
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.getComputedStyle = element => element && element.__style || {
  overflowX: "visible",
  overflowY: "visible"
};
await import("../extension/src/content/index.js");
const runtime = globalThis.__MANGA_TRANSLATOR_V3__;
function makeStitchPayload(ownerTop, ownerHeight, compositeHeight, opts = {}) {
  const compositeWidth = opts.compositeWidth || 760;
  const ownerEntry = {
    source: "owner",
    targetKey: opts.targetKey || "test-owner",
    src: opts.src || "owner.jpg",
    drawRect: {
      x: 0,
      y: ownerTop,
      w: compositeWidth,
      h: ownerHeight
    },
    sourceCrop: {
      x: 0,
      y: 0,
      w: compositeWidth,
      h: ownerHeight
    },
    naturalWidth: compositeWidth,
    naturalHeight: ownerHeight
  };
  return {
    stitch: {
      canvasWidth: compositeWidth,
      canvasHeight: compositeHeight,
      owner: ownerEntry,
      previous: opts.previous || null,
      next: opts.next || null,
      segments: [opts.previous, ownerEntry, opts.next].filter(Boolean),
      sourceKeys: opts.sourceKeys || [],
      verified: true
    }
  };
}
test("canonical rendering forwards page OCR debug data to the overlay renderer", () => {
  const start = contentSource.indexOf("async function renderCanonicalProjections");
  const end = contentSource.indexOf("async function renderKakaoPipelineResult", start);
  const renderSource = contentSource.slice(start, end);
  assert.match(renderSource, /getPageMappedValue\(\s*input\.debugByPage,\s*pageId,\s*input\.debug\s*\|\|\s*input\.result\?\.debug\s*\|\|\s*null\s*\)/);
});
test("OCR debug remains renderable without translated bubbles", () => {
  assert.equal(runtime.__test.hasRenderableOcrDebug({
    bubbles: [],
    debug: {
      debugOverlayMode: "raw",
      rawItems: [{
        box: {
          left: 1,
          top: 2,
          width: 3,
          height: 4
        }
      }]
    }
  }), true);
  assert.equal(runtime.__test.hasRenderableOcrDebug({
    bubbles: [],
    debug: {
      debugOverlayMode: "final",
      rawItems: [{
        box: {
          left: 1,
          top: 2,
          width: 3,
          height: 4
        }
      }]
    }
  }), true);
  assert.equal(runtime.__test.hasRenderableOcrDebug({
    bubbles: [],
    debug: {}
  }), false);
  assert.equal(runtime.__test.hasRenderableOcrDebug({
    bubbles: []
  }), false);
});
test("OCR final debug mode compares raw and final boxes", () => {
  const debug = {
    debugOverlayMode: "final",
    rawItems: [{
      id: "raw-1"
    }],
    dedupedItems: [{
      id: "deduped-1"
    }],
    finalBubbles: [{
      id: "final-1"
    }]
  };
  assert.deepEqual(runtime.__test.getRenderableOcrDebugStages(debug).map(stage => stage.name), ["raw", "block"]);
  debug.debugOverlayMode = "raw";
  assert.deepEqual(runtime.__test.getRenderableOcrDebugStages(debug).map(stage => stage.name), ["raw"]);
});
test("OCR debug labels format normalized and provider confidence values", () => {
  assert.equal(runtime.__test.formatOcrDebugConfidence({
    confidence: 0.9274
  }), "OCR 92.7%");
  assert.equal(runtime.__test.formatOcrDebugConfidence({
    score: 84.25
  }), "OCR 84.3%");
  assert.equal(runtime.__test.formatOcrDebugConfidence({
    raw: {
      rec_score: "0.611"
    }
  }), "OCR 61.1%");
  assert.equal(runtime.__test.formatOcrDebugConfidence({
    confidence: 0
  }), "OCR 0.0%");
  assert.equal(runtime.__test.formatOcrDebugConfidence({
    confidence: 1,
    confidenceAverage: 0.94,
    confidenceMinimum: 0.869,
    confidenceCount: 3
  }), "OCR avg 94.0% min 86.9%");
  assert.equal(runtime.__test.formatOcrDebugConfidence({
    confidence: "unavailable"
  }), "");
});
test("visible canonical pages left pending are eligible for recovery requeue", () => {
  const targetKey = "direct|page";
  const scopedTargetKey = "direct|page|src:revision";
  assert.equal(runtime.__test.hasPendingTranslationMarkerState({
    dataset: {}
  }, targetKey, scopedTargetKey), true);
  assert.equal(runtime.__test.hasPendingTranslationMarkerState({
    dataset: {
      mtLastTranslatedKey: scopedTargetKey
    }
  }, targetKey, scopedTargetKey), false);
  assert.equal(runtime.__test.hasPendingTranslationMarkerState({
    dataset: {
      mtNoTextKey: scopedTargetKey
    }
  }, targetKey, scopedTargetKey), false);
  const recoveryStart = contentSource.indexOf("function recoverRenderedTargets()");
  const recoveryEnd = contentSource.indexOf("function syncOverlayPosition", recoveryStart);
  const recoverySource = contentSource.slice(recoveryStart, recoveryEnd);
  assert.match(recoverySource, /hasPendingTranslationMarkerState[\s\S]*queuePageAutoTranslate\(target\)/);
});
test("pending-page recovery waits for its cooldown after a failed cold request", () => {
  assert.equal(runtime.__test.isTranslationRecoveryDue({
    dataset: {}
  }, 10000), true);
  assert.equal(runtime.__test.isTranslationRecoveryDue({
    dataset: {
      mtRecoveryReqAt: "8000"
    }
  }, 12000), false);
  assert.equal(runtime.__test.isTranslationRecoveryDue({
    dataset: {
      mtRecoveryReqAt: "8000"
    }
  }, 13000), true);
});
test("Kakao page identity does not collide for equal-size inline or blob pages", async () => {
  const createTarget = (currentSrc, top) => {
    const target = new globalThis.HTMLImageElement();
    target.currentSrc = currentSrc;
    target.naturalWidth = 760;
    target.naturalHeight = 1200;
    target.width = 760;
    target.height = 1200;
    target.isConnected = true;
    target.getBoundingClientRect = () => ({
      top,
      width: 760,
      height: 1200
    });
    return target;
  };
  const inlineA = await runtime.__test.buildKakaoPageIdentity(createTarget("data:image/png;base64,AQID", 100), {
    dataUrl: "data:image/png;base64,AQID",
    imageUrl: "data:image/png;base64,AQID",
    width: 760,
    height: 1200
  });
  const inlineB = await runtime.__test.buildKakaoPageIdentity(createTarget("data:image/png;base64,AQIE", 1400), {
    dataUrl: "data:image/png;base64,AQIE",
    imageUrl: "data:image/png;base64,AQIE",
    width: 760,
    height: 1200
  });
  assert.notEqual(inlineA.pageId, inlineB.pageId);
  assert.match(inlineA.stableSource, /^inline:/);
  const blobA = await runtime.__test.buildKakaoPageIdentity(createTarget("blob:https://page.kakao.com/page-a", 2700), {
    dataUrl: "data:image/png;base64,AQIF",
    imageUrl: "blob:https://page.kakao.com/page-a#preview",
    width: 760,
    height: 1200
  });
  const blobB = await runtime.__test.buildKakaoPageIdentity(createTarget("blob:https://page.kakao.com/page-b", 4000), {
    dataUrl: "data:image/png;base64,AQIF",
    imageUrl: "blob:https://page.kakao.com/page-b",
    width: 760,
    height: 1200
  });
  assert.notEqual(blobA.pageId, blobB.pageId);
  assert.equal(blobA.stableSource, "blob:https://page.kakao.com/page-a");
});
test("Kakao same-URL image reload invalidates the old generation and produces a new revision", async () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {};
  target.currentSrc = "https://cdn.example.test/reload-in-place.jpg";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({
    top: 100,
    bottom: 1300,
    left: 0,
    right: 760,
    width: 760,
    height: 1200
  });
  const first = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIJ",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  const snapshot = runtime.__test.captureTargetSnapshot(target);
  const generation = runtime.__test.prepareKakaoTargetRevisionCheck(target, "test-reload");
  const second = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIK",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  assert.equal(generation, 1);
  assert.equal(runtime.__test.isTargetSnapshotStillValid(target, snapshot), false);
  assert.equal(first.pageId, second.pageId);
  assert.notEqual(first.imageRevision, second.imageRevision);
});
test("deferred Kakao identity hashing does not bind a DOM target before pipeline commit", async () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {};
  target.currentSrc = "https://cdn.example.test/deferred-bind.jpg";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({
    top: 100,
    bottom: 1300,
    left: 0,
    right: 760,
    width: 760,
    height: 1200
  });
  const payload = {
    dataUrl: "data:image/png;base64,AQIL",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  };
  const deferred = await runtime.__test.buildKakaoPageIdentity(target, payload, {
    deferBind: true
  });
  assert.equal(runtime.__test.getTargetForKakaoPageId(deferred.pageId), null);
  const committed = await runtime.__test.buildKakaoPageIdentity(target, payload);
  assert.equal(committed.pageId, deferred.pageId);
  assert.equal(runtime.__test.getTargetForKakaoPageId(committed.pageId), target);
});
test("Kakao DOM source reuse detaches the old handle and schedules standby refresh immediately", async () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {};
  target.currentSrc = "https://cdn.example.test/reused-old.jpg";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({
    top: 100,
    width: 760,
    height: 1200
  });
  const identity = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIH",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  runtime.__test.kakaoStore.registerPageHandle({
    ...identity,
    target
  });
  const scheduled = [];
  const detachedPageId = runtime.__test.detachKakaoTargetForSourceChange(target, (pageIds, reason) => scheduled.push({
    pageIds,
    reason
  }));
  assert.equal(detachedPageId, identity.pageId);
  assert.equal(runtime.__test.kakaoStore.getPageHandleForTarget(target), null);
  assert.equal(runtime.__test.kakaoStore.getPageHandle(identity.pageId).pageId, identity.pageId);
  assert.deepEqual(scheduled, [{
    pageIds: [identity.pageId],
    reason: "page-handle-source-changed"
  }]);
});
test("a connected Kakao image restores its canonical handle by unique source token", async () => {
  const target = new globalThis.HTMLImageElement();
  target.dataset = {};
  target.currentSrc = "https://cdn.example.test/restorable-handle.jpg";
  target.naturalWidth = 760;
  target.naturalHeight = 1200;
  target.width = 760;
  target.height = 1200;
  target.isConnected = true;
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({ top: 100, bottom: 1300, left: 0, right: 760, width: 760, height: 1200 });
  const identity = await runtime.__test.buildKakaoPageIdentity(target, {
    dataUrl: "data:image/png;base64,AQIR",
    imageUrl: target.currentSrc,
    width: 760,
    height: 1200
  });
  runtime.__test.kakaoStore.registerPageHandle({ ...identity, target });
  runtime.__test.detachKakaoTargetForSourceChange(target, () => {});
  runtime.__test.kakaoStore.registerPageHandle({ ...identity, target: null });
  assert.equal(runtime.__test.getTargetForKakaoPageId(identity.pageId), null);
  assert.equal(runtime.__test.restoreKnownKakaoPageHandle(target, () => {}), identity.pageId);
  assert.equal(runtime.__test.getTargetForKakaoPageId(identity.pageId), target);
});
test("Kakao rendering prefers the Store current handle over an older connected clone", async () => {
  const createClone = top => {
    const target = new globalThis.HTMLImageElement();
    target.dataset = {};
    target.currentSrc = "https://cdn.example.test/same-page-clone.jpg";
    target.naturalWidth = 760;
    target.naturalHeight = 1200;
    target.width = 760;
    target.height = 1200;
    target.isConnected = true;
    target.getAttribute = name => name === "src" ? target.currentSrc : "";
    target.getBoundingClientRect = () => ({
      top,
      bottom: top + 1200,
      left: 0,
      right: 760,
      width: 760,
      height: 1200
    });
    return target;
  };
  const oldClone = createClone(2400);
  const newClone = createClone(100);
  const payload = {
    dataUrl: "data:image/png;base64,AQII",
    imageUrl: oldClone.currentSrc,
    width: 760,
    height: 1200
  };
  const oldIdentity = await runtime.__test.buildKakaoPageIdentity(oldClone, payload);
  const newIdentity = await runtime.__test.buildKakaoPageIdentity(newClone, payload);
  assert.equal(oldIdentity.pageId, newIdentity.pageId);
  runtime.__test.kakaoStore.registerPageHandle({
    ...oldIdentity,
    target: oldClone
  });
  runtime.__test.kakaoStore.registerPageHandle({
    ...newIdentity,
    target: newClone
  });
  // Simulate the offscreen clone finishing its fetch/hash after the visible clone.
  runtime.__test.kakaoStore.registerPageHandle({
    ...oldIdentity,
    target: oldClone
  });
  assert.equal(runtime.__test.getTargetForKakaoPageId(oldIdentity.pageId), newClone);
  newClone.isConnected = false;
  assert.equal(runtime.__test.getTargetForKakaoPageId(oldIdentity.pageId), oldClone);
});
test("an older image revision clone cannot render the current page revision", async () => {
  const createClone = top => {
    const target = new globalThis.HTMLImageElement();
    target.dataset = {};
    target.currentSrc = "https://cdn.example.test/revision-clone.jpg";
    target.naturalWidth = 760;
    target.naturalHeight = 1200;
    target.width = 760;
    target.height = 1200;
    target.isConnected = true;
    target.getAttribute = name => name === "src" ? target.currentSrc : "";
    target.getBoundingClientRect = () => ({
      top,
      bottom: top + 1200,
      left: 0,
      right: 760,
      width: 760,
      height: 1200
    });
    return target;
  };
  const oldClone = createClone(100);
  const newClone = createClone(2600);
  const oldIdentity = await runtime.__test.buildKakaoPageIdentity(oldClone, {
    dataUrl: "data:image/png;base64,AQIM",
    imageUrl: oldClone.currentSrc,
    width: 760,
    height: 1200
  });
  const newIdentity = await runtime.__test.buildKakaoPageIdentity(newClone, {
    dataUrl: "data:image/png;base64,AQIN",
    imageUrl: newClone.currentSrc,
    width: 760,
    height: 1200
  });
  assert.equal(oldIdentity.pageId, newIdentity.pageId);
  assert.notEqual(oldIdentity.imageRevision, newIdentity.imageRevision);
  runtime.__test.kakaoStore.registerPageHandle({
    ...oldIdentity,
    target: oldClone
  });
  runtime.__test.kakaoStore.registerPageHandle({
    ...newIdentity,
    target: newClone
  });
  assert.equal(runtime.__test.kakaoStore.getPageHandleForTarget(oldClone), null);
  assert.equal(runtime.__test.getTargetForKakaoPageId(newIdentity.pageId), newClone);
});
test("OCR observation normalization preserves filtered evidence and strips translation fields from semantics", () => {
  const normalized = runtime.__test.normalizeOcrObservationResult({
    observations: [{
      id: "o1",
      original_text: "  Hello?!  ",
      translated_text: "ignored"
    }],
    filteredObservations: [{
      id: "o2",
      originalText: "…",
      filterReason: "symbol_only"
    }]
  }, {
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: {
      "page-a": "rev-a"
    }
  });
  assert.equal(normalized.observations[0].originalText, "Hello?!");
  assert.equal("translated_text" in normalized.observations[0], false);
  assert.deepEqual(normalized.observations[0].pageIds, ["page-a"]);
  assert.equal(normalized.filteredObservations[0].filterReason, "symbol_only");
  assert.equal(normalized.counts.eligible, 1);
  assert.equal(normalized.counts.filtered, 1);
});
test("canonical projections adapt to renderer bubbles without turning cover projections into text", () => {
  const primary = runtime.__test.projectionToRendererBubble({
    projectionId: "p-text",
    canonicalId: "c1",
    canonicalRevision: 2,
    role: "text_primary",
    geometry: {
      x: 10,
      y: 20,
      w: 30,
      h: 15
    },
    originalText: "안녕",
    translatedText: "你好"
  });
  const cover = runtime.__test.projectionToRendererBubble({
    projectionId: "p-cover",
    canonicalId: "c1",
    role: "cover_only",
    geometry: {
      x: 5,
      y: 2,
      w: 20,
      h: 8
    },
    originalText: "안녕",
    translatedText: "不应显示"
  });
  assert.equal(primary.translated_text, "你好");
  assert.equal(primary.canonical_revision, 2);
  assert.equal(cover.translated_text, "");
  assert.equal(cover.projection_role, "cover_only");
});
test("canonical cleaned artifact requests forward supplemental page masks", () => {
  const cleanedMasks = [{
    coordinateSpace: "percent",
    box: {
      x: 22,
      y: 89,
      w: 54,
      h: 11
    }
  }];
  const sentMessage = runtime.__test.buildOcrMessageForPayload({
    dataUrl: "data:image/png;base64,AQID",
    imageUrl: "page-a",
    ocrMode: "single",
    pageSpans: []
  }, {
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevision: "revision-a",
    imageRevisionByPage: {
      "page-a": "revision-a"
    },
    requestKey: "page:page-a:revision-a",
    requireCleanedImage: true,
    forceCleanedImageArtifact: true,
    cleanedMasks
  });
  assert.deepEqual(sentMessage.cleanedMasks, cleanedMasks);
  assert.equal(sentMessage.forceCleanedImageArtifact, true);
});
test("rendered OCR bubbles produce an asynchronous term-discovery payload", () => {
  const message = runtime.__test.buildTermDiscoveryMessage({
    bubbles: [{
      id: "t0",
      original_text: "김성현",
      translated_text: "金成贤"
    }, {
      id: "t1",
      original_text: "성현",
      translated_text: "成贤"
    }, {
      id: "empty",
      original_text: "",
      translated_text: ""
    }]
  }, "target-1", "https://cdn.example.test/page-1.jpg", "https://reader.example.test/chapter?episode=1#p2", "第 1 话");
  assert.equal(message.type, "DISCOVER_TERMS");
  assert.equal(message.blocks.length, 2);
  assert.equal(message.blocks[0].originalText, "김성현");
  assert.notEqual(message.blocks[0].id, message.blocks[1].id);
  assert.match(message.targetKey, /^image-/);
});
test("Kakao stitch neighbor scan skips repeated owner-source nodes", () => {
  const entries = [{
    target: "previous-page",
    descriptor: {
      left: 0,
      top: 0,
      bottom: 1000,
      width: 760,
      height: 1000,
      sourceKey: "previous"
    }
  }, {
    target: "previous-duplicate-owner",
    descriptor: {
      left: 0,
      top: 990,
      bottom: 1990,
      width: 760,
      height: 1000,
      sourceKey: "owner"
    }
  }, {
    target: "owner-page",
    descriptor: {
      left: 0,
      top: 1000,
      bottom: 2000,
      width: 760,
      height: 1000,
      sourceKey: "owner"
    }
  }, {
    target: "next-duplicate-owner",
    descriptor: {
      left: 0,
      top: 1010,
      bottom: 2010,
      width: 760,
      height: 1000,
      sourceKey: "owner"
    }
  }, {
    target: "next-page",
    descriptor: {
      left: 0,
      top: 2000,
      bottom: 3000,
      width: 760,
      height: 1000,
      sourceKey: "next"
    }
  }];
  assert.equal(runtime.__test.findKakaoStitchNeighborTarget(entries, 2, "previous"), "previous-page");
  assert.equal(runtime.__test.findKakaoStitchNeighborTarget(entries, 2, "next"), "next-page");
});
test("跨图窗口只接受同宽、对齐且紧邻的图片", () => {
  const owner = {
    left: 0,
    top: 1000,
    bottom: 2000,
    width: 760,
    height: 1000,
    sourceKey: "owner"
  };
  const previous = {
    left: 0,
    top: 0,
    bottom: 1000,
    width: 760,
    height: 1000,
    sourceKey: "previous"
  };
  const distant = {
    left: 0,
    top: 0,
    bottom: 800,
    width: 760,
    height: 800,
    sourceKey: "distant"
  };
  const narrow = {
    left: 120,
    top: 2000,
    bottom: 3000,
    width: 420,
    height: 1000,
    sourceKey: "narrow"
  };
  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, previous, "previous"), true);
  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, distant, "previous"), false);
  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, narrow, "next"), false);
  assert.equal(runtime.__test.isVerifiedKakaoStitchNeighbor(owner, {
    ...previous,
    sourceKey: "owner"
  }, "previous"), false);
});
test("跨图上下文根据显示比例动态计算并记录页面全局坐标", () => {
  globalThis.window.scrollX = 12;
  globalThis.window.scrollY = 500;
  const plan = runtime.__test.buildKakaoStitchWindowPlan({
    owner: {
      left: 20,
      top: 100,
      width: 760,
      height: 1000
    },
    previous: {
      width: 760
    },
    next: {
      width: 760
    },
    canonicalWidth: 760,
    ownerHeight: 1000,
    previousHeight: 900,
    nextHeight: 1200
  });
  assert.equal(plan.previousSlice, 350);
  assert.equal(plan.nextSlice, 350);
  globalThis.window.scrollX = 0;
  globalThis.window.scrollY = 0;
});
test("Kakao short adjacent pages are attached as full neighboring slices", () => {
  const plan = runtime.__test.buildKakaoStitchWindowPlan({
    owner: {
      left: 0,
      top: 520,
      width: 760,
      height: 1000
    },
    previous: {
      left: 0,
      top: 240,
      width: 760,
      height: 280
    },
    next: {
      left: 0,
      top: 1520,
      width: 760,
      height: 360
    },
    canonicalWidth: 760,
    ownerHeight: 1000,
    previousHeight: 280,
    nextHeight: 360
  });
  assert.equal(plan.previousSlice, 280);
  assert.equal(plan.nextSlice, 360);
  assert.equal(plan.previousShortPageAttachment, true);
  assert.equal(plan.nextShortPageAttachment, true);
});
test("novel chapter translation schedules a sampled term-discovery message with the series title ignored", () => {
  const message = runtime.__test.buildNovelDiscoveryMessage({
    scopeKey: "kakao:65171279",
    chapterId: "70081892",
    seriesTitle: "달의 끝에서"
  }, [{ id: "hash-p0", originalText: "원문 0", translatedText: "月之尽头" }], "https://page.kakao.com/content/65171279/viewer/70081892", "달의 끝에서 12화");
  assert.equal(message.type, "DISCOVER_TERMS");
  assert.equal(message.targetKey, "novel-kakao:65171279:70081892");
  assert.deepEqual(message.autoIgnoreSources, ["달의 끝에서"]);
  assert.equal(message.blocks[0].id, "hash-p0");
  assert.equal(message.blocks[0].originalText, "원문 0");
});
test("novel revision panel wires the add-term flow with AI extraction", () => {
  assert.match(contentSource, /EXTRACT_TERM_FROM_CONTEXT/);
  assert.match(contentSource, /CONFIRM_TERM_CANDIDATES/);
  assert.match(contentSource, /mt-novel-revision-term/);
  assert.match(contentSource, /提取韩文原文/);
  assert.match(contentSource, /selectionStart/);
});
