import assert from "node:assert/strict";
import test from "node:test";
import { installSceneCrossPage } from "../extension/src/content/modules/scene-crosspage.js";
import { installCrossPageCover } from "../extension/src/content/modules/crosspage-cover.js";
import { installRendererCrossPage } from "../extension/src/content/modules/renderer-crosspage.js";
import { installCrossPageLifecycle } from "../extension/src/content/modules/crosspage-lifecycle.js";

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.values = new Set();
  }
  add(...names) {
    names.forEach(name => this.values.add(name));
  }
  contains(name) {
    return this.values.has(name) || this.owner.className.split(/\s+/u).includes(name);
  }
  toggle(name, enabled) {
    const active = enabled === undefined ? !this.contains(name) : enabled;
    if (active) this.values.add(name); else this.values.delete(name);
    return active;
  }
}

function makeStyle() {
  return {
    setProperty(name, value) { this[name] = value; },
    removeProperty(name) { delete this[name]; }
  };
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.parentElement = null;
    this.children = [];
    this.dataset = {};
    this.style = makeStyle();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.isConnected = false;
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
  }
  appendChild(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.push(child);
    child.setConnected(this.isConnected);
    return child;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(item => item !== this);
    }
    this.parentElement = null;
    this.setConnected(false);
  }
  setConnected(value) {
    this.isConnected = value;
    this.children.forEach(child => child.setConnected(value));
  }
  addEventListener() {}
  getBoundingClientRect() {
    if (this.classList.contains("mt-cross-page-root") && this.parentElement) {
      return this.parentElement.getBoundingClientRect();
    }
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
  }
}

