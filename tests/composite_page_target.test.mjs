import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { installCompositePage } from "../extension/src/content/modules/composite-page.js";
import { detectReaderProfile } from "../extension/src/readers/profile.js";

const root = path.resolve(import.meta.dirname, "..");
const readModule = name => fs.readFileSync(path.join(root, "extension", "src", "content", "modules", name), "utf8");

/* ---------------------------------------------------------------------------
 * 「一整页 = 一个容器 + 若干瓦片图」的站点能力。
 *
 * 现场（CMOA speedreader）：#content-p15 > .pt-img（616x876）> 3 个包装 div >
 * img（各 617x293 CSS / 1127x536 天然图，top = 0 / 291 / 583）。以前 TARGET_SELECTOR
 * 是裸 img，于是同一页的 3 条瓦片各成一个「页面」各跑一次 OCR，跨瓦片边界的竖排台词
 * 被拦腰截断。这里锁住修复后的语义：容器是唯一目标、瓦片按版面位置拼成整页一张图。
 * ------------------------------------------------------------------------- */

/* --------------------------- 假 DOM（只覆盖用到的能力） --------------------------- */

function matchesSimple(node, selector) {
  const text = String(selector || "").trim();
  if (!text) return false;
  if (text.startsWith(".")) return node.classList.contains(text.slice(1));
  if (text.startsWith("#")) return node.id === text.slice(1);
  if (text.startsWith("[")) return node.dataset.mangaTranslatorOverlay === "true";
  return node.tagName === text.toUpperCase();
}

function makeNode(tag, { id = "", classes = [], dataset = {}, rect = null } = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id,
    dataset: { ...dataset },
    children: [],
    parentElement: null,
    isConnected: true,
    complete: true,
    naturalWidth: 0,
    __rect: rect,
    listeners: {},
    appendChild(child) {
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      (node.listeners[type] = node.listeners[type] || []).push(handler);
    },
    getBoundingClientRect() {
      return node.__rect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    },
    matches(selector) {
      return String(selector).split(",").some(part => matchesSimple(node, part));
    },
    closest(selector) {
      const parts = String(selector).split(",");
      for (let current = node; current; current = current.parentElement) {
        if (parts.some(part => matchesSimple(current, part))) return current;
      }
      return null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = element => element.children.forEach(child => {
        if (matchesSimple(child, selector)) found.push(child);
        walk(child);
      });
      walk(node);
      return found;
    }
  };
  node.classList = {
    contains: name => classes.includes(name),
    add: name => { if (!classes.includes(name)) classes.push(name); },
    remove: name => { const index = classes.indexOf(name); if (index >= 0) classes.splice(index, 1); },
    toggle: name => { if (classes.includes(name)) classes.splice(classes.indexOf(name), 1); else classes.push(name); }
  };
  return node;
}

function makeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    draws: [],
    toDataURL() { return "data:image/jpeg;base64,Y29tcG9zaXRl"; }
  };
  canvas.getContext = () => ({
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "",
    drawImage: (...args) => canvas.draws.push(args)
  });
  return canvas;
}

globalThis.HTMLImageElement = class HTMLImageElement {};
/** 采集用的画布实例都留一份，用来断言真正的拼接几何。 */
const createdCanvases = [];
globalThis.document = {
  documentElement: makeNode("html"),
  createElement: tag => {
    if (String(tag).toLowerCase() === "canvas") {
      const canvas = makeCanvas();
      createdCanvases.push(canvas);
      return canvas;
    }
    return makeNode(tag);
  }
};

/* ------------------------------- 运行时 stub ------------------------------- */

function makeRuntime() {
  const runtime = {
    readerProfile: { pageComposite: true, targetSelector: ".pt-img" },
    state: { kakaoLoadListenerTargets: new WeakSet() },
    IMAGE_MAX_SIDE: 1536,
    IMAGE_JPEG_QUALITY: 0.82,
    isDataUrl: value => /^data:image\//u.test(String(value || "")),
    resolveImageUrl: img => String(img.currentSrc || img.dataset.url || ""),
    passesTargetFilter: () => true,
    SCREENSHOT_TARGET_NOT_VISIBLE: "Target is not visible enough for screenshot capture",
    queuePageAutoTranslate: () => {},
    registerTarget: () => {},
    captureVisibleTargetPayload: () => {
      throw new Error("should not fall back to screenshot in this test");
    }
  };
  installCompositePage(runtime);
  return runtime;
}

