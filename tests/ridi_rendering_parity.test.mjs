import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";
import { installOverlayHost } from "../extension/src/content/modules/overlay-host.js";
import { installLifecyclePosition } from "../extension/src/content/modules/lifecycle-position.js";
import { installRendererMask } from "../extension/src/content/modules/renderer-mask.js";
import { applySampledBubbleColors, chooseReadableTextColors } from "../extension/src/rendering/bubble-colors.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

/* ---------------------------------------------------------------------------
 * 假 DOM：只提供 overlay-host.js 用到的那几个能力（createElement / appendChild /
 * contains / getComputedStyle 的 overflow），让「宿主必须是真正在滚动的容器」
 * 这条判据可以在 Node 里被真正执行，而不是只做源码断言。
 * ------------------------------------------------------------------------- */

function makeElement(tag = "div") {
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentElement: null,
    className: "",
    dataset: {},
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
    __style: { overflowX: "visible", overflowY: "visible", position: "static" },
    get childElementCount() {
      return this.children.length;
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    remove() {
      const parent = this.parentElement;
      this.isConnected = false;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      this.parentElement = null;
    },
    contains(other) {
      for (let node = other; node; node = node.parentElement) {
        if (node === this) return true;
      }
      return false;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return this.__rect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    }
  };
  // 每个元素自带可观测的 CSS 变量表，方便断言"哪一个 root 拿到了什么变量"。
  element.cssProps = new Map();
  // 真实 DOM 元素必有 classList（竖排判据 mt-jp-vertical 就挂在上面），假 DOM 也要有，
  // 否则测到的是"stub 缺能力"而不是生产行为。
  const classNames = new Set();
  element.classList = {
    add: (...names) => names.forEach(name => classNames.add(name)),
    remove: (...names) => names.forEach(name => classNames.delete(name)),
    contains: name => classNames.has(name),
    toggle: (name, force) => {
      const next = force === undefined ? !classNames.has(name) : force === true;
      if (next) classNames.add(name); else classNames.delete(name);
      return next;
    }
  };
  element.style = {
    setProperty: (name, value) => element.cssProps.set(name, value),
    getPropertyValue: name => element.cssProps.get(name) || "",
    removeProperty: name => element.cssProps.delete(name),
    overflow: ""
  };
  return element;
}

globalThis.document = {
  documentElement: makeElement("html"),
  body: makeElement("body"),
  createElement: tag => makeElement(tag)
};
globalThis.getComputedStyle = element => element && element.__style || { overflowX: "visible", overflowY: "visible" };

/**
 * syncOverlayPosition 的最小运行时：只提供它在"位置/尺寸都没变、没有待适配字号"
 * 这条早退路径上真正会碰到的能力，用来验证清理图变量是否每次同步都被校准。
 */
const overlayStates = new Map();
const runtimeUnderTest = {
  isDataUrl: value => /^data:/u.test(String(value || "")),
  getQuickSourceToken: () => "src",
  getOverlayDisplayRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  getVisibleViewportRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  isRectVisible: () => true,
  getOverlayVisibilityRect: (overlayState, rect) => rect,
  shouldHideOverlayRoot: () => false,
  ensureOverlayLayer: () => null,
  getOverlayPositionRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  compareOverlayViewportRects: previous => previous
    ? { positionChanged: false, sizeChanged: false }
    : { positionChanged: true, sizeChanged: true },
  syncLoadingOverlayCardPosition: () => {}
};
runtimeUnderTest.state = { overlaysById: overlayStates };
installLifecyclePosition(runtimeUnderTest);
// syncOverlayPosition 的清理图写入值现在统一由 runtime.maskCssValue 生成
// （renderer-mask 提供），harness 必须装上它，长短 dataURL 才能按真实路径分流。
installRendererMask(runtimeUnderTest);

/** RIDI 结构：html > body > [滚动容器 > 内容 > 分片 > img]。 */
function buildRidiLikeReader() {
  const scroller = makeElement("div");
  scroller.__style = { overflowX: "visible", overflowY: "scroll", position: "relative" };
  scroller.scrollHeight = 157358;
  scroller.clientHeight = 702;
  const content = makeElement("div");
  const slice = makeElement("div");
  const image = makeElement("img");
  document.body.appendChild(scroller);
  scroller.appendChild(content);
  content.appendChild(slice);
  slice.appendChild(image);
  return { scroller, content, slice, image };
}

test("覆盖层宿主解析器必须在 contentPhases 里装配，且早于 controls-ui", async () => {
  const { contentPhases } = await import("../extension/src/content/modules/index.js");
  const names = contentPhases.functions.map(installer => installer.name);
  const hostIndex = names.indexOf("installOverlayHost");
  const uiIndex = names.indexOf("installControlsUi");
  assert.ok(hostIndex >= 0,
    "installOverlayHost 必须装配：漏装时 controls-ui 会退回 documentElement，覆盖层只能逐帧追赶并多出一条滚动条");
  assert.ok(uiIndex >= 0);
  assert.ok(hostIndex < uiIndex, "installOverlayHost 必须早于 installControlsUi，后者的 ensureOverlayLayer 才会委托给它");
});

