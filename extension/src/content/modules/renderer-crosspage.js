export function installRendererCrossPage(runtime) {
  function findCommonAncestor(targets) {
    const values = targets.filter(Boolean);
    if (values.length < 2) return values[0] && values[0].parentElement || null;
    const ancestors = new Set();
    for (let node = values[0].parentElement; node; node = node.parentElement) ancestors.add(node);
    for (let node = values[1].parentElement; node; node = node.parentElement) {
      if (ancestors.has(node)) return node;
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

  function createCoverSegmentNode(item, pageId) {
    const node = document.createElement("div");
    node.className = "mt-cover-segment";
    node.dataset.mangaTranslatorOverlay = "true";
    node.dataset.pageId = pageId;
    item.coverLayer.appendChild(node);
    item.coverNodes.set(pageId, node);
    return node;
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

  function updateCoverSegments(entry, item, geometry) {
    const activePageIds = new Set(geometry.coverSegments.map(segment => segment.pageId));
    for (const [pageId, node] of item.coverNodes) {
      if (!activePageIds.has(pageId)) {
        node.remove();
        item.coverNodes.delete(pageId);
      }
    }
    const bgType = runtime.normalizeBgType(item.bubble.bg_type);
    // 同一页可能有多段遮罩（如 seam 行 + 捕获带外的相邻行），coverNodes
    // 按 pageId 缓存节点，逐段覆盖会让后一段顶掉前一段导致覆盖残缺；
    // 这里按页合并成一块 union 矩形，每页只设置一次。
    const byPage = new Map();
    geometry.coverSegments.forEach(segment => {
      const list = byPage.get(segment.pageId) || [];
      list.push(segment);
      byPage.set(segment.pageId, list);
    });
    byPage.forEach((segments, pageId) => {
      const node = item.coverNodes.get(pageId) || createCoverSegmentNode(item, pageId);
      const left = Math.min(...segments.map(segment => segment.left));
      const top = Math.min(...segments.map(segment => segment.top));
      const right = Math.max(...segments.map(segment => segment.left + segment.width));
      const bottom = Math.max(...segments.map(segment => segment.top + segment.height));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${right - left}px`;
      node.style.height = `${bottom - top}px`;
      if (bgType === "solid") {
        node.style.background = String(item.bubble.bg_color || "rgba(255,255,255,0.96)");
        node.style.removeProperty("background-image");
        return;
      }
      // 组内全部在捕获带内时用复合清理图(带内专用、优先于可能过期的整页图);
      // 只要有一段在带外(如相邻行),union 超出带区,必须用整页清理图才能全覆盖。
      const bandSegments = segments.filter(segment => segment.compositeIntersection);
      if (bandSegments.length === segments.length && entry.surface.cleanedImage && bandSegments.length > 0) {
        const scaleX = bandSegments[0].scaleX;
        const scaleY = bandSegments[0].scaleY;
        const unionComposite = {
          left: Math.min(...bandSegments.map(segment => segment.compositeIntersection.left)),
          top: Math.min(...bandSegments.map(segment => segment.compositeIntersection.top)),
          right: Math.max(...bandSegments.map(segment =>
            segment.compositeIntersection.left + segment.compositeIntersection.width)),
          bottom: Math.max(...bandSegments.map(segment =>
            segment.compositeIntersection.top + segment.compositeIntersection.height))
        };
        node.style.removeProperty("background");
        node.style.backgroundImage = `url("${entry.surface.cleanedImage}")`;
        node.style.backgroundSize =
          `${entry.surface.canvasWidth * scaleX}px ${entry.surface.canvasHeight * scaleY}px`;
        node.style.backgroundPosition =
          `${-unionComposite.left * scaleX}px ${-unionComposite.top * scaleY}px`;
        return;
      }
      const pageImage = entry.surface.cleanedImageByPage?.[pageId];
      if (pageImage) {
        const pageSegment = segments.find(segment => segment.mapping === "page") || segments[0];
        node.style.removeProperty("background");
        node.style.backgroundImage = `url("${pageImage}")`;
        node.style.backgroundSize = `${pageSegment.pageWidth}px ${pageSegment.pageHeight}px`;
        node.style.backgroundPosition =
          `${-Math.min(...segments.map(segment => segment.sourceLeft ?? 0))}px ` +
          `${-Math.min(...segments.map(segment => segment.sourceTop ?? 0))}px`;
        return;
      }
      // 复杂背景没有可映射的清理图时保持透明，避免用白色矩形破坏原图。
      node.style.background = "transparent";
      node.style.removeProperty("background-image");
    });
  }

  function applyCrossPageTextGeometry(entry, item, geometry) {
    const frame = geometry.textFrame;
    const node = item.textNode;
    node.style.width = `${frame.width}px`;
    node.style.height = `${frame.height}px`;
    runtime.applyBubbleAnchorStyle(node, {
      alignment: node.dataset.alignment,
      x: frame.centerX - frame.width / 2,
      y: frame.centerY - frame.height / 2,
      w: frame.width,
      h: frame.height,
      centerX: frame.centerX,
      centerY: frame.centerY,
      rotation: Number(node.dataset.rotationDeg || 0),
      unit: "px",
      allowVerticalOverflow: true
    });
    const cacheKey = `cross-page:${entry.surface.layoutKey}:${item.canonicalId}`;
    let layout = item.layout || runtime.state.seamLayoutCache.get(cacheKey);
    if (!layout || layout.kind !== "cross-page") {
      // 优先用 OCR 的绝对行高(font_height × 输入图→屏幕比例)还原原文字高:
      // font_height_percent 的分母是 seam 拼接图全高或单页捕获图高,按来源不同
      // 需要不同的还原分母;绝对行高直接换算可避免来源判断,对两种来源都精确。
      const originalTextHeight = runtime.resolveCrossPageOriginalTextHeight(item.bubble, frame)
        || runtime.getBubbleOriginalTextHeight(node, frame.height,
          Number(frame.sourceImageHeight) || frame.height);
      const fontSize = runtime.fitBubbleFontSize(node, frame.width, frame.height, {}, originalTextHeight);
      layout = {
        kind: "cross-page",
        fontRatio: fontSize / Math.max(1, frame.width),
        strokeRatio: runtime.getDynamicStrokeWidth(fontSize) / Math.max(1, frame.width)
      };
      runtime.state.seamLayoutCache.set(cacheKey, layout);
      if (runtime.state.seamLayoutCache.size > runtime.MAX_FONT_FIT_CACHE) {
        runtime.state.seamLayoutCache.delete(runtime.state.seamLayoutCache.keys().next().value);
      }
    }
    item.layout = layout;
    const fontSize = layout.fontRatio * frame.width;
    node.style.fontSize = `${fontSize.toFixed(1)}px`;
    node.style.setProperty("--mt-stroke-width", `${(layout.strokeRatio * frame.width).toFixed(1)}px`);
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
      const geometry = runtime.buildCrossPageBubbleGeometry(entry.surface, item.bubble, targetRects, rootRect);
      item.overlay.style.display = geometry ? "block" : "none";
      if (!geometry) return;
      item.overlay.style.left = `${Math.max(0, geometry.outer.left)}px`;
      item.overlay.style.top = `${Math.max(0, geometry.outer.top)}px`;
      item.overlay.style.width = `${geometry.outer.width}px`;
      item.overlay.style.height = `${geometry.outer.height}px`;
      updateCoverSegments(entry, item, geometry);
      applyCrossPageTextGeometry(entry, item, geometry);
    });
    return true;
  }
  runtime.syncCrossPageSurfaceEntry = syncCrossPageSurfaceEntry;

  function removeCrossPageSurfaceEntry(entry) {
    if (!entry) return;
    detachEntryFromRoot(entry);
    runtime.state.crossPageOverlaysByRenderKey.delete(entry.surface.renderKey);
  }

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
