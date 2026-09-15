// QA 独立探针：跨页覆盖层与普通覆盖层的倾斜口径是否同源一致。
// 运行：node tests/qa_probe_crosspage.mjs
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
    this.className = ""; this.textContent = ""; this.isConnected = false;
    this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } };
  }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  addEventListener() {} setAttribute() {} closest() { return null; }
  querySelector() { return null; } querySelectorAll() { return []; }
}
globalThis.document = {
  createElement: () => new FakeElement("div"), createElementNS: () => new FakeElement("div"),
  documentElement: new FakeElement("html"), body: new FakeElement("body"),
  getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
  addEventListener: () => {}, title: "probe"
};

await import("../extension/src/content/index.js");
const R = globalThis.__MANGA_TRANSLATOR_V3__;
const T = R.__test;

const surface = {
  canvasWidth: 760, canvasHeight: 520, pageIds: ["upper", "lower"],
  segments: [
    { pageId: "upper", drawRect: { x: 0, y: 0, w: 760, h: 260 }, sourceCrop: { x: 0, y: 740, w: 760, h: 260 }, naturalWidth: 760, naturalHeight: 1000 },
    { pageId: "lower", drawRect: { x: 0, y: 260, w: 760, h: 260 }, sourceCrop: { x: 0, y: 0, w: 760, h: 260 }, naturalWidth: 760, naturalHeight: 1000 }
  ]
};
const targets = new Map([
  ["upper", { left: 100, top: 50, width: 760, height: 1000 }],
  ["lower", { left: 100, top: 1074, width: 760, height: 1000 }]
]);
const rootRect = { left: 80, top: 20, width: 800, height: 2100 };
const TILTED = [{ x: 10, y: 20 }, { x: 60, y: 12 }, { x: 62, y: 30 }, { x: 12, y: 38 }];

console.log("RAW runtime.resolveBubbleCoverGeometry is", typeof R.resolveBubbleCoverGeometry);
console.log("RAW runtime.updateCoverSegments is", typeof R.updateCoverSegments);
console.log("RAW runtime.createCoverSegmentNode is", typeof R.createCoverSegmentNode);
console.log("RAW runtime.applyCoverSegmentTilt is", typeof R.applyCoverSegmentTilt);
console.log("RAW runtime.resolveBubbleCoverBox is", typeof R.resolveBubbleCoverBox);

for (const bubble of [
  { name: "polygon-only tilted", b: { x: 20, y: 35, w: 60, h: 30, fill_box: { x: 20, y: 35, w: 60, h: 30 }, polygon: TILTED, bg_type: "solid" } },
  { name: "rotation-only", b: { x: 20, y: 35, w: 60, h: 30, fill_box: { x: 20, y: 35, w: 60, h: 30 }, rotation_deg: -9.09, bg_type: "solid" } },
  { name: "axis-aligned", b: { x: 20, y: 35, w: 60, h: 30, fill_box: { x: 20, y: 35, w: 60, h: 30 }, bg_type: "solid" } }
]) {
  const normal = T.resolveBubbleCoverGeometry(bubble.b);
  const cross = T.buildCrossPageBubbleGeometry(surface, bubble.b, targets, rootRect);
  const same = Boolean(normal && cross) && normal.tilted === cross.coverTilted &&
    JSON.stringify(normal.quad) === JSON.stringify(cross.coverQuad);
  console.log(`\n[${bubble.name}] normal.tilted=${normal && normal.tilted}  cross.coverTilted=${cross && cross.coverTilted}`);
  console.log(`   normal.quad=${normal ? JSON.stringify(normal.quad) : null}`);
  console.log(`   cross.coverQuad=${cross ? JSON.stringify(cross.coverQuad) : null}`);
  console.log(`   SAME_SOURCE=${same}`);
  assert.equal(same, true, `${bubble.name}: cross-page tilt must match normal cover tilt`);
}
console.log("\ncrosspage probe done");
