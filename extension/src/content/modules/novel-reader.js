import { installKakaoNovelReader } from "./novel-kakao-reader.js";
import { installNovelParagraphs } from "./novel-paragraph.js";
import { installRidiNovelReader } from "./novel-ridi-reader.js";

/**
 * 小说模式的公共层：站点无关的「表面发现 → 章节抽取 → 渲染回填 → 重扫」。
 *
 * 站点差异全部收敛在两个适配器里（KakaoPage 的 shadow DOM + 页面自带 data-p-id、
 * RIDI 的普通 DOM + 我们盖章的内容锚点），这里只做分发，因此第三家小说站只需要
 * 再加一个适配器，管线一行都不用动。
 */
export function installNovelReader(runtime) {
  installNovelParagraphs(runtime);
  installKakaoNovelReader(runtime);
  installRidiNovelReader(runtime);

  function getNovelState() {
    if (!runtime.state.novel) {
      runtime.state.novel = {
        surface: null,
        rootObserver: null,
        reconcileTimer: 0,
        translations: new Map(),
        // 「让模型排版」:段落 id → 带 ⟦⟧ 标记的译文(见 novel-emphasis-align.js);
        // emphasisAligned 记「这段译文已经问过模型了」,避免 reconcile 反复重发。
        emphasisMarks: new Map(),
        emphasisAligned: new Map(),
        // 已经写进 DOM 的那一版内容(id → 渲染键):reconcile 每 80ms 会重扫一次,
        // 没有这层记账就会把同样的译文反复重写,而重写本身又触发观察器 —— 自我激发的改写循环。
        renderedKeys: new Map(),
        textDiagnostics: [],
        lastTextErrors: [],
        imageJobs: new Map(),
        imageContexts: new Map(),
        imageResults: new Map(),
        imagePanel: null,
        imagePanelBody: null,
        imagePanelOpen: false,
        textStatus: "idle",
        imageStatus: "idle",
        showTranslation: false,
        chapterKey: "",
        cacheStatus: "none",
        cacheCheckedKey: "",
        cacheAnalysisPending: false,
        cacheBadgeUntil: 0,
        cacheSavedIds: new Set(),
        taskId: "",
        serviceOnline: false,
        pendingParagraphs: new Set(),
        progress: {
          textDone: 0,
          textTotal: 0,
          imageDone: 0,
          imageTotal: 0,
          textPhase: "",
          imagePhase: "",
          textDiagnostic: "",
          textWarning: "",
          textDiagnosticDetails: null
        }
      };
    }
    return runtime.state.novel;
  }
  runtime.getNovelState = getNovelState;

  function findNovelSurface() {
    return runtime.findKakaoNovelSurface() || runtime.findRidiNovelSurface();
  }
  runtime.findNovelSurface = findNovelSurface;

  /**
   * 段落锚点在不同站点来自不同地方（页面自带 / 我们盖章），定位一律走
   * surface.anchorAttribute，绝不硬编码属性名。
   */
  function novelAnchorSelector(surface) {
    return `[${runtime.novelAnchorAttribute(surface)}]`;
  }
  runtime.novelAnchorSelector = novelAnchorSelector;

  /**
   * 当前屏的内容签名(段落的锚点值 + 源文哈希)。
   *
   * KakaoPage 是分屏阅读:翻页时复用同一个 shadow 宿主,只有宿主里的内容换掉,
   * 所以 `root` 是否变化判断不出翻屏。RIDI 的 EPUB 分节同样是随滚动续载。
   * 签名只用原文,渲染插入的译文包裹不会改变它,因此不会自激触发重译。
   */
  function novelSurfaceSignature(surface) {
    const root = surface && surface.root;
    if (!root || typeof root.querySelectorAll !== "function") return "";
    const attribute = runtime.novelAnchorAttribute(surface);
    return [...root.querySelectorAll(`[${attribute}]`)]
      .filter(node => runtime.isNovelParagraphLeaf(node, attribute))
      .map(node => {
        const text = runtime.getOriginalNovelParagraphText(node);
        const normalized = runtime.normalizeTranslationCacheText
          ? runtime.normalizeTranslationCacheText(text) : String(text || "");
        const hash = runtime.computeTranslationCacheHash
          ? runtime.computeTranslationCacheHash(normalized) : normalized;
        return `${node.getAttribute(attribute)}\u0001${hash}`;
      }).join("\u0002");
  }
  runtime.novelSurfaceSignature = novelSurfaceSignature;

  function extractNovelChapter(surface = findNovelSurface()) {
    if (!surface) return null;
    return surface.kind === "ridi"
      ? runtime.extractRidiNovelChapter(surface)
      : runtime.extractKakaoNovelChapter(surface);
  }
  runtime.extractNovelChapter = extractNovelChapter;

  function collectNovelImages(surface = findNovelSurface(), paragraphs = []) {
    if (!surface) return [];
    const content = surface.content || surface.root;
    const images = [...content.querySelectorAll("img")];
    return images.filter(isNovelContentImage).map((target, index) => {
      target.dataset.mtNovelImage = "true";
      const context = findImageTextContext(target, paragraphs);
      const resultKey = runtime.getNovelImageResultKey(target, index, surface);
      const contextId = resultKey;
      target.dataset.mtNovelResultKey = resultKey;
      target.dataset.mtNovelContextId = contextId;
      getNovelState().imageContexts.set(contextId, context);
      return { target, context, contextId, resultKey };
    });
  }
  runtime.collectNovelImages = collectNovelImages;

  function isNovelContentImage(target) {
    if (!target || runtime.isMangaTranslatorOverlayTarget(target)) return false;
    const src = String(target.currentSrc || target.src || target.getAttribute?.("src") || "");
    const alt = String(target.alt || target.getAttribute?.("aria-label") || "");
    if (!src || /\.svg(?:[?#]|$)/iu.test(src)) return false;
    if (/arrow|prev|next|setting|navigation|icon|logo|divider|spacer|이전|다음|설정/iu.test(`${src} ${alt}`)) {
      return false;
    }
    const width = Number(target.naturalWidth || target.width || target.getBoundingClientRect?.().width || 0);
    const height = Number(target.naturalHeight || target.height || target.getBoundingClientRect?.().height || 0);
    return width >= 48 && height >= 32 && width * height >= 4096;
  }
  runtime.isNovelContentImage = isNovelContentImage;

  function findImageTextContext(target, paragraphs) {
    const targetRect = target.getBoundingClientRect?.() || { top: 0 };
    const ordered = paragraphs.map(item => ({
      text: item.original_text,
      distance: Math.abs(Number(item.node.getBoundingClientRect?.().top || 0) - Number(targetRect.top || 0)),
      top: Number(item.node.getBoundingClientRect?.().top || 0)
    })).filter(item => item.text.trim()).sort((left, right) => left.distance - right.distance);
    const nearby = ordered.slice(0, 4).sort((left, right) => left.top - right.top).map(item => item.text);
    return { nearbyText: nearby.join("\n").slice(0, 4000) };
  }

  function isNovelImageTarget(target) {
    return !!(target && target.dataset && target.dataset.mtNovelImage === "true");
  }
  runtime.isNovelImageTarget = isNovelImageTarget;

  function shouldSkipNovelMediaTarget(target) {
    const surface = getNovelState().surface;
    if (!surface) return false;
    return !isNovelImageTarget(target);
  }
  runtime.shouldSkipNovelMediaTarget = shouldSkipNovelMediaTarget;

  function resolveNovelLocation(surface) {
    const href = globalThis.location?.href || "";
    if (surface && surface.kind === "ridi") {
      return runtime.novelCore.parseRidiNovelLocation(href, surface.chapterTitle, surface.seriesId);
    }
    return runtime.novelCore.parseKakaoNovelLocation(href, document.title);
  }

  function reconcileNovelReader() {
    const state = getNovelState();
    const surface = findNovelSurface();
    if (!surface) {
      state.surface = null;
      runtime.updateFloatingBallState?.();
      return null;
    }
    const rootChanged = !state.surface || state.surface.observeTarget !== surface.observeTarget;
    const locationInfo = resolveNovelLocation(surface);
    const nextChapterKey = locationInfo ? `${locationInfo.scopeKey}:${locationInfo.chapterId}` : "";
    if (state.chapterKey && nextChapterKey && state.chapterKey !== nextChapterKey) {
      runtime.restoreAllNovelText?.(surface.root);
      resetNovelNavigationState(state);
    }
    state.surface = surface;
    runtime.injectNovelStyles?.(surface.root);
    // 翻屏(同一个宿主换内容)、EPUB 续载下一分节都算 surface 变化,否则新到的内容
    // 既不会被补翻,也不会重算缓存覆盖,后面几屏会一直停在原文。
    state.surfaceSignature = novelSurfaceSignature(surface);
    if (!state.rootObserver || rootChanged) {
      state.rootObserver?.disconnect();
      state.rootObserver = new MutationObserver(() => scheduleNovelReconcile("root-mutation"));
      state.rootObserver.observe(surface.observeTarget || surface.root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "src", "srcset"]
      });
    }
    runtime.reapplyNovelTranslations?.(surface);
    runtime.updateFloatingBallState?.();
    return surface;
  }
  runtime.reconcileNovelReader = reconcileNovelReader;

  function resetNovelNavigationState(state) {
    // 换章/换作品：上一章在途的流式请求必须一起取消。否则它会继续跑完并把译文
    // 提交进库，而界面这边已经清空状态（任务 id 也换了）——同一批段落就会被
    // 下一次点击再翻一遍（真机数据：同一章 118/218 段出现第二版）。
    if (state.taskId) {
      runtime.cancelNovelTranslationStream?.(state.taskId);
      void runtime.sendRuntimeMessage?.({ type: "CANCEL_TRANSLATION_TASK", taskId: state.taskId })?.catch?.(() => {});
      state.taskId = "";
    }
    state.chapterKey = "";
    state.translations.clear();
    state.renderedKeys.clear();
    runtime.resetNovelEmphasis?.(state);
    state.imageJobs.clear();
    state.imageContexts.clear();
    runtime.clearNovelImagePanel?.(true);
    state.textStatus = "idle";
    state.imageStatus = "idle";
    state.showTranslation = false;
    state.progress = {
      textDone: 0,
      textTotal: 0,
      imageDone: 0,
      imageTotal: 0,
      textPhase: "",
      imagePhase: ""
    };
  }

  function scheduleNovelReconcile(reason = "mutation") {
    const state = getNovelState();
    if (state.reconcileTimer || runtime.state.invalidated) return;
    state.reconcileTimer = window.setTimeout(() => {
      state.reconcileTimer = 0;
      const beforeRoot = state.surface && state.surface.observeTarget;
      const beforeSignature = state.surfaceSignature;
      const surface = reconcileNovelReader();
      const rootChanged = beforeRoot !== (surface && surface.observeTarget);
      const surfaceChanged = !!surface && (rootChanged || beforeSignature !== state.surfaceSignature);
      runtime.onNovelSurfaceChanged?.(surface, reason, surfaceChanged);
    }, 80);
  }
  runtime.scheduleNovelReconcile = scheduleNovelReconcile;

  // 浏览器缩放等操作会让阅读器在同一宿主上重建 Shadow DOM:旧 root 的
  // MutationObserver 静默失效,文档级观察器又看不到 shadow root 内部变化,
  // 没有任何事件触发 reconcile,译文会一直停留在内存里而不回到页面。
  // RIDI 侧同理:内容容器整体被换掉时旧观察器失效,而 document 级观察器只看得到
  // 「新节点被插入」,容器被原地清空再填的情况要靠这里兜底。
  // 定时自愈扫描只处理观察器覆盖不到的情况,正常页面下是廉价空检查。
  function reconcileNovelIfStale() {
    if (runtime.state.invalidated || !runtime.IS_NOVEL_READER) return;
    const state = getNovelState();
    const surface = state.surface;
    // 必须走 runtime 属性调用：手机版与测试都覆盖了 runtime.reconcileNovelReader，
    // 直接调内部函数会让覆盖静默失效（装配期写好的实现被绕过）。
    if (surface && surface.observeTarget && surface.observeTarget.isConnected === false) {
      runtime.reconcileNovelReader();
      return;
    }
    if (!surface && state.chapterKey) {
      runtime.reconcileNovelReader();
    }
  }
  runtime.reconcileNovelIfStale = reconcileNovelIfStale;

  function disconnectNovelReader() {
    const state = getNovelState();
    state.rootObserver?.disconnect();
    state.rootObserver = null;
    if (state.reconcileTimer) window.clearTimeout(state.reconcileTimer);
    state.reconcileTimer = 0;
  }
  runtime.disconnectNovelReader = disconnectNovelReader;
}
