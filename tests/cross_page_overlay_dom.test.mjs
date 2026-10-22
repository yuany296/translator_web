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

test("跨页实底遮罩：量到颜色就按这一页的遮罩段矩形整块遮住，只有没采到色才透明", () => {
  // 现场（`게임 속에서` 那句）：接缝复合图只读到气泡的第一行、页级 OCR 读到两行，
  // 于是 page_cover_boxes 是两行的并集、bubble.polygon 只有第一行。上一轮把"实底必须按
  // 四边形裁"写成硬规则 → 遮罩被裁成第一行那一条，第二行原文裸露。
  // 定稿口径：颜色是硬条件；覆盖范围 = 这一页自己的遮罩段矩形（按页映射的并集），
  // 只有「斜排原文」（coverTilted）才额外按字形四边形修剪。
  setupDom();
  const runtime = createRuntime(new Map());
  const surface = makeSurface();
  const entry = { surface };
  const buildItem = bubble => {
    const overlay = new FakeElement("div");
    const coverLayer = new FakeElement("div");
    overlay.appendChild(coverLayer);
    return { overlay, coverLayer, coverNodes: new Map(), bubble, textNode: null };
  };
  // 拼接图百分比坐标下的气泡轮廓；映射后落在 upper 页的遮罩段矩形内。
  const polygon = [{ x: 20, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 12 }, { x: 20, y: 12 }];
  const segment = {
    pageId: "upper", left: 150, top: 750, width: 520, height: 120, mapping: "page",
    pageWidth: 760, pageHeight: 1000, sourceLeft: 100, sourceTop: 900, scaleX: 1, scaleY: 1
  };
  const context = {
    targetRects: new Map([
      ["upper", { left: 100, top: 50, width: 760, height: 1000 }],
      ["lower", { left: 100, top: 1074, width: 760, height: 1000 }]
    ]),
    rootRect: { left: 80, top: 20, width: 800, height: 2100 }
  };
  const geometry = (bubble, coverQuad) => ({ coverTilted: false, coverQuad, coverSegments: [segment] });

  // 没采样到颜色：绝不兜底 rgba(255,255,255,.96)，保持透明。
  const noColor = buildItem({ bg_type: "solid", bg_color: "", polygon });
  runtime.updateCoverSegments(entry, noColor, geometry(noColor.bubble, polygon), context);
  assert.equal(noColor.coverNodes.get("upper").style.background, "transparent");

  // 有颜色 + 轴对齐（哪怕四边形只覆盖其中一行）：整块矩形上色，绝不裁剪。
  const solid = buildItem({ bg_type: "solid", bg_color: "#ffffff", polygon });
  runtime.updateCoverSegments(entry, solid, geometry(solid.bubble, polygon), context);
  const solidNode = solid.coverNodes.get("upper");
  assert.equal(solidNode.style.background, "#ffffff");
  assert.equal(solidNode.style.clipPath, undefined, "轴对齐文字不按四边形裁（会砍掉同一气泡的其它行）");
  assert.equal(solidNode.dataset.coverTilted, "false");

  // 缺少坐标映射（拿不到 targetRects/rootRect）：仍然必须遮住原文。
  const unmapped = buildItem({ bg_type: "solid", bg_color: "#ffffff", polygon });
  runtime.updateCoverSegments(entry, unmapped, geometry(unmapped.bubble, polygon), {});
  assert.equal(unmapped.coverNodes.get("upper").style.background, "#ffffff");
});

