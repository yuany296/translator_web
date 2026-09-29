import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { detectReaderProfile } from "../extension/src/readers/profile.js";
import { resolveSiteHint } from "../extension/src/readers/site-hints.js";
import { installReaderObservers } from "../extension/src/content/modules/reader-observers.js";

function contentModuleSource(name) {
  return readFileSync(new URL(`../extension/src/content/modules/${name}`, import.meta.url), "utf8");
}

const BLANK_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
const DRAWN_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h1v1z'/%3E%3C/svg%3E";

globalThis.location = {
  hostname: "ridibooks.com",
  pathname: "/books/6305000008/view",
  search: "",
  href: "https://ridibooks.com/books/6305000008/view",
  origin: "https://ridibooks.com"
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

function fakeImage(overrides = {}) {
  const img = new globalThis.HTMLImageElement();
  img.dataset = {};
  img.isConnected = true;
  img.complete = true;
  img.naturalWidth = 300;
  img.naturalHeight = 150;
  img.getAttribute = () => null;
  img.getBoundingClientRect = () => ({
    left: 27,
    right: 747,
    top: 0,
    bottom: 720,
    width: 720,
    height: 720
  });
  return Object.assign(img, overrides);
}

function stackedMediaDocument(count = 3) {
  const nodes = Array.from({ length: count }, (item, index) => ({
    tagName: "IMG",
    getBoundingClientRect: () => ({ left: 27, top: index * 720, width: 720, height: 720 })
  }));
  return {
    querySelectorAll: () => nodes,
    querySelector: () => null
  };
}

test("RIDI 站点声明分片长条能力，通用站点不声明", () => {
  const ridi = resolveSiteHint({ hostname: "ridibooks.com" });
  assert.equal(ridi.id, "ridi");
  assert.equal(ridi.profile, "continuous-strip");
  assert.equal(ridi.tiledStrip, true);
  assert.equal(resolveSiteHint({ hostname: "page.kakao.com" }).tiledStrip, true);
  assert.equal(resolveSiteHint({ hostname: "reader.example" }).tiledStrip, false);

  // 能力来自站点提示，不由「竖排图片列」启发式推导：任意画廊不该白付接缝 OCR 成本。
  const ridiProfile = detectReaderProfile(stackedMediaDocument(), { hostname: "ridibooks.com" });
  assert.equal(ridiProfile.siteHint, "ridi");
  assert.equal(ridiProfile.tiledStrip, true);
  const genericProfile = detectReaderProfile(stackedMediaDocument(), { hostname: "reader.example" });
  assert.equal(genericProfile.siteHint, "generic");
  assert.equal(genericProfile.type, "continuous-strip");
  assert.equal(genericProfile.tiledStrip, false);
});

test("RIDI 运行时打开分片长条能力，Kakao 门禁不再是唯一入口", () => {
  assert.equal(runtime.readerProfile.siteHint, "ridi");
  assert.equal(runtime.readerProfile.tiledStrip, true);
  assert.equal(runtime.__test.stripTileReader, true);
});

test("空 SVG 懒加载占位图不再进入 OCR 队列", () => {
  const placeholder = fakeImage({ currentSrc: BLANK_PLACEHOLDER });
  assert.equal(runtime.__test.isBlankPlaceholderImage(placeholder), true);
  assert.equal(runtime.__test.passesTargetFilter(placeholder, true), false);

  const drawn = fakeImage({ currentSrc: DRAWN_SVG });
  assert.equal(runtime.__test.isBlankPlaceholderImage(drawn), false);
  assert.equal(runtime.__test.isBlankPlaceholderImage(fakeImage({ currentSrc: "blob:https://ridibooks.com/1" })), false);
  assert.equal(runtime.__test.isBlankPlaceholderImage({}), false);
});

function makeObserversRuntime(flags) {
  const calls = [];
  const previousTarget = fakeImage({ currentSrc: "blob:https://ridibooks.com/previous" });
  const target = fakeImage({ currentSrc: "blob:https://ridibooks.com/current" });
  const runtimeObject = {
    ...flags,
    state: {
      enabled: true,
      autoTranslatePageEnabled: false,
      invalidated: false,
      io: { observe() {} },
      preloadIo: null,
      observedTargets: new WeakSet(),
      kakaoLoadListenerTargets: new WeakSet()
    },
    isSupportedTarget: () => true,
    shouldSkipNovelMediaTarget: () => false,
    isSitePreferredTarget: () => true,
    getQuickSourceToken: value => value.currentSrc,
    computeTargetKey: () => "key",
    buildTargetSourceCacheKey: (key, source) => `${key}|${source}`,
    restoreKnownKakaoPageHandle() {},
    tracePipeline() {},
    collectKakaopageManualTargetCandidates: () => [previousTarget, target],
    buildKakaoStitchCandidateEntries: list => list.map(item => ({ target: item, descriptor: {} })),
    findKakaoStitchNeighborTarget: () => previousTarget,
    shouldUseKakaoCanonicalPipeline: () => true,
    kakaoCanonicalPipeline: { onAdjacentTargetAvailable: async () => ({ ok: true }) },
    queuePendingKakaoAdjacency: (pendingTarget, pendingPrevious) => {
      calls.push([pendingTarget, pendingPrevious]);
      return true;
    }
  };
  installReaderObservers(runtimeObject);
  return { runtime: runtimeObject, calls, target };
}

test("分片长条阅读器登记分片时建立邻页关系（RIDI）", () => {
  const harness = makeObserversRuntime({ IS_STRIP_TILE_READER: true, IS_KAKAOPAGE_READER: false });
  harness.runtime.registerTarget(harness.target);
  assert.equal(harness.calls.length, 1, "RIDI 必须建立邻页关系，接缝才可能跑到");
  assert.equal(harness.calls[0][0], harness.target);
});

test("非分片站点不建立邻页关系", () => {
  const harness = makeObserversRuntime({ IS_STRIP_TILE_READER: false, IS_KAKAOPAGE_READER: false });
  harness.runtime.registerTarget(harness.target);
  assert.equal(harness.calls.length, 0);
});

test("阅读顺序取布局坐标，内层滚动容器不影响它", () => {
  const outer = { nodeType: 1, offsetTop: 120, offsetParent: null };
  const inner = { nodeType: 1, offsetTop: 400, offsetParent: outer };
  const target = fakeImage({ nodeType: 1, offsetTop: 720, offsetParent: inner });
  assert.equal(runtime.__test.resolveReadingOrderTop(target), 1240);

  // 没有 offset 链（离屏/脱离布局）时兜底到「视口坐标 + 各滚动祖先 scrollTop」。
  const scroller = { scrollTop: 500, parentElement: null };
  const detached = fakeImage({
    nodeType: 1,
    offsetTop: 0,
    offsetParent: null,
    parentElement: scroller,
    getBoundingClientRect: () => ({ top: 300, left: 0, right: 720, bottom: 1020, width: 720, height: 720 })
  });
  globalThis.window.scrollY = 40;
  assert.equal(runtime.__test.resolveReadingOrderTop(detached), 840);
  globalThis.window.scrollY = 0;
});

test("分片阅读器的覆盖层不再因离开视口而卸载（与跨页层行为一致）", () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  // 用户缺陷：RIDI 回收分片 DOM/图片时可见性短暂失效，覆盖层被卸载后要等下一次渲染
  // 才回来，滚动时表现为「覆盖层被拖开一下、再跳回文字处」。
  assert.equal(runtime.__test.shouldHideOverlayRoot(rect, false, true), false,
    "keepMounted 时即使当前不可见也保持挂载");
  assert.equal(runtime.__test.shouldHideOverlayRoot(rect, false, false), true,
    "非分片站点仍然按可见性卸载");
  assert.equal(runtime.__test.shouldHideOverlayRoot({ ...rect, width: 0 }, true, true), true,
    "没有几何信息时任何情况下都不留壳");
});

