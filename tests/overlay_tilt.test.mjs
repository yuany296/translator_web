import assert from "node:assert/strict";
import test from "node:test";

// 用户缺陷「覆盖层没有倾斜」的最小复现：OCR 只把倾角放进 polygon、rotation_deg 缺失时，
// 译文文字节点、遮罩四边形、场景文字层、嵌入式画布四条路径都必须保留原文字形倾角。
globalThis.location = {
  hostname: "page.kakao.com", pathname: "/content/1", search: "?episode=7",
  href: "https://page.kakao.com/content/1?episode=7#page-2", origin: "https://page.kakao.com"
};
globalThis.window = { scrollX: 0, scrollY: 0, innerWidth: 1200, innerHeight: 800 };
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.getComputedStyle = element => element && element.__style || { overflowX: "visible", overflowY: "visible" };

class FakeStyle {
  setProperty(name, value) { this[name] = value; }
  removeProperty(name) { delete this[name]; }
  getPropertyValue(name) { return this[name] || ""; }
}
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = []; this.dataset = {}; this.style = new FakeStyle();
    this.className = ""; this.textContent = ""; this.title = ""; this.isConnected = false;
    this.classList = {
      _set: new Set(),
      add(...n) { n.forEach(x => this._set.add(x)); },
      remove(...n) { n.forEach(x => this._set.delete(x)); },
      contains(n) { return this._set.has(n) || String(this.className).split(/\s+/u).includes(n); },
      toggle(n, e) { if (e === undefined) e = !this.contains(n); if (e) this._set.add(n); else this._set.delete(n); return e; }
    };
  }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  setAttribute() {}
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.document = {
  createElement: () => new FakeElement("div"),
  createElementNS: () => new FakeElement("div"),
  documentElement: new FakeElement("html"),
  body: new FakeElement("body"),
  getElementById: () => null,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  title: "tilt-test"
};

await import("../extension/src/content/index.js");
const api = globalThis.__MANGA_TRANSLATOR_V3__;
const T = api.__test;
const { buildRenderSceneForBubbles } = await import("../extension/src/rendering/scene-builder.js");
const { installRendererEmbed } = await import("../extension/src/content/modules/renderer-embed.js");
const { installRendererCanvas } = await import("../extension/src/content/modules/renderer-canvas.js");

// 首边 -8/50 弧度 ≈ -9.0903°：向左上倾斜的原文四边形。
const polygonTilted = [{ x: 10, y: 20 }, { x: 60, y: 12 }, { x: 62, y: 30 }, { x: 12, y: 38 }];
function makeBubble(extra = {}) {
  return {
    x: 10, y: 20, w: 50, h: 10,
    polygon: polygonTilted,
    original_text: "원문", translated_text: "译文",
    bg_type: "solid", bg_color: "#ffffff",
    ...extra
  };
}

test("DOM 译文节点：rotation_deg 缺失时用 polygon 兜底恢复倾角", () => {
  const node = T.createBubbleNode(makeBubble(), 0);
  assert.ok(node, "应创建译文节点");
  assert.equal(Number(node.dataset.rotationDeg).toFixed(2), "-9.09");
  assert.match(node.style.getPropertyValue("--mt-base-transform"), /rotate\(-9\.09deg\)/);
});