function descendants(root, className) {
  const output = [];
  const visit = node => {
    if (node.classList.contains(className)) output.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return output;
}

function createRuntime(targets) {
  let layoutCalls = 0;
  const runtime = {
    state: {
      invalidated: false,
      crossPageOverlaysByRenderKey: new Map(),
      crossPageRootByHost: new WeakMap(),
      crossPageRoots: new Set(),
      crossPageGeometryRaf: 0,
      seamLayoutCache: new Map(),
      seamSourceModeByRenderKey: new Map()
    },
    MAX_FONT_FIT_CACHE: 50,
    normalizeSeamRect(value) {
      return {
        x: Number(value && value.x || 0), y: Number(value && value.y || 0),
        w: Number(value && (value.w ?? value.width) || 0),
        h: Number(value && (value.h ?? value.height) || 0)
      };
    },
    resolveBubbleCoverBox: bubble => bubble.fill_box || bubble,
    projectionToRendererBubble: bubble => ({ ...bubble }),
    normalizeBgType: value => String(value || "none"),
    cleanRenderableText: value => String(value || "").trim(),
    hasRenderableOcrDebug: () => false,
    getTargetForKakaoPageId: pageId => targets.get(pageId),
    fitBubbleFontSize: () => {
      layoutCalls += 1;
      return 20;
    },
    getBubbleOriginalTextHeight: () => 0,
    getDynamicStrokeWidth: size => size * 0.1,
    applyBubbleAnchorStyle(node, geometry) {
      node.style.left = `${geometry.centerX}px`;
      node.style.top = `${geometry.centerY}px`;
      node.style.transform = `translate(-50%, -50%) rotate(${geometry.rotation}deg)`;
    },
    createBubbleNode(bubble, _index, options = {}) {
      const node = new FakeElement("div");
      node.className = "mt-bubble mt-text-layer";
      node.classList.add("mt-bubble", "mt-text-layer");
      node.dataset.alignment = bubble.alignment || "center";
      node.dataset.rotationDeg = String(bubble.rotation_deg || 0);
      node.dataset.original = String(bubble.original_text || "");
      node.dataset.translated = String(bubble.translated_text || "");
      node.dataset.sourceLineCount = String(bubble.source_line_count || 1);
      node.dataset.sourceFontHeightPercent = String(bubble.font_height_percent || 0);
      node.dataset.seamRenderKey = String(options.seamRenderKey || "");
      node.textContent = bubble.translated_text;
      return node;
    },
    get layoutCalls() { return layoutCalls; }
  };
  installSceneCrossPage(runtime);
  installCrossPageCover(runtime);
  installRendererCrossPage(runtime);
  installCrossPageLifecycle(runtime);
  return runtime;
}

function makeSurface() {
  return {
    renderKey: "render-one",
    layoutKey: "layout-one",
    canvasWidth: 760,
    canvasHeight: 520,
    pageIds: ["upper", "lower"],
    cleanedImage: "data:image/png;base64,AQID",
    cleanedImageByPage: {
      upper: "data:image/png;base64,VVBQRVI=",
      lower: "data:image/png;base64,TE9XRVI="
    },
    segments: [{
      pageId: "upper", drawRect: { x: 0, y: 0, w: 760, h: 260 },
      sourceCrop: { x: 0, y: 740, w: 760, h: 260 }, naturalWidth: 760, naturalHeight: 1000
    }, {
      pageId: "lower", drawRect: { x: 0, y: 260, w: 760, h: 260 },
      sourceCrop: { x: 0, y: 0, w: 760, h: 260 }, naturalWidth: 760, naturalHeight: 1000
    }],
    bubbles: [{
      canonical_id: "canonical-one", x: 20, y: 35, w: 60, h: 30,
      fill_box: { x: 20, y: 35, w: 60, h: 30 },
      page_text_boxes: [
        { pageId: "upper", x: 20, y: 90, w: 60, h: 10 },
        { pageId: "lower", x: 20, y: 0, w: 60, h: 30 }
      ],
      page_cover_boxes: [
        { pageId: "upper", x: 20, y: 90, w: 60, h: 10 },
        { pageId: "lower", x: 20, y: 0, w: 60, h: 30 }
      ],
      bg_type: "none", translated_text: "完整译文", original_text: "source", source_line_count: 2
    }]
  };
}

test("a wide seam text frame never keeps a near-vertical OCR rotation", () => {
  // 用户缺陷：跨分片接缝里的碎片框被 OCR / 多边形口径判成竖排（rotation_deg≈-90），
  // 渲染侧照它把整块横排译文转 90°，看起来就是「原图明明横排，译文却竖排」。
  globalThis.Element = FakeElement;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.getComputedStyle = element => ({
    position: element.style.position || "static",
    overflow: element.clipOverflow ? "hidden" : "visible",
    overflowX: element.clipOverflow ? "hidden" : "visible",
    overflowY: element.clipOverflow ? "hidden" : "visible",
    clipPath: "none", contain: ""
  });
  globalThis.window = {
    requestAnimationFrame: callback => { globalThis.__crossPageRaf = callback; return 1; },
    cancelAnimationFrame: () => { globalThis.__crossPageRaf = null; }
  };

  const host = new FakeElement("section");
  host.rect = { left: 80, top: 20, width: 800, height: 2100 };
  host.setConnected(true);
  const upper = new FakeElement("img");
  upper.rect = { left: 100, top: 50, width: 760, height: 1000 };
  const lower = new FakeElement("img");
  lower.rect = { left: 100, top: 1074, width: 760, height: 1000 };
  host.appendChild(upper);
  host.appendChild(lower);
  const runtime = createRuntime(new Map([["upper", upper], ["lower", lower]]));
  const surface = makeSurface();
  surface.bubbles = surface.bubbles.map(bubble => ({ ...bubble, rotation_deg: -89.92667552056055 }));

  assert.equal(runtime.renderCrossPageSurfaces([surface]), 1);
  const [overlay] = descendants(host, "mt-cross-page-overlay");
  const [text] = descendants(overlay, "mt-text-layer");
  assert.ok(Number.parseFloat(text.style.width) > Number.parseFloat(text.style.height),
    "fixture must be a wide text frame");
  assert.equal(text.dataset.rotationDeg, "-89.92667552056055");
  assert.match(text.style.transform, /rotate\(0deg\)/u,
    "a wide frame cannot be vertical text: the ±90° OCR rotation must be dropped");
});

test("one cross-page canonical owns one positive DOM overlay across resize and a real page gap", () => {
  globalThis.Element = FakeElement;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.getComputedStyle = element => ({
    position: element.style.position || "static",
    overflow: element.clipOverflow ? "hidden" : "visible",
    overflowX: element.clipOverflow ? "hidden" : "visible",
    overflowY: element.clipOverflow ? "hidden" : "visible",
    clipPath: "none", contain: ""
  });
  globalThis.window = {
    requestAnimationFrame: callback => { globalThis.__crossPageRaf = callback; return 1; },
    cancelAnimationFrame: () => { globalThis.__crossPageRaf = null; }
  };

  const host = new FakeElement("section");
  host.rect = { left: 80, top: 20, width: 800, height: 2100 };
  host.setConnected(true);
  const clippedPageStack = new FakeElement("div");
  clippedPageStack.clipOverflow = true;
  clippedPageStack.rect = { ...host.rect };
  host.appendChild(clippedPageStack);
  const upper = new FakeElement("img");
  upper.rect = { left: 100, top: 50, width: 760, height: 1000 };
  const lower = new FakeElement("img");
  lower.rect = { left: 100, top: 1074, width: 760, height: 1000 };
  clippedPageStack.appendChild(upper);
  clippedPageStack.appendChild(lower);
  const targets = new Map([["upper", upper], ["lower", lower]]);
  const runtime = createRuntime(targets);

  assert.equal(runtime.renderCrossPageSurfaces([makeSurface()]), 1);
  assert.equal(descendants(host, "mt-cross-page-root").length, 1);
  assert.equal(descendants(clippedPageStack, "mt-cross-page-root").length, 0,
    "the root must climb above a clipping common ancestor");
  const [overlay] = descendants(host, "mt-cross-page-overlay");
  assert.ok(overlay);
  assert.equal(descendants(host, "mt-cross-page-overlay").length, 1);
  assert.equal(descendants(upper, "mt-cross-page-overlay").length, 0);
  assert.equal(descendants(lower, "mt-cross-page-overlay").length, 0);
  assert.equal(descendants(host, "mt-seam-window").length, 0);
  assert.ok(Number.parseFloat(overlay.style.left) >= 0);
  assert.ok(Number.parseFloat(overlay.style.top) >= 0);
  const [text] = descendants(overlay, "mt-text-layer");
  const covers = descendants(overlay, "mt-cover-segment");
  assert.equal(covers.length, 2);
  assert.match(covers[0].style.backgroundImage, /AQID/u,
    "a page cover inside the seam capture must prefer the cleaned composite over a stale page artifact");
  assert.match(covers[1].style.backgroundImage, /TE9XRVI=/u,
    "a page cover extending beyond the seam capture must use the full-page cleaned artifact");
  const coverGap = Number.parseFloat(covers[1].style.top) -
    Number.parseFloat(covers[0].style.top) - Number.parseFloat(covers[0].style.height);
  assert.equal(coverGap, 24);
  assert.ok(Number.parseFloat(text.style.height) >
    covers.reduce((sum, node) => sum + Number.parseFloat(node.style.height), 0));
  assert.equal(runtime.layoutCalls, 1);
  const firstWidth = Number.parseFloat(overlay.style.width);
  const firstFontSize = Number.parseFloat(text.style.fontSize);

  upper.rect = { left: 100, top: 50, width: 608, height: 800 };
  lower.rect = { left: 100, top: 874, width: 608, height: 800 };
  runtime.syncCrossPageOverlayGeometry();
  assert.equal(runtime.layoutCalls, 1, "geometry refresh must reuse the single text layout result");
  assert.ok(Number.parseFloat(overlay.style.width) < firstWidth);
  assert.ok(Number.parseFloat(text.style.fontSize) < firstFontSize);
  assert.ok(Number.parseFloat(overlay.style.left) >= 0);
  assert.ok(Number.parseFloat(overlay.style.top) >= 0);

  const refreshedSurface = {
    ...makeSurface(),
    renderKey: "render-two",
    cleanedImage: "data:image/png;base64,UkVGUkVTSEVE"
  };
  runtime.renderCrossPageSurfaces([refreshedSurface]);
  const [refreshedOverlay] = descendants(host, "mt-cross-page-overlay");
  assert.strictEqual(refreshedOverlay, overlay,
    "a new cleaned artifact for the same seam must update the existing DOM");
  assert.equal(descendants(host, "mt-cross-page-overlay").length, 1);
  assert.equal(runtime.state.crossPageOverlaysByRenderKey.has("render-one"), false);
  assert.equal(runtime.state.crossPageOverlaysByRenderKey.has("render-two"), true);
  assert.equal(text.dataset.seamRenderKey, "render-two",
    "the reused clickable text node must follow the current render key");
  runtime.toggleSeamSourceMode(text.dataset.seamRenderKey);
  assert.equal(refreshedOverlay.classList.contains("mt-show-source"), true,
    "the refreshed overlay must still switch to its source image");
  runtime.toggleSeamSourceMode(text.dataset.seamRenderKey);
  assert.equal(refreshedOverlay.classList.contains("mt-show-source"), false);
  assert.match(descendants(refreshedOverlay, "mt-cover-segment")[0].style.backgroundImage,
    /UkVGUkVTSEVE/u);
});

function setupDom() {
  globalThis.Element = FakeElement;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.getComputedStyle = element => ({
    position: element.style.position || "static",
    overflow: element.clipOverflow ? "hidden" : "visible",
    overflowX: element.clipOverflow ? "hidden" : "visible",
    overflowY: element.clipOverflow ? "hidden" : "visible",
    clipPath: "none", contain: ""
  });
  globalThis.window = {
    requestAnimationFrame: callback => { globalThis.__crossPageRaf = callback; return 1; },
    cancelAnimationFrame: () => { globalThis.__crossPageRaf = null; }
  };
}

function makeHostStack() {
  const host = new FakeElement("section");
  host.rect = { left: 80, top: 20, width: 800, height: 2100 };
  host.setConnected(true);
  const upper = new FakeElement("img");
  upper.rect = { left: 100, top: 50, width: 760, height: 1000 };
  const lower = new FakeElement("img");
  lower.rect = { left: 100, top: 1074, width: 760, height: 1000 };
  host.appendChild(upper);
  host.appendChild(lower);
  return { host, targets: new Map([["upper", upper], ["lower", lower]]) };
}

test("a reused seam surface refreshes its text node when the canonical text changes", () => {
  // 用户缺陷：surface 复用时只换 item.bubble，DOM 里的原文停留在上一版 → 译文中只有半句
  // 对得上、data-original 还是接缝合并前的旧片段。
  setupDom();
  const { host, targets } = makeHostStack();
  const runtime = createRuntime(targets);
  const firstSurface = { ...makeSurface(), layoutKey: "layout-one" };
  runtime.renderCrossPageSurfaces([firstSurface]);
  const [textBefore] = descendants(host, "mt-text-layer");
  assert.equal(textBefore.dataset.original, "source");

  // 同一 canonical、同一译文，只有原文/行数变化：走复用路径。
  const nextBubbles = firstSurface.bubbles.map(bubble => ({
    ...bubble,
    original_text: "그림 속에서 아주 많은 일을 해낼 수 있습니다.",
    source_line_count: 3
  }));
  const sameTextSurface = { ...firstSurface, renderKey: "render-two", layoutKey: "layout-two", bubbles: nextBubbles };
  runtime.renderCrossPageSurfaces([sameTextSurface]);
  const [textAfter] = descendants(host, "mt-text-layer");
  assert.notEqual(textAfter, textBefore, "changed canonical text must rebuild the text node");
  assert.equal(textAfter.dataset.original, "그림 속에서 아주 많은 일을 해낼 수 있습니다.");
  assert.equal(textAfter.dataset.sourceLineCount, "3");
  assert.equal(descendants(host, "mt-text-layer").length, 1, "the stale node must be removed");

  // 文本没变时不得重建（避免每次 refresh 都换节点）。
  runtime.renderCrossPageSurfaces([{ ...sameTextSurface, renderKey: "render-three" }]);
  const [textStable] = descendants(host, "mt-text-layer");
  assert.equal(textStable, textAfter, "unchanged text must keep the same node");
});

test("一次遮罩同时跨带内带外时，带内用复合清理图、带外用整页清理图", () => {
  setupDom();
  const runtime = createRuntime(new Map());
  const overlay = new FakeElement("div");
  const coverLayer = new FakeElement("div");
  overlay.appendChild(coverLayer);
  const item = {
    overlay,
    coverLayer,
    coverNodes: new Map(),
    bubble: { bg_type: "none" },
    textNode: null
  };
  const entry = {
    surface: {
      cleanedImage: "data:image/png;base64,Q09NUE9TSVRF",
      cleanedImageByPage: { upper: "data:image/png;base64,VVBQRVI=" },
      canvasWidth: 760,
      canvasHeight: 520
    }
  };
  const inBand = {
    pageId: "upper", left: 0, top: 30, width: 200, height: 40, mapping: "page",
    pageWidth: 760, pageHeight: 1000, sourceLeft: 300, sourceTop: 930, scaleX: 1, scaleY: 1,
    compositeIntersection: { left: 0, top: 200, width: 760, height: 80 }
  };
  const outOfBand = {
    pageId: "upper", left: 0, top: 0, width: 200, height: 30, mapping: "page",
    pageWidth: 760, pageHeight: 1000, sourceLeft: 300, sourceTop: 900, scaleX: 1, scaleY: 1,
    compositeIntersection: null
  };
  runtime.updateCoverSegments(entry, item, { coverTilted: false, coverSegments: [inBand, outOfBand] }, {});
  const node = item.coverNodes.get("upper");
  assert.match(node.style.backgroundImage, /Q09NUE9TSVRF/u, "composite layer must be present");
  assert.match(node.style.backgroundImage, /VVBQRVI=/u, "page artifact layer must be present");
  assert.ok(node.style.backgroundImage.indexOf("Q09NUE9TSVRF") < node.style.backgroundImage.indexOf("VVBQRVI="),
    "the composite must be the topmost layer so it wins inside the capture band");
  assert.match(node.style.backgroundSize, /, /u);
  assert.match(node.style.backgroundPosition, /, /u);
  // 复合补丁的原点按带内段自己的元素位置还原：带外那段(top 0)比带内段(top 30)高 30px，
  // 复合图必须整体下移 30px，否则清理补丁落在原文上方，接缝处原文会露出来。
  assert.equal(node.style.backgroundPosition, "0px -170px, -300px -900px",
    "composite layer must be anchored to the in-band segment, not to the node origin");

  // 整段都在带内时仍然只用复合清理图（不要退回可能过期的整页图）。
  // 节点原点非零（下片遮罩从接缝下方开始）时，复合图原点必须减掉节点自身偏移，
  // 否则 no-repeat 会在节点顶部留下一条没有像素的空白 —— 原文在那里露出来。
  const lowerBand = {
    ...inBand,
    left: 41,
    top: 75.672,
    compositeIntersection: { left: 0, top: 96, width: 760, height: 80 }
  };
  runtime.updateCoverSegments(entry, item, { coverTilted: false, coverSegments: [lowerBand] }, {});
  const single = item.coverNodes.get("upper");
  assert.match(single.style.backgroundImage, /Q09NUE9TSVRF/u);
  assert.doesNotMatch(single.style.backgroundImage, /VVBQRVI=/u);
  assert.doesNotMatch(single.style.backgroundSize, /, /u);
  assert.equal(single.style.backgroundPosition, "0px -96px",
    "the composite origin must be relative to the cover node, not to the overlay root");
  const [singleX, singleY] = single.style.backgroundPosition.split(" ").map(Number.parseFloat);
  assert.ok(singleX <= 0 && singleY <= 0,
    "a composite-only cover must start at or above/left of the node origin, otherwise a strip stays unmasked");
});
