import assert from "node:assert/strict";
import test from "node:test";
import { installReaderObservers } from "../extension/src/content/modules/reader-observers.js";
import { installLifecyclePosition } from "../extension/src/content/modules/lifecycle-position.js";
import { installRecognitionBinding } from "../extension/src/content/modules/recognition-binding.js";
import { installControlsUi } from "../extension/src/content/modules/controls-ui.js";

/* ---------------------------------------------------------------------------
 * 背景：RIDI 是「同一 <img> 原地换 src」的一图多页分片阅读器。滚回已翻译分片
 * 时，dataset.mtLastTranslatedKey 只记得「最后一次翻译的页」（computeTargetKey
 * 按 src URL 派生），恢复扫描的标记门槛结构性跳过；换图分支又无条件删除
 * localResultCache/payloadCache 且不恢复页 handle 绑定，导致免 OCR 重投影的
 * 三条取回路径全部不可达，只剩「完整重翻」这条概率路径 —— 用户看到译文消失。
 *
 * 本文件验证三层修复：
 * 1) 换图分支 canonical 下保留按 URL 隔离的缓存条目（非 canonical 行为不变）；
 * 2) 换图后按 sourceToken 唯一匹配恢复页 handle（runCached 免 OCR 的前提）；
 * 3) 恢复扫描对滚回页重发现 handle → 重投影，而不是直接重翻。
 * ------------------------------------------------------------------------- */

function makeElement(tag = "div") {
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentElement: null,
    isConnected: true,
    dataset: {},
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    remove() {
      this.isConnected = false;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 1200, width: 800, height: 1200 };
    }
  };
  return element;
}

/** 分片 img 替身：__src 模拟 currentSrc（getQuickSourceToken 的取值源）。 */
function makeSliceImage(src) {
  const img = makeElement("img");
  img.__src = src;
  img.complete = true;
  return img;
}

const domTargets = [];
// reader-observers 的 load-listener 分支判定 `target instanceof HTMLImageElement`：
// Node 里该全局不存在会直接 ReferenceError；定义为空类让替身元素判定为 false，
// 恰好跳过 load 监听分支（本文件不测图片加载时序）。
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.document = {
  documentElement: makeElement("html"),
  body: makeElement("body"),
  createElement: tag => makeElement(tag),
  querySelectorAll: () => domTargets
};
// scheduleKakaoProjectionRefresh 用 window.setTimeout 调度 refresh。
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms || 0),
  innerWidth: 800,
  innerHeight: 600
};