test("遮罩裁剪层：跟随原文字形使用倾斜四边形，而不是轴对齐矩形", () => {
  const bubble = makeBubble();
  const geometry = T.resolveBubbleCoverGeometry(bubble);
  assert.equal(geometry.tilted, true);

  const cover = T.buildBubbleCoverProjection(bubble);
  // 覆盖节点盒子仍是最终蓝框（polygon 外接框），旋转与 polygon 原样保留。
  assert.deepEqual({ x: cover.x, y: cover.y, w: cover.w, h: cover.h }, { x: 10, y: 12, w: 52, h: 26 });
  assert.deepEqual(cover.polygon, bubble.polygon);

  const clipNode = T.createBubbleCoverClipNode(bubble, T.createBubbleNode(cover, 0));
  assert.equal(clipNode.dataset.coverTilted, "true");
  assert.equal(clipNode.style.transform, "translate(-50%, -50%)");
  assert.match(clipNode.style.clipPath, /^polygon\(/);
  const corners = clipNode.style.clipPath.slice("polygon(".length, -1).split(", ")
    .map(pair => pair.split(" ").map(value => Number(value.replace("%", ""))));
  assert.equal(corners.length, 4);
  // 四边形上边两角 y 不同 ⇒ 遮罩确实倾斜，而不是水平矩形。
  assert.notEqual(corners[0][1], corners[1][1]);
});

test("场景文字层：polygon 倾角传到 buildRenderSceneForBubbles 的 placement", () => {
  for (const bubble of [makeBubble({ rotation_deg: -9.09 }), makeBubble()]) {
    const scene = buildRenderSceneForBubbles({
      id: "tilt", surface: { id: "p1", type: "page", width: 1000, height: 1000 },
      bubbles: [{ ...bubble, canonical_id: "c1" }], measure: () => 10
    });
    const cover = scene.layers.find(layer => layer.type === "cover");
    const text = scene.layers.find(layer => layer.type === "text");
    assert.ok(cover && cover.geometry.coverTilted, "遮罩四边形应倾斜");
    assert.ok(text, "应生成文字层");
    assert.ok(Math.abs(text.geometry.placement.rotationDeg + 9.09) < 0.05,
      `场景文字层倾角应为 -9.09，实际 ${text.geometry.placement.rotationDeg}`);
  }
});

test("嵌入式画布：drawEmbeddedBubbles 按 polygon 倾角执行 rotate", () => {
  const runtime = {
    state: { displayMode: "translated" },
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    cleanRenderableText: value => String(value || "").trim(),
    formatTranslationForOriginalLines: value => String(value || ""),
    normalizeBgType: value => ["solid", "transparent", "none"].includes(String(value)) ? String(value) : "solid",
    getBubbleRenderColors: () => ({ textColor: "#000000", strokeColor: "#ffffff" }),
    getCanvasFillBox(value, canvasWidth, canvasHeight) {
      if (!value || typeof value !== "object") return null;
      const box = {
        x: Number(value.x) / 100 * canvasWidth, y: Number(value.y) / 100 * canvasHeight,
        w: Number(value.w) / 100 * canvasWidth, h: Number(value.h) / 100 * canvasHeight
      };
      return Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0 ? box : null;
    },
    getEmbeddedPolygonGeometry: () => null,
    unionRenderBoxes: (left, right) => right || left,
    getDynamicStrokeWidth: size => size * 0.1,
    resolveBubblePolygonRotation: T.resolveBubblePolygonRotation,
    resolveBubbleCoverGeometry: T.resolveBubbleCoverGeometry,
    drawFittedText: () => {}
  };
  installRendererEmbed(runtime);
  installRendererCanvas(runtime);

  const calls = [];
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (["save", "restore", "beginPath", "clip", "closePath"].includes(prop)) return () => {};
      if (["translate", "rotate", "moveTo", "lineTo", "fillRect"].includes(prop)) {
        return (...args) => calls.push([prop, ...args]);
      }
      if (prop === "measureText") return () => ({ width: 0 });
      return () => {};
    },
    set() { return true; }
  });
  runtime.drawEmbeddedBubbles(ctx, 1000, 1000, [makeBubble()], {});
  const rotate = calls.find(call => call[0] === "rotate");
  assert.ok(rotate, "画布必须对译文执行 rotate");
  assert.ok(Math.abs(rotate[1] - (-9.090276920822323) * Math.PI / 180) < 1e-3,
    `画布旋转角应接近 -9.09°，实际 ${rotate[1]}`);
});