test("分片长条阅读器的邻片拼接 OCR 对 RIDI 生效（截页缺半行的根因）", () => {
  const payload = {
    dataUrl: "data:image/jpeg;base64,AAAA",
    width: 1280,
    height: 1280
  };
  const target = fakeImage();
  const modes = runtime.__test.getCaptureRenderModes();
  assert.equal(modes.captureMode, "direct");
  assert.equal(modes.renderMode, "overlay");
  // 拼接能力原先只认 Kakao 站名，RIDI 永远退回单图 OCR：跨分片边界的一行字
  // 在单片里只剩半行，译文因此缺字。
  assert.equal(runtime.__test.shouldUseKakaoStitchedOcr(target, payload), true);
  assert.equal(runtime.__test.shouldUseKakaoStitchedOcr(target, { ...payload, kakaoOverlapCrop: true }), false);
  assert.equal(runtime.__test.shouldUseKakaoStitchedOcr({}, payload), false);
});

test("分片页的整页 OCR 请求带上接缝带提示（被剪断的行才摘得出来）", () => {
  const payload = {
    dataUrl: "data:image/jpeg;base64,AAAA",
    width: 1280,
    height: 1280
  };
  const pageMessage = runtime.__test.buildOcrMessageForPayload(payload, {
    sourceType: "page",
    pageIds: ["page-a"],
    imageRevisionByPage: { "page-a": "rev-a" }
  });
  // 1280 宽分片的接缝带 = clamp(round(1280 * 0.15), 64, 96) = 96。后台据此把「真的被
  // 画布剪断的那一行」从段落里摘出来独立成观测，接缝复合图读到的那一行才有挂载位置；
  // 没有这个提示，整段会被并成一个块，同一行就会出现页级残缺读法 + 接缝面两份覆盖。
  assert.equal(pageMessage.imageMeta.edgeLineBandPx, 96);
  const seamMessage = runtime.__test.buildOcrMessageForPayload(payload, {
    sourceType: "seam",
    pageIds: ["page-a", "page-b"],
    imageRevisionByPage: { "page-a": "rev-a", "page-b": "rev-b" }
  });
  assert.equal(seamMessage.imageMeta.edgeLineBandPx, undefined, "接缝请求本身跨两页，不该再摘行");
});

