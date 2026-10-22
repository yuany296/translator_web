import assert from "node:assert/strict";
import test from "node:test";
import { installSceneCrossPage } from "../extension/src/content/modules/scene-crosspage.js";
import { installCrossPageCover } from "../extension/src/content/modules/crosspage-cover.js";
import { installRendererCrossPage } from "../extension/src/content/modules/renderer-crosspage.js";
import { installCrossPageLifecycle } from "../extension/src/content/modules/crosspage-lifecycle.js";
import { installLifecycleCover } from "../extension/src/content/modules/lifecycle-cover.js";
import { resolveTiltRotationDeg } from "../extension/src/rendering/cover-geometry.js";

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

/** 与生产同源：lifecycle-cover → cover-geometry，只把 clamp/多边形归一化补上。 */
function installCoverGeometry(runtime) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  runtime.clamp = clamp;
  runtime.normalizeBubblePolygon = (value, allowOverflow) => {
    if (!Array.isArray(value) || value.length < 4) return null;
    const points = value.slice(0, 4).map(point => {
      const rawY = Number(point && point.y);
      return { x: clamp(Number(point && point.x), 0, 100), y: allowOverflow ? rawY : clamp(rawY, 0, 100) };
    });
    return points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)) ? points : null;
  };
  runtime.resolveBubblePolygonBox = (value, allowOverflow) => {
    const polygon = runtime.normalizeBubblePolygon(value, allowOverflow);
    if (!polygon) return null;
    const xs = polygon.map(point => point.x);
    const ys = polygon.map(point => point.y);
    const [left, right] = [Math.min(...xs), Math.max(...xs)];
    const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
    return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
  };
  runtime.normalizeFillBox = value => {
    if (!value) return null;
    const x = Number(value.x);
    const y = Number(value.y);
    const w = Number(value.w ?? value.width);
    const h = Number(value.h ?? value.height);
    return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
  };
  runtime.resolveBubbleRotation = bubble => {
    const visual = bubble && bubble.visual || {};
    const explicit = Number((bubble && (bubble.rotation_deg ?? bubble.rotationDeg))
      ?? (visual.rotation_deg ?? visual.rotationDeg));
    return resolveTiltRotationDeg(explicit, [bubble && bubble.polygon, bubble && bubble.region_polygon], 1, 1);
  };
  runtime.state.coverPadding = 0.2;
  installLifecycleCover(runtime);
}

function createRuntime(targets) {
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
        w: Number(value && (value.w ?? value.width) || 0), h: Number(value && (value.h ?? value.height) || 0)
      };
    },
    resolveBubbleCoverBox: bubble => bubble.fill_box || bubble,
    projectionToRendererBubble: bubble => ({ ...bubble }),
    normalizeBgType: value => String(value || "none"),
    cleanRenderableText: value => String(value || "").trim(),
    hasRenderableOcrDebug: () => false,
    getTargetForKakaoPageId: pageId => targets.get(pageId),
    fitBubbleFontSize: () => 20,
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
      node.dataset.seamRenderKey = String(options.seamRenderKey || "");
      node.textContent = bubble.translated_text;
      return node;
    }
  };
  installSceneCrossPage(runtime);
  installCrossPageCover(runtime);
  installRendererCrossPage(runtime);
  installCrossPageLifecycle(runtime);
  installCoverGeometry(runtime);
  return runtime;
}

/** 现场几何（Chrome 实测）：KakaoPage 分片阅读器，页 760×1000 显示为 720×947，上下相接。 */
function setupDom() {
  globalThis.Element = FakeElement;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.getComputedStyle = () => ({
    position: "static", overflow: "visible", overflowX: "visible", overflowY: "visible", clipPath: "none", contain: ""
  });
  globalThis.window = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {}
  };
  const host = new FakeElement("section");
  host.rect = { left: 580, top: -556, width: 720, height: 200000 };
  host.setConnected(true);
  const upper = new FakeElement("img");
  upper.rect = { left: 580, top: -556, width: 720, height: 947 };
  const lower = new FakeElement("img");
  lower.rect = { left: 580, top: 391.5, width: 720, height: 947 };
  host.appendChild(upper);
  host.appendChild(lower);
  return { host, targets: new Map([["page-upper", upper], ["page-lower", lower]]) };
}

function makeSeamSurface(bubble) {
  return {
    renderKey: "seam-render-v1:43b4b8b1",
    layoutKey: "seam-layout-v1",
    canvasWidth: 760,
    canvasHeight: 192,
    pageIds: ["page-upper", "page-lower"],
    cleanedImage: null,
    cleanedImageByPage: {},
    segments: [{
      pageId: "page-upper", drawRect: { x: 0, y: 0, w: 760, h: 96 },
      sourceCrop: { x: 0, y: 904, w: 760, h: 96 }, naturalWidth: 760, naturalHeight: 1000
    }, {
      pageId: "page-lower", drawRect: { x: 0, y: 96, w: 760, h: 96 },
      sourceCrop: { x: 0, y: 0, w: 760, h: 96 }, naturalWidth: 760, naturalHeight: 1000
    }],
    bubbles: [bubble]
  };
}