test("斜排跨页遮罩的裁剪必须先把 root 坐标平移到覆盖层局部坐标（否则四边形永远裁不出交集）", () => {
  // 现场：`mapCompositePointToRoot` 返回 root 坐标，而节点矩形是覆盖层局部坐标 ——
  // 少了这一步平移，映射点与节点矩形完全不相交（现场 root≈3570 vs 局部 0~82），
  // clip 恒为空：斜排跨页遮罩从来没真正裁过。
  setupDom();
  const runtime = createRuntime(new Map());
  const surface = makeSurface();
  const entry = { surface };
  // 斜排：首边 -8/50 弧度 ≈ -9.09°（与 overlay_tilt 同一枚现场四边形）。
  const tiltedQuad = [{ x: 20, y: 0 }, { x: 76, y: -1.6 }, { x: 76.4, y: 10 }, { x: 20.4, y: 11.6 }];
  // 映射结果（root）：x 252~712、y 3550~3622；覆盖层原点 (252,3560) → 局部 0~460 / -10~62。
  const segment = {
    pageId: "upper", left: 0, top: 0, width: 460, height: 70, mapping: "page",
    pageWidth: 760, pageHeight: 1000, sourceLeft: 100, sourceTop: 900, scaleX: 1, scaleY: 1
  };
  const targetRects = new Map([
    ["upper", { left: 100, top: 2820, width: 760, height: 1000 }],
    ["lower", { left: 100, top: 3844, width: 760, height: 1000 }]
  ]);
  const rootRect = { left: 0, top: 0, width: 800, height: 4000 };
  const buildItem = () => {
    const overlay = new FakeElement("div");
    const coverLayer = new FakeElement("div");
    overlay.appendChild(coverLayer);
    return { overlay, coverLayer, coverNodes: new Map(), bubble: { bg_type: "none" }, textNode: null };
  };
  const geometry = outer => ({ coverTilted: true, coverQuad: tiltedQuad, coverSegments: [segment], outer });

  const shifted = buildItem();
  runtime.updateCoverSegments(entry, shifted, geometry({ left: 252, top: 3560, width: 460, height: 70 }),
    { targetRects, rootRect });
  const shiftedNode = shifted.coverNodes.get("upper");
  assert.equal(shiftedNode.dataset.coverTilted, "true", "平移后应当裁得出四边形");
  assert.match(String(shiftedNode.style.clipPath), /^polygon\(/u);

  // 对照：同一份映射结果、同一份节点矩形，只是缺 outer（⇒ 不做平移）→ 裁不出交集。
  const unshifted = buildItem();
  runtime.updateCoverSegments(entry, unshifted, geometry(null), { targetRects, rootRect });
  assert.equal(unshifted.coverNodes.get("upper").dataset.coverTilted, "false");
});

test("文字像素不在上一页时不再产生上一页的遮罩段，跨页外框只剩文字页", () => {
  // 用户缺陷：气泡轮廓越过分页线、文字全在下一页，跨页 overlay 却因为「上一页也有遮罩段」
  // 把外框（.mt-cross-page-debug 的蓝框）撑到两页，上一页还多出一块遮罩。
  // canonical 层收窄后（见 canonical_render_plan / kakao_reconciler 的 span 声明用例），
  // page_cover_boxes / page_text_boxes 里只剩文字所在页。
  setupDom();
  const { host, targets } = makeHostStack();
  const runtime = createRuntime(targets);
  const surface = makeSurface();
  const [baseBubble] = surface.bubbles;
  const textOnlyLower = { pageId: "lower", x: 20, y: 0, w: 60, h: 30 };
  assert.equal(runtime.renderCrossPageSurfaces([{
    ...surface,
    bubbles: [{
      ...baseBubble,
      page_text_boxes: [textOnlyLower],
      page_cover_boxes: [textOnlyLower]
    }]
  }]), 1);

  const [overlay] = descendants(host, "mt-cross-page-overlay");
  const covers = descendants(overlay, "mt-cover-segment");
  assert.equal(covers.length, 1, "没有文字像素的那一页不得再有遮罩段");
  assert.equal(covers[0].dataset.pageId, "lower");
  // 外框（root 坐标系）不再向上一页长出：视口顶边落在下一页顶边（1074）或之下。
  const overlayTopInViewport = 20 + Number.parseFloat(overlay.style.top);
  assert.ok(overlayTopInViewport >= 1074 - 1,
    `跨页外框不该再跨到上一页：viewport top=${overlayTopInViewport}`);
});

/** 新用例专用：把真遮罩几何装上（lifecycle-cover → cover-geometry，与生产同源）。 */
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
  // 与生产同口径：DOM 覆盖层不带像素比例（percent 空间），跨页路径显式传拼接图长宽。
  runtime.resolveBubbleRotation = bubble => {
    const visual = bubble && bubble.visual || {};
    const explicit = Number((bubble && (bubble.rotation_deg ?? bubble.rotationDeg))
      ?? (visual.rotation_deg ?? visual.rotationDeg));
    return resolveTiltRotationDeg(explicit, [bubble && bubble.polygon, bubble && bubble.region_polygon], 1, 1);
  };
  runtime.state.coverPadding = 0.2;
  installLifecycleCover(runtime);
}