/** 真实 CMOA 结构：容器 616x876，3 条瓦片各 617 宽、293 高、天然 1127x536。 */
function buildCmoaPage({ bandCount = 3, containerLeft = 238 } = {}) {
  const container = makeNode("div", {
    classes: ["pt-img"],
    rect: { left: containerLeft, top: 0, width: 616, height: 876, right: containerLeft + 616, bottom: 876 }
  });
  const tops = [0, 291, 583];
  const bands = [];
  for (let index = 0; index < bandCount; index += 1) {
    const top = tops[index] ?? index * 291;
    const height = index === 2 ? 295 : 293;
    const img = makeNode("img", { dataset: { url: `blob:https://www.cmoa.jp/band-${index}` } });
    img.naturalWidth = 1127;
    img.naturalHeight = 536;
    img.__rect = { left: containerLeft, top, width: 617, height, right: containerLeft + 617, bottom: top + height };
    const wrapper = makeNode("div");
    wrapper.appendChild(img);
    container.appendChild(wrapper);
    bands.push(img);
  }
  return { container, bands };
}

/* ---------------------------------- 用例 ---------------------------------- */

test("CMOA 站点提示声明整页容器能力，其余站点不受影响", () => {
  const cmoa = detectReaderProfile({ querySelectorAll: () => [], querySelector: () => null }, {
    hostname: "www.cmoa.jp", pathname: "/bib/speedreader/"
  });
  assert.equal(cmoa.siteHint, "cmoa");
  assert.equal(cmoa.pageComposite, true, "一页 3 条瓦片必须按整页拼，不能再按裸 img 选目标");
  assert.equal(cmoa.targetSelector, "#content .pt-img");
  assert.equal(cmoa.tiledStrip, false, "瓦片边界在页内部，不需要接缝 OCR 那条路");

  const kakao = detectReaderProfile({ querySelectorAll: () => [], querySelector: () => null }, {
    hostname: "page.kakao.com", pathname: "/"
  });
  assert.equal(kakao.pageComposite, false);
  assert.equal(kakao.tiledStrip, true);
});

test("容器是唯一目标：容器内部的瓦片 img 不再单独成目标", () => {
  const runtime = makeRuntime();
  const { container, bands } = buildCmoaPage();
  assert.equal(runtime.isCompositePageTarget(container), true);
  bands.forEach(band => {
    assert.equal(runtime.isCompositePageTarget(band), false, "瓦片不能自成目标");
    assert.equal(runtime.compositePageTargetOf(band), container, "瓦片归属于它所在的整页容器");
  });
});

test("瓦片按文档顺序收集，跳过未加载与扩展自己画的层", () => {
  const runtime = makeRuntime();
  const { container, bands } = buildCmoaPage();
  assert.deepEqual(runtime.compositePageBands(container), bands);

  bands[1].naturalWidth = 0;
  assert.deepEqual(runtime.compositePageBands(container), [bands[0], bands[2]], "还没解码的瓦片不算");

  bands[1].naturalWidth = 1127;
  const overlayLayer = makeNode("div", { classes: ["mt-overlay-layer"] });
  const embedded = makeNode("img", { dataset: { url: "data:image/png;base64,eA==" } });
  embedded.naturalWidth = 10;
  overlayLayer.appendChild(embedded);
  container.appendChild(overlayLayer);
  assert.deepEqual(runtime.compositePageBands(container), bands, "覆盖层里的图不能画进整页图");
});

test("目标身份 = 瓦片集合：换页（URL 变）必须换身份，无瓦片时为空", () => {
  const runtime = makeRuntime();
  const { container, bands } = buildCmoaPage();
  const before = runtime.compositePageSourceToken(container);
  assert.match(before, /^page-composite:3\|/u);
  assert.equal(runtime.compositePageSourceToken(container), before, "同一页必须稳定");
  bands[2].dataset.url = "blob:https://www.cmoa.jp/other-page";
  assert.notEqual(runtime.compositePageSourceToken(container), before, "阅读器回收 DOM 换页后身份必须变");

  const empty = buildCmoaPage().container;
  empty.querySelectorAll("img").forEach(img => { img.naturalWidth = 0; });
  assert.equal(runtime.compositePageSourceToken(empty), "");
});