test("覆盖层宿主取真正的滚动容器，绝不落在 documentElement 上", () => {
  const runtime = {
    state: {},
    // 共同祖先一路退到 documentElement —— 这是 RIDI 上真实发生的退化：
    // 目标分散在不同子树时，共同祖先不再是内容容器。
    findCrossPageOverlayHost: () => document.documentElement
  };
  installOverlayHost(runtime);
  const { scroller, slice, image } = buildRidiLikeReader();

  assert.equal(runtime.resolveOverlayHost(image), scroller,
    "必须退回所有目标共享的滚动容器，而不是 documentElement");

  const layer = runtime.ensureOverlayLayerOnHost(image);
  assert.equal(layer.parentElement, scroller, "图层必须挂在滚动容器里，才会和原图一起滚动");
  assert.equal(layer.className, "mt-overlay-layer");
  assert.equal(runtime.ensureOverlayLayerOnHost(image), layer, "同一宿主要复用同一个图层");
  assert.equal(slice.children.includes(layer), false, "不能挂到分片自己的小盒子上");
});

test("没有滚动容器时才退回 documentElement", () => {
  const runtime = { state: {}, findCrossPageOverlayHost: () => document.documentElement };
  installOverlayHost(runtime);
  const plain = makeElement("div");
  const image = makeElement("img");
  document.body.appendChild(plain);
  plain.appendChild(image);
  assert.equal(runtime.resolveOverlayHost(image), document.documentElement);
});

test("宿主变好后空置的旧图层会被清掉，state.overlayLayer 不再指向空壳", () => {
  const runtime = { state: {}, findCrossPageOverlayHost: () => document.documentElement };
  installOverlayHost(runtime);
  const stale = runtime.ensureOverlayLayerOnHost(null);
  assert.equal(stale.parentElement, document.documentElement);
  // 新的宿主出现（整章内容容器就绪）→ 建新图层，旧空壳必须被移除。
  const { scroller, image } = buildRidiLikeReader();
  const fresh = runtime.ensureOverlayLayerOnHost(image);
  assert.equal(fresh.parentElement, scroller);
  assert.equal(stale.isConnected, false, "空置的旧图层必须被清掉");
  assert.equal(runtime.state.overlayLayer, fresh);
});

test("复杂背景（旁白/嵌字）的投影必须要求 inpainted 清理图，并且能算出清理掩膜", () => {
  const cover = {
    canonicalId: "canonical_narration",
    role: "cover",
    coverOnly: true,
    active: true,
    geometry: { left: 10, top: 12, width: 40, height: 26 },
    visual: {},
    bubble: { bg_type: "none" }
  };
  assert.equal(P.projectionsRequireCleanedImage([cover]), true);
  const masks = P.buildCanonicalCleanMasks([cover]);
  assert.ok(Array.isArray(masks) && masks.length > 0, "必须给出清理掩膜，否则服务端无从 inpaint");
  const plan = P.buildCleanedArtifactProjectionPlan(new Map([["page-1", [cover]]]), null);
  assert.equal(P.projectionsRequireCleanedImage(plan.get("page-1")), true);
  // 实底气泡自带实色遮罩，不需要清理图。
  const solid = { ...cover, visual: { bgType: "solid" }, bubble: { bg_type: "solid" } };
  assert.equal(P.projectionsRequireCleanedImage([solid]), false);
  // 分片滚出视口 / 不再是"当前主投影"之后，这一页仍然必须被要求清理图：
  // 清理图是页面图像产物，不该取决于滚动时机——否则同章里就会出现
  // "有的分片有 inpainted 遮罩、有的没有"。
  assert.equal(P.projectionsRequireCleanedImage([{ ...cover, active: false }]), true);
  // 而且掩膜必须真的算得出来：否则请求发出去也只会拿到"没有清理图"。
  assert.ok(P.buildCanonicalCleanMasks([{ ...cover, active: false }]).length > 0);
  // standby 文本由 seam surface 负责自己的遮罩，不额外要页面级清理图。
  assert.equal(P.projectionsRequireCleanedImage([{
    ...cover, role: "standby", coverOnly: false, activeText: false, active: true
  }]), false);
});