/** 现场（Lezhin 53 话）的拼接图坐标：1280×192，上下各 96px 带，页图 1280×1952。 */
function makeLiveSeamSurface(polygon) {
  const bubble = {
    canonical_id: "canonical-live", x: 51.97, y: 38.25, w: 23.41, h: 36,
    fill_box: { x: 51.97, y: 38.25, w: 23.41, h: 36 },
    polygon,
    rotation_deg: -0.2,
    bg_type: "solid",
    bg_color: "#fefefe",
    page_text_boxes: [
      { pageId: "upper", x: 51.97, y: 98.84, w: 23.41, h: 1.16 },
      { pageId: "lower", x: 48.99, y: 0, w: 29.33, h: 13.21 }
    ],
    page_cover_boxes: [
      { pageId: "upper", x: 51.97, y: 98.84, w: 23.41, h: 1.16 },
      { pageId: "lower", x: 48.99, y: 0, w: 29.33, h: 13.21 }
    ],
    original_text: "신싸로 올리버가 그쪽 조직원이었으면 뒷감당은어쩌려고 그랬대요?",
    translated_text: "听说新沙洞的奥利弗要是那边组织的人，你打算怎么收场才那么干的？",
    source_line_count: 4
  };
  return {
    renderKey: "seam-live", layoutKey: "seam-live",
    canvasWidth: 1280, canvasHeight: 192, pageIds: ["upper", "lower"],
    cleanedImage: "data:image/png;base64,AQID", cleanedImageByPage: {},
    segments: [{
      pageId: "upper", drawRect: { x: 0, y: 0, w: 1280, h: 96 },
      sourceCrop: { x: 0, y: 1856, w: 1280, h: 96 }, naturalWidth: 1280, naturalHeight: 1952
    }, {
      pageId: "lower", drawRect: { x: 0, y: 96, w: 1280, h: 96 },
      sourceCrop: { x: 0, y: 0, w: 1280, h: 96 }, naturalWidth: 1280, naturalHeight: 1952
    }],
    bubbles: [bubble]
  };
}

/** 把像素空间的四边形绕中心转 deg 度再换算成百分比（构造"真斜排"对照）。 */
function rotatePolygonInPixels(points, canvasWidth, canvasHeight, deg) {
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const radians = deg * Math.PI / 180;
  return points.map(point => {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    return {
      x: (centerX + dx * Math.cos(radians) - dy * Math.sin(radians)) / canvasWidth * 100,
      y: (centerY + dx * Math.sin(radians) + dy * Math.cos(radians)) / canvasHeight * 100
    };
  });
}

test("跨页遮罩的斜排判定必须带拼接图长宽：0.2° 像素微倾不得把下页遮罩裁到只剩顶部", () => {
  // 现场（Lezhin 53 话）：拼接图 1280×192 把文字框横边的 0.2° 像素微倾放大成 1.36°
  // （见 cover-geometry.js#polygonTiltDeg）→ 判成斜排 → 下页遮罩（页级 OCR 读到 4 行、
  // 高 258px）被只覆盖接缝带那一行的四边形裁到只剩顶部 ~26px，其余原文裸露
  // （用户症状「下面那页只有一部分背景」）。跨页路径必须把 canvasWidth×canvasHeight
  // 传进 resolveBubbleCoverGeometry，让判定落在像素空间。
  setupDom();
  const host = new FakeElement("section");
  host.rect = { left: 0, top: -25966, width: 1280, height: 79208 };
  host.setConnected(true);
  const upper = new FakeElement("img");
  upper.rect = { left: 158.67, top: -657.11, width: 720, height: 1098 };
  const lower = new FakeElement("img");
  lower.rect = { left: 158.67, top: 440.89, width: 720, height: 1098 };
  host.appendChild(upper);
  host.appendChild(lower);
  const runtime = createRuntime(new Map([["upper", upper], ["lower", lower]]));
  installCoverGeometry(runtime);

  const livePolygon = [
    { x: 52.72, y: 40.1 }, { x: 74.61, y: 39.58 },
    { x: 74.63, y: 72.92 }, { x: 52.73, y: 73.44 }
  ];
  assert.equal(runtime.renderCrossPageSurfaces([makeLiveSeamSurface(livePolygon)]), 1);
  const nearAxisCovers = descendants(host, "mt-cover-segment");
  assert.equal(nearAxisCovers.length, 2);
  const lowerCover = nearAxisCovers.find(node => node.dataset.pageId === "lower");
  assert.equal(lowerCover.dataset.coverTilted, "false", "0.2° 像素微倾不是斜排");
  assert.equal(lowerCover.style.clipPath, undefined, "不裁剪：遮罩必须整块盖住这一页的 4 行原文");
  assert.ok(Number.parseFloat(lowerCover.style.height) > 100,
    `下页遮罩应覆盖整段文字（实测 145px），实际 ${lowerCover.style.height}`);

  // 对照：同一形状在像素空间真的转 3° → 仍按斜排裁剪（该能力不能修没）。
  const pixelPolygon = livePolygon.map(point => ({ x: point.x / 100 * 1280, y: point.y / 100 * 192 }));
  const tiltedSurface = {
    ...makeLiveSeamSurface(rotatePolygonInPixels(pixelPolygon, 1280, 192, 3)),
    renderKey: "seam-tilted", layoutKey: "seam-tilted"
  };
  runtime.renderCrossPageSurfaces([tiltedSurface]);
  const tiltedCovers = descendants(host, "mt-cover-segment");
  const tiltedLower = tiltedCovers.find(node => node.dataset.pageId === "lower");
  assert.equal(tiltedLower.dataset.coverTilted, "true", "真正的斜排仍要裁剪");
  assert.match(String(tiltedLower.style.clipPath), /^polygon\(/u);
});
