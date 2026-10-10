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
const { polygonRotationDeg } = await import("../extension/src/rendering/cover-geometry.js");
const { reconciler: R } = await import("../extension/src/canonical/reconciler.js");

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
  // 遮罩盒子必须仍是识别到的文字框大小（10..62 × 12..38），
  // 不能撑成「旋转整个外接框」的包围盒（那正是用户看到的「覆盖层太大」）。
  assert.equal(Number.parseFloat(clipNode.style.width), 52);
  assert.equal(Number.parseFloat(clipNode.style.height), 26);
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
    resolveBubbleRotation: T.resolveBubbleRotation,
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

  // 同一现场的另一半：倾角只在区域轮廓（region_polygon）上、顶层文字框轴对齐时，
  // 画布同样必须 rotate，否则「覆盖层没有根据倾斜的文本进行倾斜」会换个入口复现。
  calls.length = 0;
  runtime.drawEmbeddedBubbles(ctx, 1000, 1000, [
    makeBubble({ polygon: axisAlignedPolygon, region_polygon: polygonRegionTilted })
  ], {});
  const regionOnlyRotate = calls.find(call => call[0] === "rotate");
  assert.ok(regionOnlyRotate, "区域轮廓倾斜时画布必须执行 rotate");
  assert.ok(Math.abs(regionOnlyRotate[1] - (-9.090276920822323) * Math.PI / 180) < 1e-3,
    `区域轮廓倾角应接近 -9.09°，实际 ${regionOnlyRotate[1]}`);
});

// 「文字框轴对齐、只有区域轮廓倾斜」是同一缺陷的另一种现场：OCR 把倾角留在
// region_polygon（气泡/区域轮廓）上，而顶层 polygon 是轴对齐框或干脆没有。
const axisAlignedPolygon = [{ x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 30 }, { x: 10, y: 30 }];
const polygonRegionTilted = [{ x: 10, y: 20 }, { x: 60, y: 12 }, { x: 60, y: 30 }, { x: 10, y: 38 }];

test("嵌入式画布实底遮罩：量到颜色就必须遮住原文，只有没采到色才不画", () => {
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
        x: Number(value.x ?? value.left) / 100 * canvasWidth,
        y: Number(value.y ?? value.top) / 100 * canvasHeight,
        w: Number(value.w ?? value.width) / 100 * canvasWidth,
        h: Number(value.h ?? value.height) / 100 * canvasHeight
      };
      return Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0 ? box : null;
    },
    getEmbeddedPolygonGeometry: () => null,
    unionRenderBoxes: (left, right) => right || left,
    getDynamicStrokeWidth: size => size * 0.1,
    resolveBubbleRotation: T.resolveBubbleRotation,
    resolveBubbleCoverGeometry: T.resolveBubbleCoverGeometry,
    drawFittedText: () => {}
  };
  installRendererEmbed(runtime);

  let fillStyle = "";
  const fills = [];
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (prop === "fillRect") return (...args) => fills.push({ fillStyle, args });
      if (prop === "measureText") return () => ({ width: 0 });
      return () => {};
    },
    set(_target, prop, value) {
      if (prop === "fillStyle") fillStyle = String(value);
      return true;
    }
  });

  // 没有轮廓：退回本气泡的填充盒，仍然要遮住原文（形状不完美 ≠ 放弃遮盖）。
  runtime.drawEmbeddedBubbles(ctx, 1000, 1000, [makeBubble({ polygon: null, bg_color: "#ffffff" })], {});
  assert.equal(fills.length, 1, "有采样色时不得整块不画");
  assert.equal(fills[0].fillStyle, "#ffffff");

  // 没采样到颜色：不得兜底纯白 → 一个像素都不画。
  fills.length = 0;
  runtime.drawEmbeddedBubbles(ctx, 1000, 1000, [makeBubble({ bg_color: "" })], {});
  assert.equal(fills.length, 0, "没有采样色时不得兜底纯白");

  // 轮廓 + 采样色齐全：按轮廓裁剪后填色。
  fills.length = 0;
  runtime.drawEmbeddedBubbles(ctx, 1000, 1000, [makeBubble()], {});
  assert.equal(fills.length, 1);
  assert.equal(fills[0].fillStyle, "#ffffff");
});