function makeRuntime() {
  const runtime = {
    TARGET_SELECTOR: "img",
    MAX_RECOVERY_TARGETS: 4,
    RECOVERY_SCAN_GAP_MS: 200,
    IS_STRIP_TILE_READER: false,
    // 全放行的目标判定；canonical 与否由元素 __canonical 标记区分
    isSupportedTarget: () => true,
    shouldSkipNovelMediaTarget: () => false,
    isSitePreferredTarget: () => true,
    shouldUseKakaoCanonicalPipeline: target => target.__canonical !== false,
    shouldRevalidateReconnectedKakaoTarget: () => false,
    shouldRevalidateKakaoImageLoad: () => false,
    passesTargetFilter: () => true,
    isRectVisible: () => true,
    getVisibleArea: () => 1000,
    isTargetVisible: () => true,
    isScreenshotCaptureMode: () => false,
    getVisibleViewportRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    getQuickSourceToken: target => String(target.__src || ""),
    computeTargetKey: target => `img|${String(target.__src || "")}|800x1200`,
    buildTargetSourceCacheKey: (targetKey, token) => `${targetKey}|${token}`,
    // 观测记录：测试断言「谁被调用了、谁没被调用」
    calls: {
      queueTranslate: [],
      queuePageAutoTranslate: [],
      refresh: [],
      clearRenderedTarget: 0
    },
    kakaoRetryScheduler: {
      cancel() {},
      schedule() {},
      clear() {}
    },
    io: { observe() {} },
    tracePipeline() {},
    debugTargetFilter() {},
    clearKakaoLoadingOverlay() {},
    getExistingRenderedState: () => null,
    getTargetId: () => 0,
    queueTranslate(target, options) {
      runtime.calls.queueTranslate.push(options);
    },
    queuePageAutoTranslate(target) {
      runtime.calls.queuePageAutoTranslate.push(target);
    },
    clearRenderedTarget() {
      runtime.calls.clearRenderedTarget += 1;
    }
  };
  runtime.state = {
    invalidated: false,
    lastRecoveryAt: 0,
    observedTargets: new Set(),
    kakaoLoadListenerTargets: new Set(),
    payloadCacheByTargetKey: new Map(),
    localResultCache: new Map(),
    queuedTargets: new Set(),
    queue: [],
    inflightByTarget: new Map(),
    targetIdByElement: new Map(),
    kakaoPageIdByTarget: new Map(),
    kakaoImageRevisionByTarget: new Map(),
    kakaoTargetsByPageId: new Map(),
    kakaoProjectionRefreshPageIds: new Set(),
    kakaoProjectionRefreshTimer: 0,
    io: { observe() {} },
    autoTranslatePageEnabled: true,
    enabled: true,
    pretranslateMode: "off",
    pendingKakaoAdjacency: new Set()
  };
  // 假 kakaoStore：页 handle 存活于 store（canonical 从不删除）——滚回复用的数据源。
  const pages = new Map();
  runtime.state.kakaoStore = {
    cancelPageJob() {},
    clearShortPage() {},
    deleteEntriesForKey() {},
    getPageHandle: pageId => pages.get(String(pageId)) || null,
    getPageHandles: () => Array.from(pages.values()),
    getPageHandleForTarget: target => Array.from(pages.values()).find(handle => handle.target === target) || null,
    registerPageHandle: handle => pages.set(String(handle.pageId), handle),
    unbindPageTarget: target => {
      for (const handle of pages.values()) {
        if (handle.target === target) handle.target = null;
      }
    }
  };
  runtime.storePages = pages;
  // recognition-binding 安装期解构 runtime.KP（L260），给最小桩即可（懒执行路径不触达）
  runtime.KP = { isKakaoPageEdgeSource: () => false };
  runtime.kakaoCanonicalPipeline = {
    refresh: async input => {
      runtime.calls.refresh.push(input);
      return { ok: true };
    }
  };
  // bindKakaoTargetToPage 的等价 stub（语义对齐 recognition-payload.js）：
  // 避免为三行 Map 操作牵入 payload 依赖链。恢复绑定的断言直接观测这三个 Map。
  runtime.bindKakaoTargetToPage = (target, pageId, imageRevision = "") => {
    if (!target || !pageId) return;
    const previousPageId = runtime.state.kakaoPageIdByTarget.get(target);
    if (previousPageId && previousPageId !== pageId) {
      const previousTargets = runtime.state.kakaoTargetsByPageId.get(previousPageId);
      if (previousTargets) {
        previousTargets.delete(target);
        if (previousTargets.size === 0) runtime.state.kakaoTargetsByPageId.delete(previousPageId);
      }
    }
    runtime.state.kakaoPageIdByTarget.set(target, pageId);
    const storedRevision = runtime.state.kakaoStore.getPageHandle(pageId)?.imageRevision || "";
    const currentRevision = String(imageRevision || storedRevision || "");
    if (currentRevision) {
      runtime.state.kakaoImageRevisionByTarget.set(target, currentRevision);
    } else {
      runtime.state.kakaoImageRevisionByTarget.delete(target);
    }
    const targets = runtime.state.kakaoTargetsByPageId.get(pageId) || new Set();
    targets.add(target);
    runtime.state.kakaoTargetsByPageId.set(pageId, targets);
  };
  // marker 函数（matchesTargetMarker/hasSettledTranslatedMarker/...）由
  // installControlsUi 提供真实实现；安装器只挂载函数，无 DOM 副作用。
  installControlsUi(runtime);
  installRecognitionBinding(runtime);
  installReaderObservers(runtime);
  installLifecyclePosition(runtime);
  return runtime;
}