test("复杂背景上的黑白兜底色会被原图重新推导，彩色墨色得以保留", () => {
  // 40x40 采样图：文字框的外圈是背景色，正中间是原图的蓝色墨色。
  const width = 40;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  const background = [170, 160, 150];
  const ink = [30, 60, 210];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inInk = x >= 13 && x <= 26 && y >= 13 && y <= 26;
      const [red, green, blue] = inInk ? ink : background;
      const offset = (y * width + x) * 4;
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = 255;
    }
  }
  const imageAnalysis = { sample: { data, width, height, scale: 1 } };
  // 服务端按对比度兜底写死的黑字白边 + 复杂背景标记（没有实底容器）。
  const narration = {
    box: { x: 8, y: 8, w: 24, h: 24 },
    bg_type: "none",
    region_id: "",
    region_type: "effect_text",
    text_color: "#000000",
    stroke_color: "#ffffff"
  };
  assert.equal(applySampledBubbleColors([narration], imageAnalysis), 1);
  assert.equal(narration.text_color, "#1e3cd2", "旁白的蓝色墨色必须被保留，而不是压成黑字");
  assert.equal(narration.stroke_color, "#ffffff");

  // 实底气泡上服务端采样出的颜色一律保留：不做重新推导。
  const bubble = {
    box: { x: 8, y: 8, w: 24, h: 24 },
    bg_type: "solid",
    bg_color: "#f2f2f2",
    region_id: "region-1",
    region_type: "speech_bubble",
    text_color: "#000000",
    stroke_color: "#ffffff"
  };
  assert.equal(applySampledBubbleColors([bubble], imageAnalysis), 0);
  assert.equal(bubble.text_color, "#000000");
  assert.equal(bubble.stroke_color, "#ffffff");

  // 与扩展侧同口径：彩色墨色低对比也保留，灰阶墨色按对比度退回黑白。
  assert.equal(chooseReadableTextColors("#1e3cd2", "#aaa096").textColor, "#1e3cd2");
  assert.equal(chooseReadableTextColors("#7a7a7a", "#a0a0a0").textColor, "#000000");
});

test("清理图计划覆盖渲染真正会画的投影（plan ∪ fallback）", () => {
  const narration = { active: true, visual: {}, bubble: { bg_type: "none" }, geometry: { left: 3, top: 3, width: 2, height: 2 } };
  const plan = new Map([["page-1", [{
    ...narration, projectionId: "a", canonicalId: "c1", role: "primary", activeText: true
  }]]]);
  const fallback = new Map([
    ["page-1", [
      { projectionId: "a", canonicalId: "c1", role: "primary" },
      { ...narration, projectionId: "b", canonicalId: "c2", role: "cover", coverOnly: true }
    ]],
    ["page-2", [{ ...narration, projectionId: "d", canonicalId: "c3", role: "cover", coverOnly: true }]]
  ]);
  const merged = P.mergeCleanedArtifactProjectionSource(plan, fallback);
  assert.equal(merged.get("page-1").length, 2, "同一 projectionId 不重复，fallback 多出来的投影必须并进来");
  assert.equal(merged.get("page-2").length, 1, "只出现在 fallback 里的页面也要被覆盖");
  assert.equal(P.projectionsRequireCleanedImage(merged.get("page-2")), true);
});

test("覆盖层跟着最新一次渲染的清理图校准（图后到也能画上）", async () => {
  const { installLifecyclePosition } = await import("../extension/src/content/modules/lifecycle-position.js");
  const rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
  const props = new Map();
  const root = makeElement("div");
  root.style = {
    setProperty: (name, value) => props.set(name, value),
    getPropertyValue: name => props.get(name) || "",
    removeProperty: name => props.delete(name)
  };
  root.isConnected = true;
  overlayStates.set(1, {
    targetId: 1,
    root,
    target: makeElement("img"),
    targetKey: "k",
    sourceToken: "src",
    bubbleNodes: [],
    cleanedImage: "",
    lastViewportRect: null
  });
  runtimeUnderTest.syncOverlayPosition(runtimeUnderTest.state.overlaysById.get(1));

  const overlayState = runtimeUnderTest.state.overlaysById.get(1);
  // 覆盖层先上屏时还没有清理图 → 变量为空（保持透明，不画纯色补丁）。
  assert.equal(props.get("--mt-cleaned-image") || "", "");

  // 清理图后到：只为这一页更新 overlayState.cleanedImage（等同于下一次渲染带上来的图），
  // 再同步一次就必须把 inpainted 遮罩画上——而不是永远停在没有遮罩的那一版。
  overlayState.cleanedImage = "data:image/png;base64,Y2xlYW4=";
  runtimeUnderTest.syncOverlayPosition(overlayState);
  assert.equal(props.get("--mt-cleaned-image"), 'url("data:image/png;base64,Y2xlYW4=")');

  // 清理图失效（例如分片换版）时必须撤掉，不能留一张过期补丁。
  overlayState.cleanedImage = "";
  runtimeUnderTest.syncOverlayPosition(overlayState);
  assert.equal(props.get("--mt-cleaned-image") || "", "");
});