/**
 * 断言某个模块的漫画分片链路已经彻底按「分片长条能力」放行：
 * 既不能残留 Kakao 站名门禁（RIDI 会被挡在外面），也必须带上新的能力判据。
 * marker 传该门禁的整行源码，避免正则跨函数误判。
 */
function assertStripTileGate(moduleName, marker) {
  const source = contentModuleSource(moduleName);
  assert.doesNotMatch(source, /runtime\.IS_KAKAOPAGE_READER/u,
    `${moduleName} 的漫画分片链路不应再按 Kakao 站名放行`);
  assert.ok(source.includes(marker), `${moduleName} 缺少能力门禁：${marker}`);
}

test("接缝/跨片处理按分片能力放行，不再只认 Kakao 站名", () => {
  // 跨片去重与视觉去重：同一句被相邻两片各识别一次时只留一份译文。
  assertStripTileGate("recognition-stitch.js",
    "if (!runtime.IS_STRIP_TILE_READER || !result || !Array.isArray(result.bubbles) || !targetKey) {");
  assertStripTileGate("renderer-overlay.js",
    'if (!runtime.IS_STRIP_TILE_READER || !runtime.KP || typeof runtime.KP.selectKakaoVisualDuplicateLoser !== "function") {');
  // 分片重叠像素裁剪（相邻片带一段重复像素）。
  assertStripTileGate("recognition-overlap.js",
    "if (!runtime.IS_STRIP_TILE_READER || !payload || !runtime.isSupportedTarget(target)) {");
  // 碎片片（短页）在邻居拼接期间被附着时的排队门禁与释放。
  assertStripTileGate("scheduler.js",
    "if (!runtime.IS_STRIP_TILE_READER || runtime.shouldUseKakaoCanonicalPipeline(target)) {");
  // 未加载分片取不到字节时按可重试状态处理，而不是记成一次失败的 OCR。
  assertStripTileGate("capture-payload.js",
    "if (runtime.IS_STRIP_TILE_READER && img.isConnected");
  // 分片分页的自动翻译重试与节流。
  assertStripTileGate("recognition-workflow.js",
    "if (runtime.IS_STRIP_TILE_READER && runtime.state.autoTranslatePageEnabled && options.manual) {");
  assertStripTileGate("controls-autotranslate.js",
    "if (runtime.IS_STRIP_TILE_READER && !runtime.isTranslationRecoveryDue(target)) {");
  assertStripTileGate("controls-autotranslate.js",
    "return runtime.collectKakaopageManualTargetCandidates(relaxed);");
  // 分片被 DOM 回收、多数时候只露出一部分：低可见面积阈值必须对 RIDI 生效。
  assertStripTileGate("target-filter.js",
    "if (runtime.IS_STRIP_TILE_READER && !runtime.passesKakaopageTargetGeometry(target, rect, manual, relaxed, allowOffscreen)) {");
  // 长会话下 service worker 常驻，避免冷启动窗口里丢消息导致某一片永远没译文。
  assertStripTileGate("reader-init.js",
    "if (!runtime.IS_STRIP_TILE_READER || runtime.state.keepAlivePort) return;");
  assertStripTileGate("scene-dispatch.js",
    "if (runtime.ENABLE_PIPELINE_TRACE && runtime.IS_STRIP_TILE_READER) {");
});

