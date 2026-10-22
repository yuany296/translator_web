import { sanitizeRenderRotationDeg, verticalRenderRotationDeg } from "../../rendering/cover-geometry.js";

export function installRendererCrossPage(runtime) {
  /**
   * 全体目标的**最深共同祖先**。
   *
   * 旧实现只比较前两个目标（命中即返回），而调用方传进来的顺序是
   * `overlaysById` 的插入顺序 —— 一对"碰巧同属某个小盒子"的目标会决定整个目标集的宿主。
   * Lezhin 阅读页实测：前两个是推荐位缩略图 → 宿主落进 `carousel`（overflow:hidden）内部，
   * 之后每一条覆盖层与 loading 卡都被裁掉，表现为「译文突然全部消失、也不再出现 loading 框」。
   * 逐级求交：只有**所有**目标都还在的祖先才配当宿主（顺序无关）。
   */
  function findCommonAncestor(targets) {
    const values = Array.from(new Set(targets.filter(Boolean)));
    if (values.length === 0) return null;
    if (values.length === 1) return values[0].parentElement || null;
    let chain = new Set();
    for (let node = values[0].parentElement; node; node = node.parentElement) chain.add(node);
    for (let index = 1; index < values.length && chain.size > 0; index += 1) {
      const next = new Set();
      for (let node = values[index].parentElement; node; node = node.parentElement) {
        if (chain.has(node)) next.add(node);
      }
      chain = next;
    }
    for (let node = values[0].parentElement; node; node = node.parentElement) {
      if (chain.has(node)) return node;
    }
    return null;
  }

  function hostDoesNotClip(host) {
    if (!host || typeof getComputedStyle !== "function") return true;
    const style = getComputedStyle(host);
    const overflow = [style.overflow, style.overflowX, style.overflowY]
      .filter(Boolean).map(value => String(value).toLowerCase());
    const clipPath = String(style.clipPath || style.webkitClipPath || "none").toLowerCase();
    const contain = String(style.contain || "").toLowerCase();
    return overflow.every(value => value === "visible" || value === "unset") &&
      (clipPath === "none" || clipPath === "") &&
      !/(^|\s)(paint|strict|content)(\s|$)/u.test(contain);
  }

  function findCrossPageOverlayHost(targets) {
    let host = findCommonAncestor(targets);
    while (host && !hostDoesNotClip(host) && host.parentElement) host = host.parentElement;
    return host;
  }
  runtime.findCrossPageOverlayHost = findCrossPageOverlayHost;

  function getRootRect(rootState) {
    const rootRect = rootState.root.getBoundingClientRect();
    if (rootRect && rootRect.width > 0 && rootRect.height > 0) return rootRect;
    return rootState.host.getBoundingClientRect();
  }

  function ensureCrossPageRoot(host) {
    const known = runtime.state.crossPageRootByHost.get(host);
    if (known && known.root.isConnected) return known;
    const computedPosition = typeof getComputedStyle === "function" ? getComputedStyle(host).position : "";
    const adjustedPosition = !computedPosition || computedPosition === "static";
    const previousInlinePosition = host.style.position;
    if (adjustedPosition) host.style.position = "relative";
    const root = document.createElement("div");
    root.className = "mt-cross-page-root";
    root.dataset.mangaTranslatorOverlay = "true";
    host.appendChild(root);
    const rootState = {
      host,
      root,
      entries: new Set(),
      targetRefs: new Map(),
      adjustedPosition,
      previousInlinePosition,
      resizeObserver: null
    };
    if (typeof ResizeObserver === "function") {
      rootState.resizeObserver = new ResizeObserver(() => runtime.scheduleCrossPageGeometryRefresh());
      rootState.resizeObserver.observe(host);
    }
    runtime.state.crossPageRootByHost.set(host, rootState);
    runtime.state.crossPageRoots.add(rootState);
    return rootState;
  }

  function retainRootTarget(rootState, target) {
    const count = rootState.targetRefs.get(target) || 0;
    rootState.targetRefs.set(target, count + 1);
    if (count === 0 && rootState.resizeObserver) rootState.resizeObserver.observe(target);
  }

  function releaseRootTarget(rootState, target) {
    const next = (rootState.targetRefs.get(target) || 0) - 1;
    if (next > 0) {
      rootState.targetRefs.set(target, next);
      return;
    }
    rootState.targetRefs.delete(target);
    if (rootState.resizeObserver) rootState.resizeObserver.unobserve(target);
  }

  function disposeCrossPageRoot(rootState) {
    if (rootState.entries.size > 0) return;
    if (rootState.resizeObserver) rootState.resizeObserver.disconnect();
    rootState.root.remove();
    if (rootState.adjustedPosition && rootState.host.style.position === "relative") {
      rootState.host.style.position = rootState.previousInlinePosition;
    }
    runtime.state.crossPageRootByHost.delete(rootState.host);
    runtime.state.crossPageRoots.delete(rootState);
  }

  function attachEntryToRoot(entry, rootState) {
    entry.rootState = rootState;
    rootState.entries.add(entry);
    entry.targets.forEach(target => retainRootTarget(rootState, target));
    entry.bubbles.forEach(item => rootState.root.appendChild(item.overlay));
  }

  function detachEntryFromRoot(entry) {
    const rootState = entry.rootState;
    if (!rootState) return;
    entry.bubbles.forEach(item => item.overlay.remove());
    entry.targets.forEach(target => releaseRootTarget(rootState, target));
    rootState.entries.delete(entry);
    entry.rootState = null;
    disposeCrossPageRoot(rootState);
  }

  function createCrossPageBubble(surface, bubble, index) {
    const rendererBubble = runtime.projectionToRendererBubble(bubble);
    const canonicalId = String(rendererBubble.canonical_id || bubble.canonicalId || bubble.canonical_id || "");
    const overlay = document.createElement("div");
    overlay.className = "mt-cross-page-overlay";
    overlay.dataset.mangaTranslatorOverlay = "true";
    overlay.dataset.seamRenderKey = surface.renderKey;
    overlay.dataset.canonicalId = canonicalId;
    overlay.classList.toggle("mt-show-source",
      runtime.state.seamSourceModeByRenderKey.get(surface.renderKey) === true);
    const coverLayer = document.createElement("div");
    coverLayer.className = "mt-cover-layer";
    coverLayer.dataset.mangaTranslatorOverlay = "true";
    const textNode = runtime.createBubbleNode({
      ...rendererBubble,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      polygon: null,
      fill_box: null,
      stitch_overflow: false,
      projection_role: "text_primary"
    }, index, { textOnly: true, seamRenderKey: surface.renderKey });
    if (!textNode) return null;
    textNode.classList.add("mt-cross-page-text");
    overlay.appendChild(coverLayer);
    overlay.appendChild(textNode);
    if (runtime.hasRenderableOcrDebug({ debug: surface.debug })) {
      overlay.classList.add("mt-cross-page-debug");
    }
    return {
      bubble: rendererBubble,
      canonicalId,
      overlay,
      coverLayer,
      coverNodes: new Map(),
      textNode,
      layout: null
    };
  }

  function createCrossPageSurfaceEntry(surface, targets) {
    const bubbles = surface.bubbles.map((bubble, index) => createCrossPageBubble(surface, bubble, index)).filter(Boolean);
    const entry = { surface, targets, bubbles, rootState: null };
    const host = runtime.findCrossPageOverlayHost(targets);
    if (!host) return null;
    attachEntryToRoot(entry, ensureCrossPageRoot(host));
    return entry;
  }

  function applyCrossPageTextGeometry(entry, item, geometry) {
    const frame = geometry.textFrame;
    const node = item.textNode;
    // 跨页文字的 polygon / textFrame 也是沿文字轴量的：竖排时宽是字列长度、
    // 高是字列厚度。writing-mode 接管朝向后必须换回屏幕轴，否则 3 个字的竖排
    // 会被塞进 193×83 的横框里（现场「带走」仍然是横的）。
    const verticalWriting = node.classList.contains("mt-jp-vertical");
    // 跨页整列是两页 box 的并集，旋转来自单页 OCR，套到整列会放大成横向扫动；
    // 多页竖排统一扶正，单页竖排保留残余倾角。
    const multiPageVertical = verticalWriting && (entry.surface?.pageIds?.length || 0) > 1;
    // frame 可能已经是屏幕轴（高 > 宽，不能再换一次），也可能还是文字轴
    // （宽 > 高，竖排时必须换回来）。以长边方向为准，避免二次换轴。
    const swapAxes = verticalWriting && frame.width > frame.height;
    const width = swapAxes ? frame.height : frame.width;
    const height = swapAxes ? frame.width : frame.height;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    runtime.applyBubbleAnchorStyle(node, {
      alignment: node.dataset.alignment,
      x: frame.centerX - width / 2,
      y: frame.centerY - height / 2,
      w: width,
      h: height,
      centerX: frame.centerX,
      centerY: frame.centerY,
      // 竖排方向由 writing-mode 承担。单页保留完整残余倾角；两页合并时单页倾角
      // 会把 1177px 长列扫宽一大截，取一半既保留倾斜感又不会把框撑爆。
      rotation: verticalWriting ? (multiPageVertical ? verticalRenderRotationDeg(Number(node.dataset.rotationDeg || 0)) * 0.5 : verticalRenderRotationDeg(Number(node.dataset.rotationDeg || 0))) : sanitizeRenderRotationDeg(
        Number(node.dataset.rotationDeg || 0),
        width,
        height
      ),
      unit: "px",
      allowVerticalOverflow: true
    });
    const cacheKey = `cross-page:${entry.surface.layoutKey}:${item.canonicalId}:${verticalWriting ? "v" : "h"}`;
    let layout = item.layout || runtime.state.seamLayoutCache.get(cacheKey);
    if (!layout || layout.kind !== "cross-page") {
      // 优先用 OCR 的绝对行高(font_height × 输入图→屏幕比例)还原原文字高:
      // font_height_percent 的分母是 seam 拼接图全高或单页捕获图高,按来源不同
      // 需要不同的还原分母;绝对行高直接换算可避免来源判断,对两种来源都精确。
      const originalTextHeight = runtime.resolveCrossPageOriginalTextHeight(item.bubble, frame)
        || runtime.getBubbleOriginalTextHeight(node, verticalWriting ? width : height,
          Number(frame.sourceImageHeight) || frame.height);
      const fontSize = runtime.fitBubbleFontSize(node, width, height, {}, originalTextHeight);
      layout = {
        kind: "cross-page",
        fontRatio: fontSize / Math.max(1, width),
        strokeRatio: runtime.getDynamicStrokeWidth(fontSize) / Math.max(1, width)
      };
      runtime.state.seamLayoutCache.set(cacheKey, layout);
      if (runtime.state.seamLayoutCache.size > runtime.MAX_FONT_FIT_CACHE) {
        runtime.state.seamLayoutCache.delete(runtime.state.seamLayoutCache.keys().next().value);
      }
    }
    item.layout = layout;
    const fontSize = layout.fontRatio * width;
    node.style.fontSize = `${fontSize.toFixed(1)}px`;
    node.style.setProperty("--mt-stroke-width", `${(layout.strokeRatio * width).toFixed(1)}px`);
  }

  function syncCrossPageSurfaceEntry(entry) {
    if (!entry || entry.targets.some(target => !target || target.isConnected === false)) return false;
    const nextHost = runtime.findCrossPageOverlayHost(entry.targets);
    if (!nextHost) return false;
    if (nextHost !== entry.rootState.host) {
      detachEntryFromRoot(entry);
      attachEntryToRoot(entry, ensureCrossPageRoot(nextHost));
    }
    const rootRect = getRootRect(entry.rootState);
    const targetRects = new Map(entry.surface.pageIds.map((pageId, index) => [pageId, entry.targets[index].getBoundingClientRect()]));
    entry.bubbles.forEach(item => {
      // 单个气泡的几何/遮罩失败只降级这一个气泡：跨页渲染是整章共享的 root，
      // 抛出去会让同一页其余气泡也一起消失（历史上 mapCompositePointToRoot 未挂载就是这样）。
      try {
        const geometry = runtime.buildCrossPageBubbleGeometry(entry.surface, item.bubble, targetRects, rootRect);
        item.overlay.style.display = geometry ? "block" : "none";
        if (!geometry) return;
        item.overlay.style.left = `${Math.max(0, geometry.outer.left)}px`;
        item.overlay.style.top = `${Math.max(0, geometry.outer.top)}px`;
        item.overlay.style.width = `${geometry.outer.width}px`;
        item.overlay.style.height = `${geometry.outer.height}px`;
        runtime.updateCoverSegments(entry, item, geometry, { targetRects, rootRect });
        applyCrossPageTextGeometry(entry, item, geometry);
      } catch (error) {
        const reason = runtime.getErrorMessage?.(error) || String(error && error.message || error);
        console.warn("[MangaTranslator] cross-page bubble render failed:", reason);
        runtime.tracePipeline?.("crosspage-render-error", entry.targets[0], {
          renderKey: String(entry.surface && entry.surface.renderKey || ""),
          canonicalId: String(item && item.canonicalId || ""),
          error: reason
        });
      }
    });
    return true;
  }
  runtime.syncCrossPageSurfaceEntry = syncCrossPageSurfaceEntry;

  function removeCrossPageSurfaceEntry(entry) {
    if (!entry) return;
    detachEntryFromRoot(entry);
    runtime.state.crossPageOverlaysByRenderKey.delete(entry.surface.renderKey);
  }
  // crosspage-lifecycle.js 的清理路径按 runtime.removeCrossPageSurfaceEntry 调用。
  runtime.removeCrossPageSurfaceEntry = removeCrossPageSurfaceEntry;

  function canReuseCrossPageSurfaceEntry(entry, surface, targets) {
    if (!entry || String(entry.surface?.pairKey || "") !== String(surface?.pairKey || "") ||
        entry.targets.some((target, index) => target !== targets[index]) ||
        entry.bubbles.length !== surface.bubbles.length) return false;
    return entry.bubbles.every((item, index) => {
      const bubble = surface.bubbles[index] || {};
      const canonicalId = String(bubble.canonicalId || bubble.canonical_id || "");
      const translatedText = String(bubble.translatedText || bubble.translated_text || "");
      return item.canonicalId === canonicalId &&
        String(item.bubble.translated_text || "") === translatedText;
    });
  }

  /**
   * 文本节点里的原文/译文/行数是否与当前 bubble 一致（派生口径与 createBubbleNode 相同，
   * 因此只在真实文本变化时返回 false）。
   */
  function crossPageTextNodeMatches(node, bubble) {
    if (!node || !bubble) return true;
    const original = runtime.cleanRenderableText(bubble.original_text || "");
    const translated = runtime.cleanRenderableText(bubble.translated_text || "") || original;
    return String(node.dataset.original || "") === original &&
      String(node.dataset.translated || "") === translated &&
      String(node.dataset.sourceLineCount || "") === String(Math.max(1, Math.round(Number(bubble.source_line_count) || 1)));
  }
  runtime.crossPageTextNodeMatches = crossPageTextNodeMatches;

  /**
   * surface 被复用时只换 item.bubble，DOM 里的原文/译文会停留在上一版：用户看到的是
   * 「译文只对应半句」「data-original 还是接缝合并前的旧片段」。文本身份一变就重建文本节点，
   * 几何与字号仍由随后的 syncCrossPageSurfaceEntry 统一刷新。
   */
  function refreshCrossPageTextNode(entry, item, index, surface) {
    const previous = item.textNode;
    const next = runtime.createBubbleNode({
      ...item.bubble,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      polygon: null,
      fill_box: null,
      stitch_overflow: false,
      projection_role: "text_primary"
    }, index, { textOnly: true, seamRenderKey: surface.renderKey });
    if (!next) return false;
    next.classList.add("mt-cross-page-text");
    item.overlay.appendChild(next);
    if (previous && typeof previous.remove === "function") previous.remove();
    item.textNode = next;
    item.layout = null;
    return true;
  }
  runtime.refreshCrossPageTextNode = refreshCrossPageTextNode;

  function updateCrossPageSurfaceEntry(entry, surface) {
    const previous = entry.surface;
    const previousKey = String(previous.renderKey || "");
    const nextKey = String(surface.renderKey || "");
    const layoutChanged = previous.layoutKey !== surface.layoutKey;
    const showSource = runtime.state.seamSourceModeByRenderKey.get(nextKey) === true ||
      runtime.state.seamSourceModeByRenderKey.get(previousKey) === true;
    entry.surface = surface;
    entry.bubbles.forEach((item, index) => {
      item.bubble = runtime.projectionToRendererBubble(surface.bubbles[index]);
      if (layoutChanged) item.layout = null;
      item.overlay.dataset.seamRenderKey = nextKey;
      item.textNode.dataset.seamRenderKey = nextKey;
      item.overlay.classList.toggle("mt-show-source", showSource);
      item.overlay.classList.toggle("mt-cross-page-debug",
        runtime.hasRenderableOcrDebug({ debug: surface.debug }));
      if (!crossPageTextNodeMatches(item.textNode, item.bubble)) {
        refreshCrossPageTextNode(entry, item, index, surface);
        item.textNode.dataset.seamRenderKey = nextKey;
      }
    });
    if (previousKey !== nextKey) {
      runtime.state.crossPageOverlaysByRenderKey.delete(previousKey);
      runtime.state.crossPageOverlaysByRenderKey.set(nextKey, entry);
      runtime.state.seamSourceModeByRenderKey.delete(previousKey);
      if (showSource) runtime.state.seamSourceModeByRenderKey.set(nextKey, true);
    }
  }

  function renderCrossPageSurfaces(surfaces) {
    const activeKeys = new Set();
    for (const surface of Array.isArray(surfaces) ? surfaces : []) {
      const targets = surface.pageIds.map(pageId => runtime.getTargetForKakaoPageId(pageId));
      if (targets.some(target => !target || target.isConnected === false)) continue;
      activeKeys.add(surface.renderKey);
      let entry = runtime.state.crossPageOverlaysByRenderKey.get(surface.renderKey);
      if (!entry) {
        entry = [...runtime.state.crossPageOverlaysByRenderKey.values()].find(candidate =>
          canReuseCrossPageSurfaceEntry(candidate, surface, targets));
      }
      const reusable = canReuseCrossPageSurfaceEntry(entry, surface, targets);
      if (!reusable) {
        if (entry) removeCrossPageSurfaceEntry(entry);
        entry = createCrossPageSurfaceEntry(surface, targets);
        if (!entry) continue;
        runtime.state.crossPageOverlaysByRenderKey.set(surface.renderKey, entry);
      } else updateCrossPageSurfaceEntry(entry, surface);
      syncCrossPageSurfaceEntry(entry);
    }
    for (const [renderKey, entry] of runtime.state.crossPageOverlaysByRenderKey) {
      if (!activeKeys.has(renderKey)) removeCrossPageSurfaceEntry(entry);
    }
    return [...runtime.state.crossPageOverlaysByRenderKey.values()]
      .reduce((count, entry) => count + entry.bubbles.length, 0);
  }
  runtime.renderCrossPageSurfaces = renderCrossPageSurfaces;
}