const PAGE_TEXT_BOXES = [
  { pageId: "page-upper", x: 60.42, y: 92.39, w: 24.08, h: 7.7 },
  { pageId: "page-lower", x: 60.42, y: 0.05, w: 24.08, h: 0.7 }
];

function clipAreaRatio(node) {
  const raw = String(node.style.clipPath || "");
  const numbers = raw.match(/-?[0-9.]+/gu);
  if (!numbers || numbers.length < 6) return 0;
  const width = Number.parseFloat(node.style.width);
  const height = Number.parseFloat(node.style.height);
  const points = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: Number(numbers[index]) / 100 * width, y: Number(numbers[index + 1]) / 100 * height });
  }
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2 / (width * height);
}

test("跨页遮罩的裁剪结果不得被截断成 4 个顶点（现场：交集 87% 被画成 14% 的楔形）", () => {
  // 现场（KakaoPage 跨页气泡）：`bubble.polygon` 与遮罩段的交集是多边形 ——
  // Sutherland–Hodgman 最多 8 个顶点 —— 而 `polygonClipPathPercent` 当时走
  // `normalizePoints` 按四边形切到前 4 个：不相邻的顶点被连成一条并不存在的边，
  // 画出来只剩贴左边的一条楔形（实测交集 0.87、画出的只有 0.14），
  // 韩文原文整段露在译文下面（用户截图「不知道为什么这里没有盖板」）。
  // 现场四边形：由 upper/lower 两段真实 clip 反解得出（误差 < 1px，canvas 百分比）。
  const liveQuad = [
    { x: 53.11, y: 11.61 }, { x: 75.61, y: 10.26 },
    { x: 99.76, y: 88.91 }, { x: 61.26, y: 53.28 }
  ];
  const { host, targets } = setupDom();
  const runtime = createRuntime(targets);
  const surface = makeSeamSurface({
    canonical_id: "canonical-kakao", rotation_deg: -0.9, bg_type: "solid", bg_color: "#ffffff",
    x: 61.1, y: 10.9, w: 22.5, h: 41.7,
    fill_box: { x: 61.1, y: 10.9, w: 22.5, h: 41.7 },
    polygon: liveQuad,
    page_text_boxes: PAGE_TEXT_BOXES,
    page_cover_boxes: PAGE_TEXT_BOXES,
    original_text: "일단바닥에 늙히시는게", translated_text: "目前，你最好就让他躺在地板上慢慢变老吧。",
    source_line_count: 2
  });

  assert.equal(runtime.renderCrossPageSurfaces([surface]), 1);
  const covers = descendants(host, "mt-cover-segment");
  assert.equal(covers.length, 2);
  const upperCover = covers.find(node => node.dataset.pageId === "page-upper");
  assert.equal(upperCover.dataset.coverTilted, "true");
  const drawn = String(upperCover.style.clipPath || "");
  const vertexCount = (drawn.match(/%/gu) || []).length / 2;
  assert.ok(vertexCount > 4, `交集多于 4 个顶点时必须全部保留，实际 ${vertexCount} 个顶点：${drawn}`);
  assert.ok(clipAreaRatio(upperCover) > 0.8,
    `画出来的裁剪必须覆盖交集的绝大部分（盖住原文是底线），实际 ${clipAreaRatio(upperCover).toFixed(3)}`);
  covers.forEach(node => assert.equal(node.style.background, "#ffffff", "量到颜色就必须遮住原文"));
});

test("斜排裁剪仍然保留：四边形与遮罩段交集够大时照旧裁剪", () => {
  // 同一气泡、同一文字框，但四边形真的斜（+8°）：必须继续按字形裁剪。
  const deg = 8 * Math.PI / 180;
  const base = [[60.42, 10.4], [84.5, 10.4], [84.5, 53.6], [60.42, 53.6]];
  const cx = 71;
  const cy = 32;
  const tilted = base.map(([x, y]) => {
    const dx = (x - cx) / 100 * 760;
    const dy = (y - cy) / 100 * 192;
    return {
      x: (dx * Math.cos(deg) - dy * Math.sin(deg)) / 760 * 100 + cx,
      y: (dx * Math.sin(deg) + dy * Math.cos(deg)) / 192 * 100 + cy
    };
  });
  const { host, targets } = setupDom();
  const runtime = createRuntime(targets);
  const surface = makeSeamSurface({
    canonical_id: "canonical-tilted-ok", rotation_deg: 8, bg_type: "solid", bg_color: "#ffffff",
    x: 60.42, y: 10.4, w: 24.08, h: 43.2,
    fill_box: { x: 60.42, y: 10.4, w: 24.08, h: 43.2 },
    polygon: tilted,
    page_text_boxes: PAGE_TEXT_BOXES,
    page_cover_boxes: PAGE_TEXT_BOXES,
    original_text: "斜排 SFX", translated_text: "斜排", source_line_count: 1
  });

  assert.equal(runtime.renderCrossPageSurfaces([surface]), 1);
  const upperCover = descendants(host, "mt-cover-segment").find(node => node.dataset.pageId === "page-upper");
  assert.equal(upperCover.dataset.coverTilted, "true", "真斜排仍要裁剪");
  assert.match(String(upperCover.style.clipPath), /^polygon\(/u);
  assert.ok(clipAreaRatio(upperCover) > 0.8, "真斜排的裁剪也要盖得住字形");
});