test("DOM 译文节点：倾角只在 region_polygon 上时也要倾斜", () => {
  for (const polygon of [null, axisAlignedPolygon]) {
    const node = T.createBubbleNode(makeBubble({ polygon, region_polygon: polygonRegionTilted }), 0);
    assert.ok(node, "应创建译文节点");
    assert.equal(Number(node.dataset.rotationDeg).toFixed(2), "-9.09", `polygon=${JSON.stringify(polygon)}`);
    assert.match(node.style.getPropertyValue("--mt-base-transform"), /rotate\(-9\.09deg\)/u);
  }
});

test("DOM 译文节点：visual 里的同义倾角字段同样认", () => {
  for (const visual of [{ rotationDeg: -9.09 }, { rotation_deg: -9.09 }]) {
    const node = T.createBubbleNode(makeBubble({ polygon: null, visual }), 0);
    assert.equal(Number(node.dataset.rotationDeg).toFixed(2), "-9.09", JSON.stringify(visual));
  }
});

test("遮罩裁剪层：倾角只在 region_polygon 上时也倾斜", () => {
  const bubble = makeBubble({ polygon: null, region_polygon: polygonRegionTilted });
  assert.equal(T.resolveBubbleCoverGeometry(bubble).tilted, true);
});

test("实底填充：量到颜色就必须遮住原文，只有没采到色才透明", () => {
  // 没有轮廓时仍要遮：退回元素盒（本页的最终蓝框），绝不让原文裸露。
  const boxOnly = T.createBubbleNode(makeBubble({ polygon: null }), 0);
  assert.equal(boxOnly.classList.contains("mt-fill-unbounded"), false);
  assert.equal(boxOnly.style.getPropertyValue("--mt-region-clip"), "", "没有轮廓就不写形状裁剪");

  // 没采样到颜色：不得兜底 rgba(255,255,255,.96) 把插画糊白 → 透明。
  const noColor = T.createBubbleNode(makeBubble({ bg_color: "" }), 0);
  assert.equal(noColor.classList.contains("mt-fill-unbounded"), true);
  assert.equal(noColor.style.getPropertyValue("--mt-region-clip"), "");

  // 颜色不是 #rrggbb（未采样/非法值）同样不算数。
  const badColor = T.createBubbleNode(makeBubble({ bg_color: "white" }), 0);
  assert.equal(badColor.classList.contains("mt-fill-unbounded"), true);

  // 轮廓 + 采样色都在：按轮廓裁剪。
  const ok = T.createBubbleNode(makeBubble(), 0);
  assert.equal(ok.classList.contains("mt-fill-unbounded"), false);
  assert.match(ok.style.getPropertyValue("--mt-region-clip"), /^polygon\(/u);
});

test("实底填充：容器轮廓优先于文字四边形（跨页气泡的文字可能在另一页）", () => {
  const bubble = makeBubble({ polygon: null, region_polygon: polygonRegionTilted });
  const node = T.createBubbleNode(bubble, 0);
  assert.equal(node.classList.contains("mt-fill-unbounded"), false);
  // 文字四边形缺失时绝不能退回包围盒：裁剪用的必须是 region_polygon。
  const clip = node.style.getPropertyValue("--mt-region-clip");
  assert.match(clip, /^polygon\(/u);
  assert.notEqual(clip, "polygon(0.00% 0.00%, 100.00% 0.00%, 100.00% 100.00%, 0.00% 100.00%)");
});

test("覆盖投影保留容器轮廓：跨页气泡的白色实底长条靠它裁剪", () => {
  const bubble = makeBubble({ polygon: null, region_polygon: polygonRegionTilted });
  const cover = T.buildBubbleCoverProjection(bubble);
  assert.deepEqual(cover.region_polygon, bubble.region_polygon);
  const node = T.createBubbleNode(cover, 0);
  assert.equal(node.classList.contains("mt-cover-only"), true);
  assert.equal(node.classList.contains("mt-fill-unbounded"), false);
  assert.match(node.style.getPropertyValue("--mt-region-clip"), /^polygon\(/u);
});

test("遮罩尺寸跟着识别到的文字框：rotation_deg 与 polygon 角度「不一致」也不能撑大遮罩", () => {
  // 现场：页面 720×947（长宽比 1.315），同一段斜排文字在像素坐标读 35°、在百分比坐标读 28°。
  // 两个数字是同一个倾角，按数值比对会误判成冲突并退回「旋转整个外接框」，
  // 实测把 362×278 的文字框撑成 443×532 的遮罩 —— 用户看到的「覆盖层太大」。
  const bubble = makeBubble({ rotation_deg: 35 });
  const cover = T.buildBubbleCoverProjection(bubble);
  const clipNode = T.createBubbleCoverClipNode(bubble, T.createBubbleNode(cover, 0));
  const polygonBox = {
    w: Math.max(...bubble.polygon.map(p => p.x)) - Math.min(...bubble.polygon.map(p => p.x)),
    h: Math.max(...bubble.polygon.map(p => p.y)) - Math.min(...bubble.polygon.map(p => p.y))
  };
  assert.equal(Number.parseFloat(clipNode.style.width), Number(polygonBox.w.toFixed(2)));
  assert.equal(Number.parseFloat(clipNode.style.height), Number(polygonBox.h.toFixed(2)));

  const geometry = T.resolveBubbleCoverGeometry(bubble);
  assert.equal(geometry.tilted, true);
  // 遮罩四边形就是识别到的文字框本身（按覆盖范围设置外扩），不是外接框的包围盒。
  assert.ok(geometry.bounds.w <= polygonBox.w * 1.1 && geometry.bounds.h <= polygonBox.h * 1.1,
    `遮罩不该比文字框大出 10% 以上：${JSON.stringify(geometry.bounds)} vs ${JSON.stringify(polygonBox)}`);
});

test("四边形倾角与顶点起点/绕向无关：轴对齐框恒为 0，倾斜四边形恒为同一角度", () => {
  const orders = [
    axisAlignedPolygon,
    [axisAlignedPolygon[1], axisAlignedPolygon[2], axisAlignedPolygon[3], axisAlignedPolygon[0]],
    [axisAlignedPolygon[2], axisAlignedPolygon[3], axisAlignedPolygon[0], axisAlignedPolygon[1]],
    [axisAlignedPolygon[3], axisAlignedPolygon[0], axisAlignedPolygon[1], axisAlignedPolygon[2]],
    [axisAlignedPolygon[0], axisAlignedPolygon[3], axisAlignedPolygon[2], axisAlignedPolygon[1]],
    [axisAlignedPolygon[1], axisAlignedPolygon[0], axisAlignedPolygon[3], axisAlignedPolygon[2]]
  ];
  for (const order of orders) {
    assert.equal(polygonRotationDeg(order.map(({ x, y }) => ({ x, y }))), 0, JSON.stringify(order));
  }
  // 高而窄的轴对齐外框（多行横排）也不能被读成 90°：没有倾角就没有可恢复的倾角。
  assert.equal(polygonRotationDeg([{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 60 }, { x: 10, y: 60 }]), 0);
  for (const order of [
    polygonTilted,
    [polygonTilted[1], polygonTilted[2], polygonTilted[3], polygonTilted[0]],
    [polygonTilted[2], polygonTilted[3], polygonTilted[0], polygonTilted[1]],
    [polygonTilted[3], polygonTilted[0], polygonTilted[1], polygonTilted[2]]
  ]) {
    assert.ok(Math.abs(polygonRotationDeg(order) + 9.090276920822323) < 1e-6, JSON.stringify(order));
  }
});

test("场景文字层：成员 region 缺 rotationDeg 时用成员四边形兜底", () => {
  const bubble = {
    x: 10, y: 20, w: 50, h: 10, original_text: "원문", translated_text: "译文",
    bg_type: "solid", canonical_id: "c-tilt",
    visual: {
      rawBox: { width: 1000, height: 1000 }, box: { w: 100, h: 100 },
      detectedRegions: [{
        regionId: "r1",
        sourcePolygon: [{ x: 100, y: 200 }, { x: 600, y: 120 }, { x: 600, y: 320 }, { x: 100, y: 400 }],
        lineThickness: 40, geometryReliability: "detected"
      }]
    }
  };
  const scene = buildRenderSceneForBubbles({
    id: "member-tilt", surface: { id: "p1", type: "page", width: 1000, height: 1000 },
    bubbles: [bubble], measure: () => 10
  });
  const text = scene.layers.find(layer => layer.type === "text");
  assert.ok(text, "应生成文字层");
  assert.ok(Math.abs(text.geometry.placement.rotationDeg + 9.090276920822323) < 1e-3,
    `成员四边形倾角应传到 placement，实际 ${text.geometry.placement.rotationDeg}`);
});

const { installSceneProjection } = await import("../extension/src/content/modules/scene-projection.js");
const projectionRuntime = {
  normalizeBubbleAlignment: value => String(value || "center"),
  normalizeBubbleFontWeight: (value, fallback) => Number(value) || fallback
};
installSceneProjection(projectionRuntime);

function canonicalProjection(polygon, rotationDeg, visualExtra = {}) {
  const pageValue = { pageId: "tilt-page", imageRevision: "rev-tilt", width: 1000, height: 1000, readingOrder: 0 };
  const observation = R.createObservation({
    provider: "tilt-fixture", captureId: `tilt:${rotationDeg}:${Boolean(visualExtra.regionPolygon)}`,
    sourceType: "page", pageIds: ["tilt-page"], imageRevisionByPage: { "tilt-page": "rev-tilt" },
    pageSpans: [{
      pageId: "tilt-page", box: { x: 10, y: 20, w: 50, h: 10 },
      coordinateSpace: "percent", regionType: "dialogue", overlapRatio: 1
    }],
    originalText: "기울어진 문장", confidence: 0.95,
    visual: {
      regionType: "dialogue", bgType: "solid", bgColor: "#ffffff", polygon,
      ...visualExtra, ...(rotationDeg === undefined ? {} : { rotationDeg })
    }
  });
  const recon = R.reconcile({ pages: [pageValue], observations: [observation] });
  const canonical = recon.canonicals[0];
  return R.buildRenderProjections({
    pages: [pageValue], canonicals: recon.canonicals,
    translations: { [`${canonical.id}@${canonical.revision}`]: "译文" }
  })[0];
}

test("canonical 投影气泡顶层带 rotation_deg；region_polygon 单独倾斜时渲染节点仍能恢复", () => {
  const withRotation = projectionRuntime.projectionToRendererBubble(canonicalProjection(axisAlignedPolygon, -9.09));
  assert.equal(Number(withRotation.rotation_deg).toFixed(2), "-9.09");
  assert.equal(Number(T.createBubbleNode(withRotation, 0).dataset.rotationDeg).toFixed(2), "-9.09");

  const regionOnly = projectionRuntime.projectionToRendererBubble(
    canonicalProjection(axisAlignedPolygon, undefined, { regionPolygon: polygonRegionTilted })
  );
  assert.equal(regionOnly.rotation_deg, 0, "投影层确实没有显式倾角");
  assert.equal(Number(T.createBubbleNode(regionOnly, 0).dataset.rotationDeg).toFixed(2), "-9.09",
    "渲染侧必须从 region_polygon 恢复倾角");
});