const KEY_PAGE_N = "img|cdn/page-n.jpg|800x1200|cdn/page-n.jpg";

test("canonical 换图分支保留缓存条目，非 canonical 行为不变", () => {
  const runtime = makeRuntime();
  const rollingBack = makeSliceImage("cdn/page-n.jpg");
  rollingBack.dataset.mtSourceToken = "cdn/page-m.jpg";
  rollingBack.dataset.mtLastTranslatedKey = KEY_PAGE_N;
  runtime.state.localResultCache.set(KEY_PAGE_N, { bubbles: [{}] });
  runtime.state.payloadCacheByTargetKey.set(KEY_PAGE_N, { payload: {}, timestamp: Date.now() });

  runtime.registerTarget(rollingBack);
  assert.ok(runtime.state.localResultCache.has(KEY_PAGE_N),
    "canonical 滚回旧分片：渲染结果缓存必须保留（免 OCR 重投影的数据源）");
  assert.ok(runtime.state.payloadCacheByTargetKey.has(KEY_PAGE_N),
    "canonical 滚回旧分片：payload 缓存必须保留");
  assert.equal(rollingBack.dataset.mtLastTranslatedKey, "", "换图分支仍要清空 stale 标记");
  assert.equal(runtime.calls.clearRenderedTarget, 1, "旧气泡仍要清理");

  const plain = makeSliceImage("cdn/page-x.jpg");
  plain.__canonical = false;
  plain.dataset.mtSourceToken = "cdn/page-y.jpg";
  plain.dataset.mtLastTranslatedKey = "k-x";
  runtime.state.localResultCache.set("k-x", { bubbles: [] });
  runtime.registerTarget(plain);
  assert.ok(!runtime.state.localResultCache.has("k-x"), "非 canonical 阅读器行为不变：换图仍删除缓存");
});

test("canonical 换回旧分片后按 sourceToken 唯一匹配恢复页 handle 并触发重投影", async () => {
  const runtime = makeRuntime();
  const rollingBack = makeSliceImage("cdn/page-n.jpg");
  rollingBack.dataset.mtSourceToken = "cdn/page-m.jpg";
  runtime.storePages.set("page-n", { pageId: "page-n", sourceToken: "cdn/page-n.jpg", imageRevision: "rev-1", target: null });

  runtime.registerTarget(rollingBack);
  assert.equal(runtime.state.kakaoPageIdByTarget.get(rollingBack), "page-n",
    "换回旧分片必须恢复页绑定（runCached 免 OCR 的前提）");
  assert.equal(runtime.storePages.get("page-n").target, rollingBack, "store handle 重新指向该 img");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(runtime.calls.refresh.some(input => (input.focusPageIds || []).includes("page-n")),
    "恢复绑定后必须触发投影刷新");

  // 同 sourceToken 多 handle（复用 DOM 撞上旧 revision）→ 不得误绑
  const ambiguous = makeSliceImage("cdn/page-n.jpg");
  ambiguous.dataset.mtSourceToken = "cdn/page-m.jpg";
  runtime.storePages.set("page-n2", { pageId: "page-n2", sourceToken: "cdn/page-n.jpg", imageRevision: "rev-1", target: null });
  runtime.registerTarget(ambiguous);
  assert.equal(runtime.state.kakaoPageIdByTarget.get(ambiguous), undefined,
    "同 token 多 handle 时不得误绑（restoreKnownKakaoPageHandle 唯一性校验）");
});

