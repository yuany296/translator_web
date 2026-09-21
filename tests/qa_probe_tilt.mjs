// QA 独立探针（非 *.test.mjs，不被测试套件收集）：逐点核对倾斜口径与点序敏感性。
// 运行：node tests/qa_probe_tilt.mjs
import assert from "node:assert/strict";

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
  title: "probe"
};

await import("../extension/src/content/index.js");
const T = globalThis.__MANGA_TRANSLATOR_V3__.__test;
const { buildRenderSceneForBubbles } = await import("../extension/src/rendering/scene-builder.js");
const { polygonEdgeRotationDeg, polygonTiltDeg, resolveCoverQuad } = await import("../extension/src/rendering/cover-geometry.js");

const fmt = n => Number(n).toFixed(4);
function sceneRotation(polygon, rotationDeg) {
  const bubble = {
    x: 10, y: 20, w: 50, h: 10, polygon, original_text: "원문", translated_text: "译文",
    bg_type: "solid", canonical_id: "c1"
  };
  if (rotationDeg !== undefined) bubble.rotation_deg = rotationDeg;
  const scene = buildRenderSceneForBubbles({
    id: "p", surface: { id: "s", type: "page", width: 1000, height: 1000 },
    bubbles: [bubble], measure: () => 10
  });
  const text = scene.layers.find(l => l.type === "text");
  const cover = scene.layers.find(l => l.type === "cover");
  return {
    textRotation: text ? text.geometry.placement.rotationDeg : null,
    coverTilted: cover ? cover.geometry.coverTilted : null
  };
}

const AXIS = {
  "TL-first(horiz)": [{ x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 30 }, { x: 10, y: 30 }],
  "TR-first(vert)": [{ x: 60, y: 20 }, { x: 60, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 20 }],
  "BR-first(horiz)": [{ x: 60, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 20 }, { x: 60, y: 20 }],
  "BL-first(vert)": [{ x: 10, y: 30 }, { x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 30 }],
  "CCW-from-TL": [{ x: 10, y: 20 }, { x: 10, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 20 }]
};
const TILTED = [{ x: 10, y: 20 }, { x: 60, y: 12 }, { x: 62, y: 30 }, { x: 12, y: 38 }];

console.log("=== B6: 轴对齐框、不同点序/起点 ===");
console.log("expected for a truly axis-aligned box: text rotationDeg = 0, coverTilted = false");
for (const [name, poly] of Object.entries(AXIS)) {
  const s = sceneRotation(poly, undefined);
  console.log(`${name}\n   edgeDeg=${fmt(polygonEdgeRotationDeg(poly))}  tiltDeg=${fmt(polygonTiltDeg(poly))}  ` +
    `resolveBubblePolygonRotation=${fmt(T.resolveBubblePolygonRotation(poly, undefined))}  ` +
    `scene.textRotation=${fmt(s.textRotation)}  scene.coverTilted=${s.coverTilted}`);
}

console.log("\n=== B5: 四种气泡输入 (a)polygon-only (b)rotation-only (c)both-conflict (d)neither ===");
const axisPoly = AXIS["TL-first(horiz)"];
const cases = {
  "(a) polygon tilted, no rotation_deg": [{ x: 10, y: 20, w: 50, h: 10, polygon: TILTED }],
  "(b) rotation_deg only, axis polygon": [{ x: 10, y: 20, w: 50, h: 10, polygon: axisPoly, rotation_deg: -9.09 }],
  "(c) both, conflict (rot=30, polygon≈-9.09)": [{ x: 10, y: 20, w: 50, h: 10, polygon: TILTED, rotation_deg: 30 }],
  "(d) neither": [{ x: 10, y: 20, w: 50, h: 10 }]
};
for (const [name, [bubble]] of Object.entries(cases)) {
  const b = { ...bubble, original_text: "원문", translated_text: "译文", bg_type: "solid", canonical_id: "c1" };
  const scene = buildRenderSceneForBubbles({
    id: "p", surface: { id: "s", type: "page", width: 1000, height: 1000 }, bubbles: [b], measure: () => 10
  });
  const text = scene.layers.find(l => l.type === "text");
  const cover = scene.layers.find(l => l.type === "cover");
  const geo = T.resolveBubbleCoverGeometry(b);
  const nodeRot = T.createBubbleNode(b, 0).dataset.rotationDeg;
  console.log(`${name}\n   scene.textRotation=${text ? fmt(text.geometry.placement.rotationDeg) : "n/a"}` +
    `  scene.coverTilted=${cover ? cover.geometry.coverTilted : null}` +
    `  resolveCoverQuad.tilted=${geo ? geo.tilted : null}` +
    `  createBubbleNode.rotationDeg=${fmt(nodeRot)}`);
  if (name.startsWith("(c)")) {
    // 契约：文字层用 rotation_deg；遮罩用**识别到的文字框本身**（polygon），只按覆盖范围外扩。
    // 两者数值不同不代表冲突 —— rotation_deg 来自像素坐标、polygon 存百分比，
    // 同一段斜排文字在两套坐标里本来就读出不同的角度（曾按数值比对，把遮罩撑成外接框）。
    console.log(`   >>> text uses rotation_deg(${fmt(nodeRot)}); cover quad follows the recognized text box, ` +
      `bounds=${geo ? `${fmt(geo.bounds.w)}x${fmt(geo.bounds.h)}` : "n/a"}`);
  }
}

console.log("\n=== B5: resolveCoverQuad 直接输出 (a) ===");
console.log(JSON.stringify(resolveCoverQuad({ polygon: TILTED, rotationDeg: 0, padding: 0 }), null, 0));
console.log("\n=== D12 sanity: polygonEdgeRotationDeg(TILTED) 应为 ≈ -9.0903 ===");
console.log(fmt(polygonEdgeRotationDeg(TILTED)));
assert.ok(Math.abs(polygonEdgeRotationDeg(TILTED) + 9.0903) < 0.001);
console.log("\nprobe done");
