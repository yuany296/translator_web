export function installNovelReader(runtime) {
  function getNovelState() {
    if (!runtime.state.novel) {
      runtime.state.novel = {
        surface: null,
        rootObserver: null,
        reconcileTimer: 0,
        translations: new Map(),
        memoryDeltas: [],
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
        showTranslation: true,
        chapterKey: "",
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
    const paragraphs = orderParagraphs(
      [...surface.root.querySelectorAll("[data-p-id]")].filter(isNovelParagraphNode)
    ).map(({ node, id, index }) => ({
      id,
      index,
      kind: /^H[1-6]$/u.test(node.tagName) ? "title" : "paragraph",
      original_text: getOriginalParagraphText(node),
      node
    }));
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
    state.memoryDeltas = [];
    state.imageJobs.clear();
    state.imageContexts.clear();
    runtime.clearNovelImagePanel?.(true);
    state.textStatus = "idle";
    state.imageStatus = "idle";
    state.showTranslation = true;
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
      const before = state.surface && state.surface.root;
      const surface = reconcileKakaoNovelReader();
      runtime.onNovelSurfaceChanged?.(surface, reason, before !== (surface && surface.root));
    }, 80);
  }
  runtime.scheduleNovelReconcile = scheduleNovelReconcile;

  function disconnectNovelReader() {
    const state = getNovelState();
    state.rootObserver?.disconnect();
    state.rootObserver = null;
    if (state.reconcileTimer) window.clearTimeout(state.reconcileTimer);
    state.reconcileTimer = 0;
  }
  runtime.disconnectNovelReader = disconnectNovelReader;
}