test("页面覆盖层与跨页覆盖层共用同一帧同步节奏", () => {
  const readerInit = contentModuleSource("reader-init.js");
  const lifecycleBubble = contentModuleSource("lifecycle-bubble.js");
  const lifecyclePosition = contentModuleSource("lifecycle-position.js");

  // 逐帧同步里必须同时刷新跨页层，否则它在滚动期间停在旧位置。
  assert.match(readerInit, /runtime\.syncCrossPageOverlayGeometry\(\)/u);
  assert.match(readerInit, /overlaysById\.size > 0 \|\| hasCrossPageOverlays\(\)/u);
  // 只有跨页层时也要启动逐帧同步（syncAllOverlays 的入口条件）。
  assert.match(lifecycleBubble, /overlaysById\.size > 0 \|\| \(runtime\.hasCrossPageOverlays/u);
  // 页面覆盖层与跨页层统一为「滚动容器内挂载」：整章保持挂载，坐标相对层原点。
  assert.match(lifecyclePosition, /const keepMounted = true;/u);
  assert.match(lifecyclePosition, /shouldHideOverlayRoot\(rect, visible, keepMounted\)/u);
  assert.match(lifecyclePosition, /runtime\.ensureOverlayLayer\(overlayState\.target\)/u);
  assert.match(lifecyclePosition, /runtime\.getOverlayPositionRect\(rect, layerOrigin\)/u);
  // 层必须挂在滚动容器里，否则滚动时又要靠 rAF 追赶。
  const overlayHost = contentModuleSource("overlay-host.js");
  const controlsUi = contentModuleSource("controls-ui.js");
  assert.match(overlayHost, /function resolveOverlayHost\(target\)/u);
  assert.match(overlayHost, /isOverlayScrollHost\(node\)/u);
  assert.match(controlsUi, /runtime\.ensureOverlayHostLayer\(target\)|runtime\.ensureOverlayLayerOnHost\(target\)/u);
});
