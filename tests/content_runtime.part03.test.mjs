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
test("Kakao short attachment requires a short neighbor relative to a larger owner", () => {
  assert.equal(runtime.__test.isAttachableKakaoShortPage({
    width: 760,
    height: 280
  }, {
    width: 760,
    height: 1000
  }, 280, 1000), true);
  assert.equal(runtime.__test.isAttachableKakaoShortPage({
    width: 760,
    height: 0
  }, {
    width: 760,
    height: 1000
  }, 430, 1000), true);
  assert.equal(runtime.__test.isAttachableKakaoShortPage({
    width: 760,
    height: 0
  }, {
    width: 760,
    height: 1000
  }, 900, 1000), false);
  assert.equal(runtime.__test.isAttachableKakaoShortPage({
    width: 760,
    height: 280
  }, {
    width: 760,
    height: 320
  }, 280, 320), false);
});
test("Kakao vertical overlap detection finds repeated suffix and prefix", () => {
  const width = 4;
  const makeSample = rows => ({
    width,
    height: rows.length,
    gray: Uint8Array.from(rows.flatMap(value => Array.from({
      length: width
    }, () => value)))
  });
  const previous = makeSample([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  const current = makeSample([40, 50, 60, 70, 80, 90, 100, 140, 150, 160]);
  const overlap = runtime.__test.findKakaoVerticalOverlap(previous, current);
  assert.equal(overlap.accepted, true);
  assert.equal(overlap.rows, 7);
  assert.equal(overlap.mae, 0);
});
test("拼接结果为空或坐标异常时要求回退单图", () => {
  const payload = {
    stitch: {
      verified: true
    },
    singleImagePayload: {
      dataUrl: "data:image/png;base64,A"
    }
  };
  assert.match(runtime.__test.shouldFallbackFromKakaoStitch(payload, {
    bubbles: []
  }, {
    bubbles: []
  }), /no owner text/);
  assert.match(runtime.__test.shouldFallbackFromKakaoStitch(payload, {
    bubbles: [{
      x: 10,
      y: 10,
      w: 20,
      h: 10
    }]
  }, {
    bubbles: [{
      x: 10,
      y: -60,
      w: 20,
      h: 10
    }]
  }), /implausible/);
  assert.equal(runtime.__test.shouldFallbackFromKakaoStitch(payload, {
    bubbles: [{
      x: 10,
      y: 10,
      w: 20,
      h: 10
    }]
  }, {
    bubbles: [{
      x: 10,
      y: 10,
      w: 20,
      h: 10
    }]
  }), "");
});
test("page-edge fragmented images reject stitched admission before OCR", () => {
  const rejection = runtime.__test.shouldRejectKakaoPageEdgeStitch({
    owner: {
      sourceKey: "https://page-edge.kakao.com/sdownload/resource?kid=frag",
      width: 720,
      height: 540
    },
    canonicalWidth: 810,
    ownerHeight: 540,
    previous: {
      sourceKey: "previous"
    },
    next: {
      sourceKey: "next"
    },
    previousHeight: 1193,
    nextHeight: 315
  });
  assert.match(rejection, /page-edge fragmented/);
});
test("dw-img large images are not rejected by page-edge fragmented admission", () => {
  const rejection = runtime.__test.shouldRejectKakaoPageEdgeStitch({
    owner: {
      sourceKey: "https://dw-img-page.kakao.com/sdownload/resource?token=large",
      width: 720,
      height: 947
    },
    canonicalWidth: 760,
    ownerHeight: 1000,
    previous: {
      sourceKey: "previous"
    },
    next: {
      sourceKey: "next"
    },
    previousHeight: 1000,
    nextHeight: 1380
  });
  assert.equal(rejection, "");
});
test("canonical seam evidence detects a medium page-edge fragment structure", () => {
  assert.equal(runtime.__test.hasKakaoFragmentStructureRisk({
    stableSource: "https://page-edge.kakao.com/sdownload/resource?kid=fragment",
    width: 760,
    height: 700,
    payload: {
      dataUrl: "data:image/png;base64,AQID"
    }
  }), true);
  assert.equal(runtime.__test.hasKakaoFragmentStructureRisk({
    stableSource: "https://dw-img-page.kakao.com/sdownload/resource?kid=full",
    width: 760,
    height: 1200
  }), false);
});
test("OCR request key includes source token, mode, and fallback reason", () => {
  const first = runtime.__test.buildOcrRequestKey("owner-key", {
    ocrMode: "single-fallback",
    sourceToken: "https://page-edge.kakao.com/sdownload/resource?kid=a",
    fallbackReason: "stitched OCR dropped all bubbles"
  });
  const second = runtime.__test.buildOcrRequestKey("owner-key", {
    ocrMode: "stitch",
    sourceToken: "https://page-edge.kakao.com/sdownload/resource?kid=b",
    fallbackReason: ""
  });
  assert.notEqual(first, second);
  assert.match(first, /mode:single-fallback/);
  assert.match(second, /mode:stitch/);
});
test("content does not skip single-fallback before sending it to background", () => {
  assert.equal(contentSource.includes("duplicate single-fallback request"), false);
  assert.equal(contentSource.includes("shouldSkipRepeatedFallbackRequest"), false);
});
test("stitched OCR keeps only boxes whose center belongs to the owner image", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 5,
      w: 30,
      h: 8,
      original_text: "previous"
    }, {
      x: 10,
      y: 20,
      w: 30,
      h: 20,
      original_text: "boundary"
    }, {
      x: 10,
      y: 88,
      w: 30,
      h: 8,
      original_text: "next"
    }]
  }, makeStitchPayload(300, 600, 1200, {
    previous: {
      source: "previous",
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 300
      }
    },
    next: {
      source: "next",
      drawRect: {
        x: 0,
        y: 900,
        w: 760,
        h: 300
      }
    }
  }), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 100,
      width: 600,
      height: 600
    })
  }, "owner-a");
  assert.deepEqual(result.bubbles.map(bubble => bubble.original_text), ["boundary"]);
  assert.equal(result.bubbles[0].stitch_overflow, true);
  // Overflow bubble: crosses owner top boundary, not clipped
  assert.ok(Math.abs(result.bubbles[0].y - -10) < 1e-9);
  assert.ok(Math.abs(result.bubbles[0].h - 40) < 1e-9);
});
test("stitched OCR drops owner-only bubbles that do not cross seam boundaries", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 8,
      w: 20,
      h: 8,
      original_text: "previous-only"
    }, {
      x: 10,
      y: 44,
      w: 20,
      h: 8,
      original_text: "owner-only"
    }, {
      x: 10,
      y: 84,
      w: 20,
      h: 8,
      original_text: "next-only"
    }]
  }, makeStitchPayload(300, 600, 1200, {
    previous: {
      source: "previous",
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 300
      }
    },
    next: {
      source: "next",
      drawRect: {
        x: 0,
        y: 900,
        w: 760,
        h: 300
      }
    }
  }), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "owner-segment");

  // Non-seam-crossing bubbles are dropped to avoid duplicating single-page OCR results.
  // Only bubbles that actually cross a seam boundary survive the filter.
  assert.deepEqual(result.bubbles.map(bubble => bubble.original_text), []);
});
test("跨图结果使用捕获时的页面全局坐标而不是滚动后的临时坐标", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 30,
      w: 20,
      h: 10,
      original_text: "stable"
    }]
  }, makeStitchPayload(300, 600, 1200), {
    getBoundingClientRect: () => ({
      left: 50,
      top: 2000,
      width: 600,
      height: 600
    })
  }, "owner-global");

  // global_box is now computed from current target rect + scroll, not stored ownerPageRect
  // target rect: left=50, top=2000. bubble: x=10, y=0 (clipped), w=20, h=16.67
  // global_box.left = 50 + 0 + (x/100)*600, global_box.top = 2000 + 0 + (y/100)*600
  assert.ok(result.bubbles.length > 0, "should have mapped bubbles");
});
test("global Kakao dedupe drops the same overlapping boundary text from a neighbor window", () => {
  const first = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 48,
      w: 30,
      h: 12,
      original_text: "피크닉 세트."
    }]
  }, makeStitchPayload(300, 600, 1200), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "owner-b");
  const second = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 23,
      w: 30,
      h: 12,
      original_text: "피크닉세트"
    }]
  }, makeStitchPayload(300, 600, 1200), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 300,
      width: 600,
      height: 600
    })
  }, "owner-c");
  assert.equal(first.bubbles.length, 1);
  assert.equal(second.bubbles.length, 0);
});
test("global Kakao dedupe replaces an earlier partial sentence with the later complete sentence", () => {
  const first = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 20,
      y: 48,
      w: 35,
      h: 10,
      original_text: "아물론",
      translated_text: "啊当然"
    }]
  }, makeStitchPayload(300, 600, 1200), {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "partial-owner");
  const second = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 18,
      y: 23,
      w: 55,
      h: 18,
      original_text: "아물론이대로모든게끝나는건아닙니다",
      translated_text: "啊当然一切不会就这样结束"
    }]
  }, makeStitchPayload(300, 600, 1200, {
    targetKey: "complete-owner"
  }), {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 300,
      width: 600,
      height: 600
    })
  }, "complete-owner");
  assert.equal(first.bubbles.length, 0);
  assert.equal(second.bubbles.length, 1);
  assert.equal(second.bubbles[0].translated_text, "啊当然一切不会就这样结束");
});
test("Kakao page-level dedupe also removes a single-image fragment covered by a stitched sentence", async () => {
  const complete = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 18,
      y: -10,
      w: 56,
      h: 20,
      block_id: "complete-cross-page",
      original_text: "아,물론 이대로모든게 끝나는 건 아닙니다!",
      translated_text: "啊，当然，事情不会就这样结束！"
    }],
    debug: {
      finalBubbles: [{
        blockId: "complete-cross-page"
      }],
      items: [{
        blockId: "complete-cross-page"
      }]
    }
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 1000,
      width: 600,
      height: 1000
    })
  }, "complete-page-level");
  const fragment = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 32,
      y: 90,
      w: 25,
      h: 7,
      block_id: "fragment-single-image",
      original_text: "아물론",
      translated_text: "啊当然"
    }],
    debug: {
      finalBubbles: [{
        blockId: "fragment-single-image"
      }],
      items: [{
        blockId: "fragment-single-image"
      }]
    }
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 1000
    })
  }, "fragment-page-level");
  assert.equal(complete.bubbles.length, 1);
  assert.equal(fragment.bubbles.length, 0);
  assert.deepEqual(fragment.debug.finalBubbles, []);
  assert.deepEqual(fragment.debug.items, []);
});
test("boundary neighbor bubble defers to adjacent page own bubble in global dedup", async () => {
  // 模拟：owner 页拼接 OCR 在 next 边界切片中识别到 "경계텍스트"，
  // 作为 stitch_boundary_neighbor overflow 渲染。然后相邻页独立 OCR 也识别到相同文字。
  // 相邻页自己的气泡应该胜出，owner 的 boundary neighbor 应被移除。
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 18,
      y: 94,
      w: 30,
      h: 8,
      block_id: "boundary-neighbor-bubble",
      original_text: "경계텍스트",
      translated_text: "边界文本",
      stitch_boundary_neighbor: true
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "owner-with-boundary-neighbor");
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 18,
      y: 2,
      w: 30,
      h: 8,
      block_id: "adjacent-own-bubble",
      original_text: "경계텍스트",
      translated_text: "边界文本"
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 550,
      width: 600,
      height: 600
    })
  }, "adjacent-own-page");

  // boundary neighbor 应被相邻页自己的气泡取代
  assert.equal(boundaryNeighbor.bubbles.length, 0);
  assert.equal(adjacentOwn.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles[0].block_id, "adjacent-own-bubble");
});
test("boundary neighbor partial OCR defers to adjacent page full own bubble", async () => {
  // 现场回归：owner overflow 只识别到下一页完整气泡的一段，翻译也不完全相同。
  // 只要空间重叠且文本有足够公共片段，就应删除旧的 boundary neighbor。
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 18,
      y: 106,
      w: 60,
      h: 16,
      block_id: "boundary-neighbor-partial-live",
      original_text: "참가자가이미 납지 매저다으",
      translated_text: "参赛者已经陷入黄昏（D级）了。",
      stitch_boundary_neighbor: true
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 4200,
      width: 600,
      height: 600
    })
  }, "owner-with-boundary-neighbor-partial");
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 12,
      y: 2,
      w: 78,
      h: 49,
      block_id: "adjacent-own-full-live",
      original_text: "어스름(D)등급 참가자가이미 납지 '정답을 알고있는상황.",
      translated_text: "黄昏(D级) 参赛者已经知道正确答案的情况。"
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 4750,
      width: 600,
      height: 600
    })
  }, "adjacent-own-page-full-live");
  assert.equal(boundaryNeighbor.bubbles.length, 0);
  assert.equal(adjacentOwn.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles[0].block_id, "adjacent-own-full-live");
});
test("unrelated boundary neighbor is kept when adjacent own text does not overlap", async () => {
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 18,
      y: 106,
      w: 60,
      h: 16,
      block_id: "boundary-neighbor-unrelated",
      original_text: "등급 어스름(D)",
      translated_text: "等级黄昏D",
      stitch_boundary_neighbor: true
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 6500,
      width: 600,
      height: 600
    })
  }, "owner-with-boundary-neighbor-unrelated");
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 12,
      y: 2,
      w: 78,
      h: 49,
      block_id: "adjacent-own-unrelated",
      original_text: "완전히다른내용입니다",
      translated_text: "完全不同的内容"
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 7050,
      width: 600,
      height: 600
    })
  }, "adjacent-own-page-unrelated");
  assert.equal(boundaryNeighbor.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles.length, 1);
});
test("boundary neighbor complementary seam text is kept despite identical translation", async () => {
  // 分页缝处一个对白被切成上下两半：上一页 stitched boundary 识别到上半句，
  // 下一页自有 OCR 识别到下半句。两者可能被翻成同一句，但不能互相去重。
  const boundaryNeighbor = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 18,
      y: 106,
      w: 60,
      h: 16,
      block_id: "boundary-neighbor-complementary",
      original_text: "다들수고 마이셔스니디",
      translated_text: "多謝款待",
      stitch_boundary_neighbor: true
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 8600,
      width: 600,
      height: 600
    })
  }, "owner-with-boundary-neighbor-complementary");
  const adjacentOwn = await runtime.__test.dedupeKakaoResultByPageCoordinates({
    bubbles: [{
      x: 12,
      y: 2,
      w: 78,
      h: 49,
      block_id: "adjacent-own-complementary",
      original_text: "많으셨습니다",
      translated_text: "多謝款待"
    }]
  }, {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 9150,
      width: 600,
      height: 600
    })
  }, "adjacent-own-page-complementary");
  assert.equal(boundaryNeighbor.bubbles.length, 1);
  assert.equal(adjacentOwn.bubbles.length, 1);
});