test("整页采集：瓦片按版面位置画进一张画布，分辨率受 IMAGE_MAX_SIDE 限制", async () => {
  const runtime = makeRuntime();
  const { container, bands } = buildCmoaPage();
  const payload = await runtime.extractCompositePagePayload(container);
  assert.equal(payload.source, "page-composite");
  // 天然尺度 1127/617 = 1.827，但整页 876 高乘上去会到 1600 > IMAGE_MAX_SIDE，
  // 于是按 1536/876 = 1.753 收口：616 -> 1080，876 -> 1536。
  assert.equal(payload.width, 1080);
  assert.equal(payload.height, 1536);
  assert.equal(payload.cssWidth, 616);
  assert.equal(payload.cssHeight, 876);
  assert.match(payload.dataUrl, /^data:image\/jpeg/u);

  const canvas = createdCanvases.at(-1);
  assert.equal(canvas.width, 1080);
  assert.equal(canvas.height, 1536);
  const scale = 1536 / 876;
  assert.deepEqual(
    canvas.draws.map(args => args.slice(1)),
    bands.map(band => {
      const rect = band.getBoundingClientRect();
      return [0, Math.round(rect.top * scale), Math.round(rect.width * scale), Math.round(rect.height * scale)];
    }),
    "每条瓦片按它相对容器的版面位置落位（x 0 / y 依次下移），拼出来就是完整一页"
  );
  assert.deepEqual(canvas.draws.map(args => args[0]), bands, "瓦片按文档顺序画，先上后下");
});

test("瓦片没加载完时按「目标不可见」上报，交给重试而不是记成失败", async () => {
  const runtime = makeRuntime();
  const { container } = buildCmoaPage();
  container.querySelectorAll("img").forEach(img => { img.naturalWidth = 0; });
  await assert.rejects(() => runtime.extractCompositePagePayload(container), error => {
    assert.equal(error.message, runtime.SCREENSHOT_TARGET_NOT_VISIBLE);
    return true;
  });
});

test("媒体就绪判据：整页容器看瓦片齐不齐，普通 img 看 complete", () => {
  const runtime = makeRuntime();
  const { container, bands } = buildCmoaPage();
  assert.equal(runtime.isTargetMediaReady(container), true);
  bands.forEach(band => { band.naturalWidth = 0; });
  assert.equal(runtime.isTargetMediaReady(container), false);

  const image = makeNode("img");
  Object.setPrototypeOf(image, globalThis.HTMLImageElement.prototype);
  image.complete = false;
  assert.equal(runtime.isTargetMediaReady(image), false);
  image.complete = true;
  assert.equal(runtime.isTargetMediaReady(image), true);
});

test("装配连线：扫节点、目标过滤与身份/采集分派都认得整页容器", () => {
  // 整页容器自身也可能是新增子树的根（它不在自己的子孙里），scanNode 必须单独登记它，
  // 否则整页刚插入的那一拍会被漏掉。
  assert.match(readModule("reader-init.js"), /isCompositePageTarget\?\.\(node\)[\s\S]{0,140}?registerTarget\(node\)/u);
  // 瓦片 img 的拦截必须放在 allowLoose 回退**之前**：relaxed 时下面那条
  // [class*='page'] 会把瓦片重新放进来，同一页就被翻两遍。
  const filter = readModule("target-filter.js");
  const guard = filter.indexOf("runtime.compositePageTargetOf(target)");
  const looseFallback = filter.indexOf("if (!allowLoose)");
  assert.ok(guard > 0, "isSitePreferredTarget 必须挡掉容器内部的瓦片 img");
  assert.ok(looseFallback > guard, "拦截要在 allowLoose 回退之前");
  // 身份 / 支持性 / 采集三处分派：漏任何一处都会让整页目标走回单图路径。
  assert.match(readModule("target-resolve.js"), /isCompositePageTarget\(target\)/u, "getQuickSourceToken");
  assert.match(filter, /isCompositePageTarget\(target\)/u, "computeTargetKey");
  assert.match(readModule("platform-runtime.js"), /isCompositePageTarget\(target\)/u, "isSupportedTarget");
  assert.match(readModule("recognition-payload.js"), /isCompositePageTarget\(target\)/u, "extractTargetPayload");
  assert.match(readModule("scene-dispatch.js"), /isCompositePageTarget\?\.\(target\)/u, "shouldUseEmbeddedRender");
});
