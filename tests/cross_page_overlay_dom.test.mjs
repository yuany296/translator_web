import assert from "node:assert/strict";
import test from "node:test";
import { installSceneCrossPage } from "../extension/src/content/modules/scene-crosspage.js";
import { installRendererCrossPage } from "../extension/src/content/modules/renderer-crosspage.js";

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
    createBubbleNode(bubble) {
      const node = new FakeElement("div");
      node.className = "mt-bubble mt-text-layer";
      node.classList.add("mt-bubble", "mt-text-layer");
      node.dataset.alignment = bubble.alignment || "center";
      node.dataset.rotationDeg = String(bubble.rotation_deg || 0);
      node.dataset.sourceLineCount = String(bubble.source_line_count || 1);
      node.textContent = bubble.translated_text;
      return node;
    },
    get layoutCalls() { return layoutCalls; }
  };
  installSceneCrossPage(runtime);
  installRendererCrossPage(runtime);
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
      bg_type: "none", translated_text: "完整译文", original_text: "source", source_line_count: 2
    }]
  };
}

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
});
