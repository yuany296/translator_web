export function installNovelReader(runtime) {
  function getNovelState() {
    if (!runtime.state.novel) {
      runtime.state.novel = {
        surface: null,
        rootObserver: null,
        reconcileTimer: 0,
        translations: new Map(),
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

  function findKakaoNovelSurface() {
    if (!runtime.IS_KAKAOPAGE_READER || !document.querySelectorAll) return null;
    const viewer = document.querySelector("[data-testid='viewer-container']");
    if (!viewer) return null;
    const candidates = [viewer, ...viewer.querySelectorAll("*")];
    for (const host of candidates) {
      const root = host && host.shadowRoot;
      if (!root || typeof root.querySelectorAll !== "function") continue;
      const paragraphs = [...root.querySelectorAll("[data-p-id]")].filter(isNovelParagraphNode);
      if (paragraphs.length < 2) continue;
      return {
        viewer,
        host,
        root,
        content: findCommonAncestor(paragraphs, root),
        paragraphs
      };
    }
    return null;
  }
  runtime.findKakaoNovelSurface = findKakaoNovelSurface;

  function isNovelParagraphNode(node) {
    return !!node && /^(?:H[1-6]|P|DIV)$/u.test(String(node.tagName || "")) &&
      node.hasAttribute("data-p-id");
  }

  function findCommonAncestor(nodes, fallback) {
    let current = nodes[0] && nodes[0].parentElement;
    while (current && current !== fallback) {
      if (nodes.every(node => current.contains(node))) return current;
      current = current.parentElement;
    }
    return fallback;
  }

  function getOriginalParagraphText(node) {
    const source = node.querySelector?.(":scope > .mt-novel-source");
    return String(source ? source.textContent : node.textContent || "").replace(/\r\n?/gu, "\n");
  }
  runtime.getOriginalNovelParagraphText = getOriginalParagraphText;

  /**
   * 当前屏的内容签名(段落的 data-p-id + 源文哈希)。
   *
   * KakaoPage 是分屏阅读:翻页时复用同一个 shadow 宿主,只有宿主里的内容换掉,
   * 所以 `root` 是否变化判断不出翻屏。签名只用原文,渲染插入的译文包裹不会
   * 改变它,因此不会自激触发重译。
   */
  function novelSurfaceSignature(surface) {
    const root = surface && surface.root;
    if (!root || typeof root.querySelectorAll !== "function") return "";
    return [...root.querySelectorAll("[data-p-id]")].filter(isNovelParagraphNode).map(node => {
      const text = getOriginalParagraphText(node);
      const normalized = runtime.normalizeTranslationCacheText
        ? runtime.normalizeTranslationCacheText(text) : String(text || "");
      const hash = runtime.computeTranslationCacheHash
        ? runtime.computeTranslationCacheHash(normalized) : normalized;
      return `${node.getAttribute("data-p-id")}\u0001${hash}`;
    }).join("\u0002");
  }
  runtime.novelSurfaceSignature = novelSurfaceSignature;

  function orderParagraphs(nodes) {
    const ordered = nodes.map((node, index) => ({
      node,
      index,
      id: String(node.getAttribute("data-p-id") || "")
    }));
    const sortable = ordered.map(item => item.id.match(/^([^\d]*)(\d+)([^\d]*)$/u));
    const numericIds = sortable.every(Boolean) &&
      sortable.every(match => match[1] === sortable[0][1] && match[3] === sortable[0][3]);
    if (numericIds) {
      ordered.sort((left, right) => left.id.localeCompare(right.id, undefined, {
        numeric: true,
        sensitivity: "base"
      }) || left.index - right.index);
    }
    return ordered;
  }

  function getSeriesTitle(chapterTitle) {
    return String(chapterTitle || "").replace(/\s*\d+(?:\.\d+)?\s*화.*$/u, "").trim();
  }

  function extractKakaoNovelChapter(surface = findKakaoNovelSurface()) {
    if (!surface) return null;
    const locationInfo = runtime.novelCore.parseKakaoNovelLocation(location.href, document.title);
    if (!locationInfo) return null;
    const occurrences = new Map();
    const pidOrdinals = new Map();
    const paragraphs = orderParagraphs(
      [...surface.root.querySelectorAll("[data-p-id]")].filter(isNovelParagraphNode)
    ).map(({ node, id, index }) => {
      const originalText = getOriginalParagraphText(node);
      const normalized = runtime.normalizeTranslationCacheText(originalText);
      const normalizedSourceHash = runtime.computeTranslationCacheHash(normalized);
      const occurrenceIndex = occurrences.get(normalizedSourceHash) || 0;
      occurrences.set(normalizedSourceHash, occurrenceIndex + 1);
      // KakaoPage 的 data-p-id 不是唯一标识:对话块内嵌套节点共享同一个
      // data-p-id。给同 id 的节点追加序号生成唯一 id,避免翻译结果互相
      // 覆盖、进度计数把嵌套副本重复计入;domAnchor 保留原始 id 供恢复。
      // 且 data-p-id 只在单个 EPUB 文档(一屏)内唯一,翻页后从 0 重新编号;
      // 若段落身份只用「pid#同 id 序号」,新一屏的同号段落就会认领上一屏的
      // 译文(表现为末页版权信息被画上作品开头的句子)。把源文哈希并入 id,
      // 使段落身份与持久缓存一样按内容寻址,页面切换后不再串号。
      const pidOrdinal = pidOrdinals.get(id) || 0;
      pidOrdinals.set(id, pidOrdinal + 1);
      const paragraphId = `${pidOrdinal > 0 ? `${id}#${pidOrdinal}` : id}@${String(normalizedSourceHash).slice(0, 12)}`;
      const paragraphKey = runtime.computeTranslationCacheHash(
        `${locationInfo.chapterId}\u0000${normalizedSourceHash}\u0000${occurrenceIndex}`
      );
      return {
        id: paragraphId,
        pid: id,
        pidOrdinal,
        paragraphKey,
        domAnchor: id,
        occurrenceIndex,
        rawSourceHash: runtime.computeTranslationCacheHash(originalText),
        normalizedSourceHash,
        index,
        kind: /^H[1-6]$/u.test(node.tagName) ? "title" : "paragraph",
        original_text: originalText,
        node
      };
    });
    return {
      ...locationInfo,
      seriesTitle: getSeriesTitle(locationInfo.chapterTitle),
      surface,
      paragraphs,
      images: collectKakaoNovelImages(surface, paragraphs)
    };
  }
  runtime.extractKakaoNovelChapter = extractKakaoNovelChapter;

  function collectKakaoNovelImages(surface = findKakaoNovelSurface(), paragraphs = []) {
    if (!surface) return [];
    const content = surface.content || surface.root;
    const images = [...content.querySelectorAll("img")];
    return images.filter(isNovelContentImage).map((target, index) => {
      target.dataset.mtNovelImage = "true";
      const context = findImageTextContext(target, paragraphs);
      const resultKey = runtime.getNovelImageResultKey(target, index);
      const contextId = resultKey;
      target.dataset.mtNovelResultKey = resultKey;
      target.dataset.mtNovelContextId = contextId;
      getNovelState().imageContexts.set(contextId, context);
      return { target, context, contextId, resultKey };
    });
  }
  runtime.collectKakaoNovelImages = collectKakaoNovelImages;

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

  function reconcileKakaoNovelReader() {
    const state = getNovelState();
    const surface = findKakaoNovelSurface();
    if (!surface) {
      state.surface = null;
      runtime.updateFloatingBallState?.();
      return null;
    }
    const rootChanged = state.surface && state.surface.root !== surface.root;
    const locationInfo = runtime.novelCore.parseKakaoNovelLocation(location.href, document.title);
    const nextChapterKey = locationInfo ? `${locationInfo.scopeKey}:${locationInfo.chapterId}` : "";
    if (state.chapterKey && nextChapterKey && state.chapterKey !== nextChapterKey) {
      runtime.restoreAllNovelText?.(surface.root);
      resetNovelNavigationState(state);
    }
    state.surface = surface;
    runtime.injectNovelStyles?.(surface.root);
    // 翻屏(同一个宿主换内容)也算 surface 变化,否则新翻到的屏既不会被补翻,
    // 也不会重算缓存覆盖,后面几屏会一直停在原文。
    state.surfaceSignature = novelSurfaceSignature(surface);
    if (!state.rootObserver || rootChanged) {
      state.rootObserver?.disconnect();
      state.rootObserver = new MutationObserver(() => scheduleNovelReconcile("shadow-mutation"));
      state.rootObserver.observe(surface.root, {
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
  runtime.reconcileKakaoNovelReader = reconcileKakaoNovelReader;

  function resetNovelNavigationState(state) {
    state.chapterKey = "";
    state.translations.clear();
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
      const beforeRoot = state.surface && state.surface.root;
      const beforeSignature = state.surfaceSignature;
      const surface = reconcileKakaoNovelReader();
      const rootChanged = beforeRoot !== (surface && surface.root);
      const surfaceChanged = !!surface && (rootChanged || beforeSignature !== state.surfaceSignature);
      runtime.onNovelSurfaceChanged?.(surface, reason, surfaceChanged);
    }, 80);
  }
  runtime.scheduleNovelReconcile = scheduleNovelReconcile;

  // 浏览器缩放等操作会让阅读器在同一宿主上重建 Shadow DOM:旧 root 的
  // MutationObserver 静默失效,文档级观察器又看不到 shadow root 内部变化,
  // 没有任何事件触发 reconcile,译文会一直停留在内存里而不回到页面。
  // 定时自愈扫描只处理观察器覆盖不到的情况,正常页面下是廉价空检查。
  function reconcileKakaoNovelIfStale() {
    if (runtime.state.invalidated || !runtime.IS_KAKAOPAGE_READER) return;
    const state = getNovelState();
    const surface = state.surface;
    if (surface && surface.root && surface.root.isConnected === false) {
      runtime.reconcileKakaoNovelReader();
      return;
    }
    if (!surface && state.chapterKey) {
      runtime.reconcileKakaoNovelReader();
    }
  }
  runtime.reconcileKakaoNovelIfStale = reconcileKakaoNovelIfStale;

  function disconnectNovelReader() {
    const state = getNovelState();
    state.rootObserver?.disconnect();
    state.rootObserver = null;
    if (state.reconcileTimer) window.clearTimeout(state.reconcileTimer);
    state.reconcileTimer = 0;
  }
  runtime.disconnectNovelReader = disconnectNovelReader;
}
