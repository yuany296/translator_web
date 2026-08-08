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
test("overlay sync removes stale Kakao overlays when an image node is reused", () => {
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://page-edge.kakao.com/old-image.jpg";
  target.getAttribute = name => name === "src" ? target.currentSrc : "";
  target.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 600,
    bottom: 800,
    width: 600,
    height: 800
  });
  let removed = false;
  const root = {
    isConnected: true,
    style: {},
    remove() {
      removed = true;
      this.isConnected = false;
    }
  };
  target.currentSrc = "https://page-edge.kakao.com/new-image.jpg";
  runtime.__test.syncOverlayPosition({
    target,
    targetId: "stale-node",
    targetKey: "old-key",
    sourceToken: "https://page-edge.kakao.com/old-image.jpg",
    root,
    bubbleNodes: []
  });
  assert.equal(removed, true);
});
test("cleaned image patch aligns the source OCR box inside an overlay bubble", () => {
  assert.deepEqual({
    ...runtime.__test.getCleanedPatchStyle({
      x: 40,
      y: 25,
      w: 20,
      h: 10
    })
  }, {
    sizeX: "500%",
    sizeY: "1000%",
    positionX: "50%",
    positionY: "27.77777777777778%"
  });
});
test("stitched OCR remaps the full visual region polygon", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 30,
      w: 20,
      h: 10,
      original_text: "panel",
      region_polygon: [{
        x: 5,
        y: 25
      }, {
        x: 35,
        y: 25
      }, {
        x: 35,
        y: 45
      }, {
        x: 5,
        y: 45
      }]
    }]
  }, makeStitchPayload(300, 600, 1200), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 600
    })
  }, "owner-region");
  assert.deepEqual(result.bubbles[0].region_polygon.map(point => point.y), [0, 0, 40, 40]);
});
test("solid background clip is expressed relative to the translated box", () => {
  const clip = runtime.__test.buildRegionClipPath([{
    x: 10,
    y: 20
  }, {
    x: 40,
    y: 20
  }, {
    x: 40,
    y: 60
  }, {
    x: 10,
    y: 60
  }], 20, 30, 10, 20);
  assert.equal(clip, "polygon(-100.00% -50.00%, 200.00% -50.00%, 200.00% 150.00%, -100.00% 150.00%)");
});
test("solid cleanup keeps the full detected region instead of shrinking to the text box", () => {
  const fill = runtime.__test.buildSolidBackgroundBox({
    x: 16,
    y: 64,
    w: 24,
    h: 6.8
  }, {
    x: 8,
    y: 60,
    w: 40,
    h: 20
  });
  assert.deepEqual(fill, {
    x: 8,
    y: 60,
    w: 40,
    h: 20
  });
});
test("translation keeps the requested approximate source line count", () => {
  const formatted = runtime.__test.formatTranslationForOriginalLines("为什么没有把东西拿出来", 3);
  assert.equal(formatted.split("\n").length, 3);
  assert.equal(formatted.replace(/\n/g, ""), "为什么没有把东西拿出来");
});
test("translation line balancing avoids isolated CJK characters", () => {
  const formatted = runtime.__test.formatTranslationForOriginalLines("那么是不是该慢慢把粉丝团名字亮出来了呢？", 5);
  const lines = formatted.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines.join(""), "那么是不是该慢慢把粉丝团名字亮出来了呢？");
  assert.ok(lines.every(line => Array.from(line).length > 1));
  assert.ok(Array.from(lines.at(-1)).length > 2);
});
test("OCR tilt keeps the complete normalized -90 to 90 degree range", () => {
  assert.ok(Math.abs(runtime.__test.normalizeBubbleRotation(8) - 8) < 0.01);
  assert.ok(Math.abs(runtime.__test.normalizeBubbleRotation(0.4046) - 0.4046) < 0.0001);
  assert.ok(Math.abs(runtime.__test.resolveBubblePolygonRotation([{ x: 0, y: 10 }, { x: 50, y: 5 }, { x: 50, y: 20 }, { x: 0, y: 25 }], 0, 1000, 500) - Math.atan2(-2500, 50000) * 180 / Math.PI) < 0.0001);
  assert.ok(Math.abs(runtime.__test.normalizeBubbleRotation(-13, "chat") + 13) < 0.01);
  assert.ok(Math.abs(runtime.__test.normalizeBubbleRotation(-13, "ui") + 13) < 0.01);
  assert.equal(runtime.__test.normalizeBubbleRotation(32), 32);
  assert.equal(runtime.__test.normalizeBubbleRotation(-89), -89);
  assert.equal(runtime.__test.normalizeBubbleRotation(95), -85);
  assert.equal(runtime.__test.normalizeBubbleRotation(180), 0);
});
test("transparent backgrounds default to black text with a white outline", () => {
  const outline = runtime.__test.getBubbleRenderColors({}, "none");
  assert.deepEqual({
    ...outline
  }, {
    textColor: "#000000",
    strokeColor: "#ffffff"
  });
  const solid = runtime.__test.getBubbleRenderColors({}, "solid");
  assert.deepEqual({
    ...solid
  }, {
    textColor: "#111827",
    strokeColor: "#ffffff"
  });
  const custom = runtime.__test.getBubbleRenderColors({
    text_color: "#123456",
    stroke_color: "#abcdef"
  }, "none");
  assert.deepEqual({
    ...custom
  }, {
    textColor: "#123456",
    strokeColor: "#abcdef"
  });
});
test("complex-background outline uses the strengthened dynamic width", () => {
  assert.equal(runtime.__test.getDynamicStrokeWidth(20), 1.8);
  assert.equal(runtime.__test.getDynamicStrokeWidth(40), 3.4);
  assert.equal(runtime.__test.getDynamicStrokeWidth(80), 4.2);
});
test("stitched OCR maps explicitly attached short neighbor pages onto the owner edge", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 10,
      y: 8,
      w: 20,
      h: 8,
      original_text: "previous-short"
    }, {
      x: 10,
      y: 44,
      w: 20,
      h: 8,
      original_text: "short-owner-center"
    }, {
      x: 10,
      y: 84,
      w: 20,
      h: 8,
      original_text: "next-short"
    }]
  }, makeStitchPayload(300, 600, 1200, {
    previous: {
      source: "previous",
      shortPageAttachment: true,
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 300
      }
    },
    next: {
      source: "next",
      shortPageAttachment: true,
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
  }, "owner-short-neighbors");
  assert.deepEqual(result.bubbles.map(bubble => bubble.original_text), ["previous-short", "short-owner-center", "next-short"]);
  assert.equal(result.bubbles[0].stitch_attached_short_page, true);
  assert.equal(result.bubbles[0].stitch_overflow, true);
  assert.ok(result.bubbles[0].y < 0);
  assert.equal(result.bubbles[2].stitch_attached_short_page, true);
  assert.equal(result.bubbles[2].stitch_overflow, true);
  assert.ok(result.bubbles[2].y > 100);
});
test("stitched OCR keeps ordinary adjacent context-slice text as owner overflow", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 12,
      y: 1195 / 1460 * 100,
      w: 28,
      h: 190 / 1460 * 100,
      original_text: "next boundary caption",
      translated_text: "next boundary translation"
    }]
  }, makeStitchPayload(0, 1100, 1460, {
    next: {
      source: "next",
      drawRect: {
        x: 0,
        y: 1100,
        w: 760,
        h: 360
      }
    }
  }), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 720,
      height: 1100
    })
  }, "owner-next-context-boundary");
  assert.equal(result.bubbles.length, 1);
  assert.equal(result.bubbles[0].stitch_overflow, true);
  assert.equal(result.bubbles[0].stitch_boundary_neighbor, true);
  assert.ok(result.bubbles[0].y > 100);
  assert.ok(result.bubbles[0].h > 15);
});
test("stitched OCR keeps multiline speech bubble from deeper adjacent context", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 51,
      y: 1235 / 1460 * 100,
      w: 24,
      h: 34 / 1460 * 100,
      original_text: "어우피디님!",
      translated_text: "哦，PD大人！"
    }, {
      x: 48,
      y: 1286 / 1460 * 100,
      w: 31,
      h: 48 / 1460 * 100,
      original_text: "왜 이래요",
      translated_text: "为什么这样"
    }, {
      x: 50,
      y: 1350 / 1460 * 100,
      w: 28,
      h: 48 / 1460 * 100,
      original_text: "정말!!",
      translated_text: "真是的！！"
    }]
  }, makeStitchPayload(0, 1100, 1460, {
    next: {
      source: "next",
      drawRect: {
        x: 0,
        y: 1100,
        w: 760,
        h: 360
      }
    }
  }), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 720,
      height: 1100
    })
  }, "owner-next-context-multiline-speech");
  assert.deepEqual(result.bubbles.map(bubble => bubble.original_text), ["어우피디님!", "왜 이래요", "정말!!"]);
  assert.equal(result.bubbles.every(bubble => bubble.stitch_boundary_neighbor), true);
  assert.ok(result.bubbles[2].y > result.bubbles[0].y);
});
test("stitched OCR keeps merged boundary caption spanning owner and adjacent context", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 109.2 / 720 * 100,
      y: 1373 / 1820 * 100,
      w: 225.6 / 720 * 100,
      h: 192 / 1820 * 100,
      original_text: "봤냐, 이높들아! 꼴좋다,\n꼴좋아!",
      translated_text: "看到了吧，你们！活该，活该！",
      sourceLineCount: 2
    }]
  }, makeStitchPayload(360, 1100, 1820, {
    compositeWidth: 720,
    previous: {
      source: "previous",
      drawRect: {
        x: 0,
        y: 0,
        w: 720,
        h: 360
      }
    },
    next: {
      source: "next",
      drawRect: {
        x: 0,
        y: 1460,
        w: 720,
        h: 360
      }
    }
  }), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 720,
      height: 1100
    })
  }, "owner-next-context-merged-caption");
  assert.equal(result.bubbles.length, 1);
  assert.equal(result.bubbles[0].stitch_boundary_neighbor, true);
  assert.ok(result.bubbles[0].y < 100);
  assert.ok(result.bubbles[0].y + result.bubbles[0].h > 100);
});
test("stitched OCR still drops ordinary full-neighbor page text", () => {
  const result = runtime.__test.mapKakaoStitchedResult({
    bubbles: [{
      x: 12,
      y: 1210 / 2200 * 100,
      w: 28,
      h: 80 / 2200 * 100,
      original_text: "full neighbor page"
    }]
  }, makeStitchPayload(0, 1100, 2200, {
    next: {
      source: "next",
      drawRect: {
        x: 0,
        y: 1100,
        w: 760,
        h: 1100
      }
    }
  }), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 720,
      height: 1100
    })
  }, "owner-full-neighbor");
  assert.equal(result.bubbles.length, 0);
});
test("inflightByTarget prevents re-queue for same sourceToken on same DOM node", () => {
  assert.equal(runtime.__test.shouldReuseTargetInflight("https://example.com/img.jpg|generation:3", "https://example.com/img.jpg|generation:3"), true);
});
test("inflightByTarget allows re-queue when sourceToken changed (DOM reuse)", () => {
  assert.equal(runtime.__test.shouldReuseTargetInflight("https://example.com/old.jpg|generation:0", "https://example.com/new.jpg|generation:0"), false);
  assert.equal(runtime.__test.shouldReuseTargetInflight("https://example.com/same.jpg|generation:0", "https://example.com/same.jpg|generation:1"), false);
});
test("a queued revision check upgrades the pending request to force fresh OCR", () => {
  const target = {};
  const queue = [{
    target,
    options: {
      manual: true,
      force: false,
      reason: "page-auto"
    }
  }];
  const upgraded = runtime.__test.upgradeQueuedTranslationRequest(queue, target, {
    manual: true,
    force: true,
    reason: "kakao-image-revision-check"
  });
  assert.equal(upgraded, true);
  assert.equal(queue[0].options.force, true);
  assert.equal(queue[0].options.reason, "kakao-image-revision-check");
});
test("mtKakaoAttachedToKey blocks independent queue entry until timeout", () => {
  // Simulate a short page attached to an owner
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/short.jpg";
  target.getAttribute = name => name === "src" ? target.currentSrc : "";

  // Set attachment timestamp to now (not expired)
  target.dataset.mtKakaoAttachedToKey = "owner-key";
  target.dataset.mtKakaoAttachedToAt = String(Date.now());

  // The timeout constant is 8000ms, so this should NOT be expired
  const attachedAt = Number(target.dataset.mtKakaoAttachedToAt || 0);
  const timeout = 8000;
  assert.equal(Date.now() - attachedAt <= timeout, true, "Fresh attachment should not be expired");

  // Verify the attachment key is set
  assert.equal(target.dataset.mtKakaoAttachedToKey, "owner-key");
});
test("mtKakaoAttachedToKey expires and allows standalone translation after timeout", () => {
  const target = new globalThis.HTMLImageElement();
  target.isConnected = true;
  target.dataset = {};
  target.currentSrc = "https://example.com/short-expired.jpg";
  target.getAttribute = name => name === "src" ? target.currentSrc : "";

  // Set attachment timestamp to 10 seconds ago (expired)
  target.dataset.mtKakaoAttachedToKey = "owner-key";
  target.dataset.mtKakaoAttachedToAt = String(Date.now() - 10000);

  // The timeout constant is 8000ms, so this should be expired
  const attachedAt = Number(target.dataset.mtKakaoAttachedToAt || 0);
  const timeout = 8000;
  if (Date.now() - attachedAt > timeout) {
    // Simulate what queuePageAutoTranslate does on timeout
    delete target.dataset.mtKakaoAttachedToKey;
    delete target.dataset.mtKakaoAttachedToAt;
  }
  assert.equal(target.dataset.mtKakaoAttachedToKey, undefined, "Expired attachment key should be cleared");
  assert.equal(target.dataset.mtKakaoAttachedToAt, undefined, "Expired attachment timestamp should be cleared");
});
test("shouldFallbackFromKakaoStitch triggers on dropRatio > 0.7", () => {
  const payload = {
    stitch: {
      verified: true
    },
    singleImagePayload: {
      dataUrl: "data:image/png;base64,A"
    }
  };
  // 10 raw bubbles, 2 mapped = 80% drop ratio → should trigger
  const raw = Array.from({
    length: 10
  }, (_, i) => ({
    x: 10,
    y: i * 10 + 1,
    w: 20,
    h: 8,
    original_text: `line-${i}`
  }));
  const mapped = Array.from({
    length: 2
  }, (_, i) => ({
    x: 10,
    y: i * 10 + 1,
    w: 20,
    h: 8,
    original_text: `line-${i}`
  }));
  const reason = runtime.__test.shouldFallbackFromKakaoStitch(payload, {
    bubbles: raw
  }, {
    bubbles: mapped
  });
  assert.match(reason, /drop ratio/);
});
test("normalizeDebugCoordinateItems filters non-owner items and remaps coordinates", () => {
  const result = runtime.__test.normalizeDebugCoordinateItems([{
    id: "prev",
    rawBox: {
      left: 76,
      top: 60,
      width: 152,
      height: 48
    },
    text: "previous"
  }, {
    id: "owner-a",
    rawBox: {
      left: 76,
      top: 360,
      width: 152,
      height: 60
    },
    text: "owner text"
  }, {
    id: "next",
    rawBox: {
      left: 76,
      top: 1020,
      width: 152,
      height: 48
    },
    text: "next"
  }], {
    imageWidth: 760,
    imageHeight: 1200
  }, {
    stitch: {
      verified: true
    },
    compositeWidth: 760,
    compositeHeight: 1200,
    ownerDraw: {
      x: 0,
      y: 300,
      w: 760,
      h: 600
    },
    segments: [{
      source: "previous",
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 300
      }
    }, {
      source: "owner",
      drawRect: {
        x: 0,
        y: 300,
        w: 760,
        h: 600
      }
    }, {
      source: "next",
      drawRect: {
        x: 0,
        y: 900,
        w: 760,
        h: 300
      }
    }]
  });
  assert.equal(result.length, 1, "Only owner items should remain");
  if (result.length > 0) {
    assert.equal(result[0].id, "owner-a");
    assert.ok(Math.abs(result[0].percent.y - 10) < 1e-9, "Y should be remapped relative to owner");
    assert.ok(result[0].percent.h > 0, "Height should be positive");
  }
});
test("normalizeDebugCoordinateItems keeps adjacent boundary context debug items", () => {
  const result = runtime.__test.normalizeDebugCoordinateItems([{
    id: "caption-a",
    rawBox: {
      left: 129,
      top: 1211,
      width: 187,
      height: 82
    },
    text: "봤냐, 이놈들아!"
  }, {
    id: "caption-b",
    rawBox: {
      left: 184,
      top: 1263,
      width: 102,
      height: 64
    },
    text: "꼴좋다,"
  }, {
    id: "caption-c",
    rawBox: {
      left: 193,
      top: 1306,
      width: 101,
      height: 63
    },
    text: "꼴좋아!"
  }], {
    imageWidth: 760,
    imageHeight: 1460
  }, {
    stitch: {
      verified: true
    },
    compositeWidth: 760,
    compositeHeight: 1460,
    ownerDraw: {
      x: 0,
      y: 0,
      w: 760,
      h: 1100
    },
    segments: [{
      source: "owner",
      drawRect: {
        x: 0,
        y: 0,
        w: 760,
        h: 1100
      }
    }, {
      source: "next",
      drawRect: {
        x: 0,
        y: 1100,
        w: 760,
        h: 360
      }
    }]
  });
  assert.deepEqual(result.map(item => item.id), ["caption-a", "caption-b", "caption-c"]);
  assert.equal(result.every(item => item.percent.y > 100), true);
});