test("恢复扫描对滚回旧分片重发现 handle：重投影而非直接重翻", async () => {
  const runtime = makeRuntime();
  const rollingBack = makeSliceImage("cdn/page-n.jpg");
  // 第一次 registerTarget：从 page-m 换回 page-n。此刻 store handle 尚未就绪
  // （OCR 未完成，imageRevision 为 null）→ restore 失败、标记被清空。
  rollingBack.dataset.mtSourceToken = "cdn/page-m.jpg";
  runtime.registerTarget(rollingBack);
  assert.equal(runtime.state.kakaoPageIdByTarget.get(rollingBack), undefined);

  // store 就绪（handle 完成 OCR，译文已结算在 store 页缓存），随后进入恢复扫描。
  runtime.storePages.set("page-n", { pageId: "page-n", sourceToken: "cdn/page-n.jpg", imageRevision: "rev-1", target: null });
  runtime.state.localResultCache.set(KEY_PAGE_N, { bubbles: [{}] });
  domTargets.push(rollingBack);
  runtime.recoverRenderedTargets();
  assert.equal(runtime.state.kakaoPageIdByTarget.get(rollingBack), "page-n",
    "恢复扫描必须把滚回页重新绑定到 store handle");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(runtime.calls.refresh.some(input => (input.focusPageIds || []).includes("page-n")),
    "重绑定触发投影刷新（reconcile 复用已有 OCR 证据、已结算译文直接重投影）");
  assert.ok(runtime.state.localResultCache.has(KEY_PAGE_N), "恢复过程不得删除渲染结果缓存");
  assert.equal(runtime.calls.queueTranslate.length, 0, "恢复扫描本身不得直接发起翻译");
});

test("store 无 handle 的新页照旧入队，不触发重投影", () => {
  const runtime = makeRuntime();
  const fresh = makeSliceImage("cdn/page-new.jpg");
  fresh.dataset.mtSourceToken = "cdn/page-new.jpg"; // 已登记过、无换图
  runtime.registerTarget(fresh);
  runtime.calls.queuePageAutoTranslate.length = 0;
  runtime.calls.refresh.length = 0;
  domTargets.push(fresh);

  runtime.recoverRenderedTargets();
  assert.equal(runtime.state.kakaoPageIdByTarget.get(fresh), undefined, "无 handle 不得凭空绑定");
  assert.equal(runtime.calls.refresh.length, 0, "无 handle 不触发投影刷新");
  assert.ok(runtime.calls.queuePageAutoTranslate.includes(fresh),
    "无 handle 的未翻页照旧走 pending 分支入队（绑定健康时重发现分支不拦截）");
});

test("一图一页阅读器标记匹配时走原 overlay-recovery 路径，零回归", () => {
  const runtime = makeRuntime();
  const resident = makeSliceImage("cdn/page-r.jpg");
  resident.dataset.mtSourceToken = "cdn/page-r.jpg";
  const scopedKey = `${runtime.computeTargetKey(resident)}|cdn/page-r.jpg`;
  resident.dataset.mtLastTranslatedKey = scopedKey;
  // 绑定健康：handle 指向自身、revision 一致、绑定集合在册（重发现分支不拦截）
  runtime.storePages.set("page-r", { pageId: "page-r", sourceToken: "cdn/page-r.jpg", imageRevision: "rev-1", target: resident });
  runtime.state.kakaoPageIdByTarget.set(resident, "page-r");
  runtime.state.kakaoImageRevisionByTarget.set(resident, "rev-1");
  runtime.state.kakaoTargetsByPageId.set("page-r", new Set([resident]));
  domTargets.push(resident);

  runtime.recoverRenderedTargets();
  const recovery = runtime.calls.queueTranslate.filter(options => options && options.reason === "overlay-recovery");
  assert.equal(recovery.length, 1, "标记匹配的已翻页照旧走 canonical 恢复入队");
  assert.ok(runtime.calls.refresh.length === 0, "绑定健康的在册页不触发额外投影刷新");
});