test("复杂背景遮罩只画清理图，拿不到就保持透明（不画纯色补丁）", () => {
  const css = fs.readFileSync(path.join(projectRoot, "extension", "public", "styles.css"), "utf8");
  const rule = css.match(/\.mt-bg-none\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(rule, /background-image:\s*var\(--mt-cleaned-image/u,
    "有清理图时必须画 inpainted 补丁");
  assert.match(rule, /background:\s*transparent/u,
    "拿不到清理图时必须透明——纯色补丁会在清理图回来之前糊上一块白/近色方块");
  assert.doesNotMatch(rule, /background-color:\s*var\(--mt-adaptive-bg/u,
    "不得用采样色兜底成纯色补丁");
  // 文字层不能被兜底色盖住。
  const textLayer = css.match(/\.mt-bubble\.mt-text-layer\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(textLayer, /background:\s*transparent\s*!important/u);
});

/** 带可观测样式表的假 root，用来判断 --mt-cleaned-image 到底写没写上去。 */
function makeStyleTarget() {
  const element = makeElement("div");
  const props = new Map();
  element.style = {
    setProperty: (name, value) => props.set(name, value),
    getPropertyValue: name => props.get(name) || "",
    removeProperty: name => props.delete(name)
  };
  element.props = props;
  return element;
}

test("清理图必须按 pageId 绑到已存在的覆盖层上（命中缓存 ≠ 已经画上）", () => {
  const runtime = { isDataUrl: value => /^data:image\//u.test(String(value || "")) };
  runtime.state = {
    overlaysById: new Map(),
    kakaoPageIdByTarget: new WeakMap()
  };
  installRendererMask(runtime);
  const pageATarget = makeElement("img");
  const pageA = makeStyleTarget();
  const pageB = makeStyleTarget();
  const unbound = makeStyleTarget();
  runtime.state.kakaoPageIdByTarget.set(unbound, "page-c");
  runtime.state.overlaysById.set(1, { root: pageA, target: pageATarget });
  runtime.state.overlaysById.set(2, { root: pageB, target: makeElement("img") });
  runtime.state.overlaysById.set(3, { root: unbound, target: makeElement("img") });
  // 只有 overlayState.pageId 可作为身份时也要能绑定（缺 WeakMap 映射的路径）。
  runtime.state.overlaysById.get(2).pageId = "page-b";

  assert.equal(runtime.applyCleanedImageToPageOverlays("page-b", "data:image/png;base64,Yg=="), 1);
  assert.equal(pageB.props.get("--mt-cleaned-image"), 'url("data:image/png;base64,Yg==")');
  assert.equal(pageA.props.get("--mt-cleaned-image") || "", "", "别的分片不能被连带画上");
  assert.equal(unbound.props.get("--mt-cleaned-image") || "", "");
  assert.equal(runtime.state.overlaysById.get(2).cleanedImage, "data:image/png;base64,Yg==",
    "overlayState 也要记上，否则下一次 syncOverlayPosition 会把遮罩撤掉");

  // WeakMap 映射（target → pageId）是另一条身份来源：RIDI 页面覆盖层就走这条。
  runtime.state.kakaoPageIdByTarget.set(pageATarget, "page-a");
  assert.equal(runtime.applyCleanedImageToPageOverlays("page-a", "data:image/png;base64,YQ=="), 1);
  assert.equal(pageA.props.get("--mt-cleaned-image"), 'url("data:image/png;base64,YQ==")');
  // 现场证据：绑定必须留痕，否则 data-mt-mask-render 的 out 会让人误判成"没修好"。
  assert.deepEqual(JSON.parse(document.documentElement.dataset.mtMaskBind), [{ p: "b", n: 1 }, { p: "a", n: 1 }]);

  // 重复绑定是幂等的；非 data URL（还没拿到图 / 图被撤销）不写空变量。
  assert.equal(runtime.applyCleanedImageToPageOverlays("page-a", "data:image/png;base64,YQ=="), 0);
  assert.equal(runtime.applyCleanedImageToPageOverlays("page-a", ""), 0);
  assert.equal(pageA.props.get("--mt-cleaned-image"), 'url("data:image/png;base64,YQ==")');
});

test("分片原地换图（同一 target 换成新 pageId）后，新页的清理图必须能绑上可见层", () => {
  // RIDI 分片阅读器换图是「同一个 <img> 元素原地换页」：targetId 不变、覆盖层不重建，
  // 但 pageId 与 imageRevision 都是新的。overlayState.pageId 是建 root 那一刻的快照，
  // 会永远停在旧页 —— 旧口径下新页的清理图匹配不上、可见层永远没有遮罩，而旧页的图
  // 反而写进这一层。这就是「同一章里有些分片有清理图、有些没有」。
  const runtime = { isDataUrl: value => /^data:image\//u.test(String(value || "")) };
  runtime.state = {
    overlaysById: new Map(),
    kakaoPageIdByTarget: new WeakMap()
  };
  installRendererMask(runtime);
  const strip = makeElement("img");
  const root = makeStyleTarget();
  // 建 root 时这一片是旧页。
  runtime.state.kakaoPageIdByTarget.set(strip, "page-old");
  runtime.state.overlaysById.set(1, { root, target: strip, pageId: "page-old" });

  // 阅读器原地换图 → 同一个 target 重新绑到新页。
  runtime.state.kakaoPageIdByTarget.set(strip, "page-new");

  // 新页的清理图必须绑上这一层：旧口径会因为快照还写着 page-old 而跳过。
  assert.equal(runtime.applyCleanedImageToPageOverlays("page-new", "data:image/png;base64,TkVX"), 1,
    "新页的清理图绑不上可见层 = 换图后的分片没有遮罩");
  assert.equal(root.props.get("--mt-cleaned-image"), 'url("data:image/png;base64,TkVX")');
  // 旧页的清理图不得再写进这一层：那一页此刻多半已经 display:none，
  // 而这里画的是新页的内容，贴上旧页的 inpainted 图就是错位的补丁。
  assert.equal(runtime.applyCleanedImageToPageOverlays("page-old", "data:image/png;base64,T0xE"), 0,
    "换图后这一层属于新页，旧页的清理图不能覆盖它");
  assert.equal(root.props.get("--mt-cleaned-image"), 'url("data:image/png;base64,TkVX")');
});

test("清理图绑定器必须在 contentPhases 里装配", async () => {
  const { contentPhases } = await import("../extension/src/content/modules/index.js");
  const names = contentPhases.functions.map(installer => installer.name);
  assert.ok(names.includes("installRendererMask"),
    "漏装时 canonical 层拿到清理图也无处可绑：旁白会一直停在「有些有遮罩、有些没有」");
});

test("重渲染没带上清理图时，已绑上的遮罩不能被擦掉", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "extension", "src", "content", "modules", "renderer-overlay.js"), "utf8");
  // 覆盖层重建（新 root）时 --mt-cleaned-image 只能来自 cleanedImage；它必须能
  // 依次回退到「这一枚 root 上已绑的图」和「store 里这一页此刻的图」，
  // 否则 renderer-mask 刚画的遮罩立刻消失。
  assert.match(source, /const carriedMask = String\(oldOverlay && oldOverlay\.cleanedImage \|\| ""\)/u);
  assert.match(source, /const storeMask = String\(runtime\.getPageCleanedImage\?\.\(options\.pageId\) \|\| ""\)/u);
  assert.match(source, /const cleanedImage = String\(argMask \|\| carriedMask \|\| storeMask \|\| ""\)/u);
  // 长图 dataURL 会超出 Chromium 行内样式 ~2MB 的单值静默上限（写入不报错但读回
  // 恒为空），所以写入必须统一走 runtime.maskCssValue（短图原样、长图转 blob:URL）。
  assert.match(source, /const maskValue = runtime\.maskCssValue\?\.\(cleanedImage\);\s*\n\s*if \(maskValue\) root\.style\.setProperty\("--mt-cleaned-image", maskValue\);/u);
  assert.doesNotMatch(source, /setProperty\("--mt-cleaned-image", `url\(/u,
    "禁止再把 dataURL 原样拼进行内样式：RIDI 高清分片 3.9~4.4MB 必然静默失败");
});

test("分片换图源（sourceToken 变化）也不能丢掉这一页已绑定的清理图", async () => {
  // RIDI 现场：同一页的分片图会换 url（懒加载/换版），sourceToken 随之变化，
  // 但清理图是「页级」产物（按 pageId 缓存于 canonical handle），仍然有效。
  // 旧写法把 carriedMask 挂在 sourceToken 相等上，于是换源那一轮：
  //   新 root 不带 --mt-cleaned-image → overlayState.cleanedImage 被本次渲染
  //   覆盖成空 → 紧接着 syncOverlayPosition 按"没有清理图"把变量撤掉。
  // 用户看到的就是"有些分片的遮罩会被擦掉、有些不会"。
  const { installRendererOverlay } = await import("../extension/src/content/modules/renderer-overlay.js");
  const { installRendererCover } = await import("../extension/src/content/modules/lifecycle-cover.js");
  const { installRendererCover: installCoverClip } = await import("../extension/src/content/modules/renderer-cover.js");

  const target = makeElement("img");
  target.dataset.mtSourceToken = "https://ridi.example/slice-1.jpg";
  const root = makeElement("div");
  const MASK = "data:image/png;base64,Y2xlYW4=";
  const state = { overlaysById: new Map(), overlayLayer: makeElement("div") };
  state.overlaysById.set(1, {
    targetId: 1,
    target,
    root,
    targetKey: "k",
    sourceToken: "https://ridi.example/slice-1.jpg",
    bubbleNodes: [],
    coverNodes: [],
    bubbleCount: 1,
    cleanedImage: MASK
  });

  const runtime = {
    state,
    isDataUrl: value => /^data:image\//u.test(String(value || "")),
    getTargetId: () => 1,
    getQuickSourceToken: t => String(t.dataset.mtSourceToken || ""),
    buildOverlayRenderSignature: () => "sig-2",
    isSameOverlayRenderPayload: () => false,
    ensureOverlayLayer: () => state.overlayLayer,
    appendOcrDebugNodes: () => 0,
    // 本次渲染**没有**带上清理图（result.cleanedImage 为空）。
    createBubbleRenderNodes: () => ({
      coverNode: makeElement("div"),
      textNode: makeElement("div")
    }),
    createBubbleCoverClipNode: bubble => makeElement("div"),
    appendBubbleRenderLayers: () => {},
    syncOverlayPosition: () => {},
    ensureOverlayFrameSync: () => {},
    logOcrDebugMapping: () => {},
    tracePipeline: () => {},
    syncKakaoVisualDuplicateBubbles: () => {},
    getBubbleRenderColors: () => ({ textColor: "#000", strokeColor: "#fff" })
  };
  runtime.state.overlaysById = state.overlaysById;
  // 写入路径必须走真实的 runtime.maskCssValue（三处写入点口径一致）。
  installRendererMask(runtime);
  installRendererOverlay(runtime);

  // 图源换了（分片换 url）→ sourceToken 已不同。
  target.dataset.mtSourceToken = "https://ridi.example/slice-1.jpg?v=2";
  runtime.renderOverlay(target, "k", {
    bubbles: [{
      x: 1, y: 1, w: 10, h: 10, projection_role: "cover_only",
      bg_type: "none", region_type: "effect_text", canonical_id: "c1"
    }]
  }, { pageId: "page-x" });

  const next = runtime.state.overlaysById.get(1);
  assert.equal(next.sourceToken, "https://ridi.example/slice-1.jpg?v=2",
    "覆盖层应已按新图源重建");
  assert.notEqual(next.root, root, "换图源会重建一个新的 root（这正是旧写法丢图的那一步）");
  assert.equal(next.cleanedImage, MASK,
    "换图源时这一页已绑定的清理图必须被沿用");
  assert.equal(next.root.cssProps.get("--mt-cleaned-image"), `url("${MASK}")`,
    "新 root 必须立刻带上 inpainted 遮罩变量，否则这一片会露出原文");
});

test("渲染没带图、旧层也没绑过时，必须从 store 兜底取这一页的清理图", async () => {
  // RIDI 现场：清理图是异步产物，图落地时这一版投影往往已经画完；而覆盖层可能
  // 在图落地之后才（重）建 —— 此时 result.cleanedImage 为空、老 root 又不在了，
  // 两个来源都扑空。唯一可靠的取法是直接问 canonical store「这一页现在有没有图」。
  // 缺了这条兜底，那些分片就会永远停在"没有遮罩"。
  const { installRendererOverlay } = await import("../extension/src/content/modules/renderer-overlay.js");

  const target = makeElement("img");
  const MASK = "data:image/png;base64,U1RPUkU=";
  const state = { overlaysById: new Map(), overlayLayer: makeElement("div") };
  const runtime = {
    state,
    isDataUrl: value => /^data:image\//u.test(String(value || "")),
    getTargetId: () => 7,
    getQuickSourceToken: () => "tok",
    buildOverlayRenderSignature: () => "sig",
    isSameOverlayRenderPayload: () => false,
    ensureOverlayLayer: () => state.overlayLayer,
    appendOcrDebugNodes: () => 0,
    createBubbleRenderNodes: () => ({ coverNode: makeElement("div"), textNode: makeElement("div") }),
    createBubbleCoverClipNode: () => makeElement("div"),
    appendBubbleRenderLayers: () => {},
    syncOverlayPosition: () => {},
    ensureOverlayFrameSync: () => {},
    logOcrDebugMapping: () => {},
    tracePipeline: () => {},
    syncKakaoVisualDuplicateBubbles: () => {},
    getBubbleRenderColors: () => ({ textColor: "#000", strokeColor: "#fff" })
  };
  // 写入路径必须走真实的 runtime.maskCssValue；getPageCleanedImage 在装完 mask 后
  // 再覆盖回 store 兜底 stub（installRendererMask 会先塞一个查 canonical store 的真身）。
  installRendererMask(runtime);
  runtime.getPageCleanedImage = pageId => (pageId === "page-new" ? MASK : "");
  installRendererOverlay(runtime);

  runtime.renderOverlay(target, "k", {
    bubbles: [{
      x: 1, y: 1, w: 10, h: 10, projection_role: "cover_only",
      bg_type: "none", region_type: "effect_text", canonical_id: "c1"
    }]
  }, { pageId: "page-new" });

  const next = state.overlaysById.get(7);
  assert.ok(next, "应当建出覆盖层");
  assert.equal(next.cleanedImage, MASK, "store 兜底的清理图必须写进 overlayState");
  assert.equal(next.root.cssProps.get("--mt-cleaned-image"), `url("${MASK}")`,
    "新 root 必须带上 store 兜底取到的 inpainted 遮罩");
});

/* ---------------------------------------------------------------------------
 * maskCssValue —— 行内样式 ~2MB 单值静默上限的统一出口（所有写入点的唯一来源）。
 * Chromium 实测：行内 style 单值 2,000,000 字符写入成功，3,000,000 静默失败
 * （读回恒为空）。RIDI 高清分片的清理图 dataURL 有 3.9~4.4MB，直接写
 * url("data:...") 必然静默失败 → 变量恒为空 → 无遮罩；小分片不触线就有遮罩。
 * 修复：短图原样（行为不变），长图同步转 Blob + Object URL。Node 没有
 * URL.createObjectURL，测试注入 stub 计数。
 * ------------------------------------------------------------------------- */

/** 构造超阈值的长 dataURL（base64 全 "A"、长度 %4==0 可被 atob 解码；index 只用来区分条目）。 */
function makeLongDataUrl(index) {
  return `data:image/png;base64,${"A".repeat(1500000 + index * 4)}`;
}

/** 注入 URL.createObjectURL / revokeObjectURL stub，返回调用计数与还原函数。 */
function installBlobUrlStubs() {
  const created = [];
  const revoked = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => {
    created.push(blob);
    return `blob:mt-stub-${created.length}`;
  };
  URL.revokeObjectURL = url => {
    revoked.push(url);
  };
  return {
    created,
    revoked,
    restore() {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  };
}

function makeMaskRuntime() {
  const runtime = { isDataUrl: value => /^data:[^;]+;base64,/iu.test(String(value || "")) };
  installRendererMask(runtime);
  return runtime;
}

test("maskCssValue：短 dataURL 原样返回 url(...)，非 dataURL 返回空串（行为不变）", () => {
  const { maskCssValue } = makeMaskRuntime();
  const SHORT = "data:image/png;base64,Y2xlYW4=";
  assert.equal(maskCssValue(SHORT), `url("${SHORT}")`,
    "短图必须原样走 dataURL 路径：KakaoPage 的行为一行都不能变");
  assert.equal(maskCssValue(""), "");
  assert.equal(maskCssValue("https://example.com/a.png"), "",
    "有没有图的判定不变：非 dataURL 一律空串，不写变量");
});

test("maskCssValue：长 dataURL 转 blob:URL，同一 dataURL 幂等返回同一 URL", () => {
  const stubs = installBlobUrlStubs();
  try {
    const { maskCssValue } = makeMaskRuntime();
    const LONG = makeLongDataUrl(100);
    const first = maskCssValue(LONG);
    assert.match(first, /^url\("blob:mt-stub-\d+"\)$/u,
      "长图必须转成 blob:URL，绕开行内样式 ~2MB 的单值静默上限");
    assert.equal(stubs.created.length, 1, "只创建一次 Object URL");
    assert.equal(stubs.created[0].type, "image/png", "MIME 必须取自 dataURL 元数据");
    // 幂等是 syncOverlayPosition 校准的命门：同一 dataURL 每次返回同一 blob:URL，
    // 「值没变就不重写」的比较才成立，不会回到每帧重写的死循环。
    assert.equal(maskCssValue(LONG), first);
    assert.equal(maskCssValue(LONG), first);
    assert.equal(stubs.created.length, 1);
  } finally {
    stubs.restore();
  }
});

test("maskCssValue：缓存按 LRU 淘汰，超出上限 16 时 revoke 最旧的 Object URL", () => {
  const stubs = installBlobUrlStubs();
  try {
    const { maskCssValue } = makeMaskRuntime();
    for (let i = 0; i < 16; i += 1) maskCssValue(makeLongDataUrl(i));
    assert.equal(stubs.revoked.length, 0, "未超上限不得回收任何 Object URL");
    maskCssValue(makeLongDataUrl(16));
    assert.equal(stubs.revoked.length, 1, "超出上限 16 必须恰好淘汰一个最旧条目");
    assert.equal(stubs.revoked[0], "blob:mt-stub-1", "淘汰的必须是插入最早的 Object URL");
    // 被淘汰的 dataURL 再次出现时重新生成新句柄（旧的已回收，不能复用死 URL）。
    assert.equal(maskCssValue(makeLongDataUrl(0)), "url(\"blob:mt-stub-18\")");
  } finally {
    stubs.restore();
  }
});

test("三处 --mt-cleaned-image 写入点必须统一走 maskCssValue（口径一致）", () => {
  const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), "utf8");
  const overlay = read("extension", "src", "content", "modules", "renderer-overlay.js");
  const mask = read("extension", "src", "content", "modules", "renderer-mask.js");
  const position = read("extension", "src", "content", "modules", "lifecycle-position.js");
  // renderer-overlay 与 lifecycle-position 都不得再把 dataURL 原样拼进 url("...")。
  assert.match(overlay, /runtime\.maskCssValue\?\.\(cleanedImage\)/u);
  assert.doesNotMatch(overlay, /setProperty\("--mt-cleaned-image", `url\(/u);
  assert.match(position, /runtime\.maskCssValue\?\.\(overlayState\.cleanedImage\)/u);
  assert.doesNotMatch(position, /`\$\{overlayState\.cleanedImage\}`/u);
  assert.match(mask, /runtime\.maskCssValue\(cleanedImage\)/u);
  // 状态字段继续存原始 dataURL：只有写进 CSS 的字符串走转换。
  assert.match(mask, /overlayState\.cleanedImage = String\(cleanedImage\);/u);
});

test("renderOverlay 画长清理图 + 连续两次 syncOverlayPosition：第二次不得再写变量", async () => {
  // RIDI 高清分片现场：长 dataURL 静默失败 → DOM 读回恒为空 → syncOverlayPosition
  // 认为「值不相等」每帧重写（data-mt-mask-trace 实测同一 root 连续 80 次、间隔
  // ~15ms、每次 len ~4.4MB）。走 blob:URL 后写入必然成功且幂等，第二次同步必须零写入。
  const { installRendererOverlay } = await import("../extension/src/content/modules/renderer-overlay.js");
  const stubs = installBlobUrlStubs();
  try {
    const target = makeElement("img");
    const LONG = makeLongDataUrl(5000);
    const state = { overlaysById: new Map(), overlayLayer: makeElement("div") };
    const runtime = {
      state,
      isDataUrl: value => /^data:[^;]+;base64,/iu.test(String(value || "")),
      getTargetId: () => 42,
      getQuickSourceToken: () => "tok",
      // syncOverlayPosition 早退路径需要的最小几何 stub（位置/尺寸恒定不变）。
      getOverlayDisplayRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
      getVisibleViewportRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
      isRectVisible: () => true,
      buildOverlayRenderSignature: () => "sig",
      isSameOverlayRenderPayload: () => false,
      ensureOverlayLayer: () => state.overlayLayer,
      appendOcrDebugNodes: () => 0,
      hasRenderableOcrDebug: () => false,
      createBubbleRenderNodes: () => ({ coverNode: makeElement("div"), textNode: makeElement("div") }),
      createBubbleCoverClipNode: () => makeElement("div"),
      logOcrDebugMapping: () => {},
      tracePipeline: () => {},
      syncKakaoVisualDuplicateBubbles: () => {},
      ensureOverlayFrameSync: () => {}
    };
    installRendererMask(runtime);
    installLifecyclePosition(runtime);
    installRendererOverlay(runtime);

    runtime.renderOverlay(target, "k", {
      bubbles: [{
        x: 1, y: 1, w: 10, h: 10, projection_role: "cover_only",
        bg_type: "none", region_type: "effect_text", canonical_id: "c1"
      }],
      cleanedImage: LONG
    }, { pageId: "page-long" });

    const overlayState = state.overlaysById.get(42);
    assert.ok(overlayState, "覆盖层应已建立");
    assert.equal(overlayState.cleanedImage, LONG, "状态里必须保留原始 dataURL（只有 CSS 写入值走转换）");
    const written = overlayState.root.cssProps.get("--mt-cleaned-image") || "";
    assert.match(written, /^url\("blob:mt-stub-\d+"\)$/u,
      "行内样式里必须是 blob:URL，而不是 3.9MB 的 dataURL");
    assert.equal(stubs.created.length, 1, "renderOverlay 内建的那次 sync 命中缓存，不得重复创建");

    // 第二次同步：位置、字号都没变 → 唯一可能的重写来源就是清理图变量。
    // 幂等 blob:URL 让「读回 === 期望值」成立，必须零 setProperty。
    const writes = [];
    const originalSetProperty = overlayState.root.style.setProperty;
    overlayState.root.style.setProperty = (name, value) => {
      writes.push(name);
      return originalSetProperty(name, value);
    };
    runtime.syncOverlayPosition(overlayState);
    assert.deepEqual(writes, [], "第二次 sync 不得再触发任何 setProperty（否则就是无限重写循环）");
    assert.equal(overlayState.root.cssProps.get("--mt-cleaned-image"), written);
  } finally {
    stubs.restore();
  }
});
