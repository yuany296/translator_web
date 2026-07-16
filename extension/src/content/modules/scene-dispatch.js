export function installSceneDispatch(runtime) {
  async function renderTranslationResult(target, targetKey, result, payload, options = {}) {
    if (runtime.ENABLE_PIPELINE_TRACE && runtime.IS_KAKAOPAGE_READER) {
      const renderable = runtime.isKakaopageTargetStillRenderable(target);
      if (!renderable.ok) {
        console.debug("[MangaTranslator][KakaoPage] overlay hidden (target outside viewport, auto-shows on scroll-back):", renderable.reason);
      } else {
        const rect = target.getBoundingClientRect();
        console.debug("[MangaTranslator][KakaoPage] render check complete", {
          rect: {
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          },
          bubbles: Array.isArray(result.bubbles) ? result.bubbles.length : 0,
          renderMode: options.renderMode || runtime.state.renderMode || "overlay",
          targetTag: target.tagName.toLowerCase()
        });
      }
    }
    runtime.scheduleTermDiscovery(target, targetKey, result, payload);
    if (options.forceOverlay !== true && options.debugOnly !== true && runtime.shouldUseEmbeddedRender(target) && !runtime.getPayloadDisplayRect(payload)) {
      await runtime.renderEmbeddedTranslation(target, targetKey, result, payload);
      runtime.removeOverlayForTarget(target);
      return;
    }
    runtime.restoreEmbeddedForTarget(target);
    runtime.renderOverlay(target, targetKey, result, {
      ...options,
      imageMeta: runtime.getPayloadImageMeta(payload),
      displayRect: payload && payload.coordinateSpace === "source-image-v1" ? null : runtime.getPayloadDisplayRect(payload)
    });
  }
  runtime.renderTranslationResult = renderTranslationResult;
  function isKakaopageTargetStillRenderable(target) {
    if (!target || !target.isConnected) {
      return {
        ok: false,
        reason: "target disconnected"
      };
    }
    const rect = target.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 40) {
      return {
        ok: false,
        reason: `target too small: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`
      };
    }
    const visibleRect = runtime.getVisibleViewportRect(target);
    if (!visibleRect) {
      return {
        ok: false,
        reason: "no visible viewport rect"
      };
    }
    if (visibleRect.width < 40 || visibleRect.height < 30) {
      return {
        ok: false,
        reason: `visible rect too small: ${visibleRect.width.toFixed(0)}x${visibleRect.height.toFixed(0)}`
      };
    }
    const visibleArea = runtime.getVisibleArea(rect);
    if (visibleArea < 3000) {
      return {
        ok: false,
        reason: `visible area too small: ${visibleArea.toFixed(0)}`
      };
    }
    return {
      ok: true,
      reason: ""
    };
  }
  runtime.isKakaopageTargetStillRenderable = isKakaopageTargetStillRenderable;
  function isEmbeddedRenderMode() {
    return runtime.state.renderMode === runtime.RENDER_MODE_EMBEDDED;
  }
  runtime.isEmbeddedRenderMode = isEmbeddedRenderMode;
  function shouldUseEmbeddedRender(target) {
    return runtime.isEmbeddedRenderMode() && !runtime.isBackgroundImageTarget(target);
  }
  runtime.shouldUseEmbeddedRender = shouldUseEmbeddedRender;
  function getExistingRenderedState(targetId) {
    return runtime.state.embeddedById.get(targetId) || runtime.state.overlaysById.get(targetId) || null;
  }
  runtime.getExistingRenderedState = getExistingRenderedState;
  function isReusableRenderedState(renderedState, settled) {
    if (!renderedState || settled !== true) return false;
    if (renderedState.mode === "embedded") return true;
    return renderedState.mode !== "loading" && renderedState.mode !== "debug" && Number(renderedState.bubbleCount || 0) > 0;
  }
  runtime.isReusableRenderedState = isReusableRenderedState;
  function shouldPreserveOverlayDuringLoading(oldOverlay, targetKey) {
    return Boolean(oldOverlay && oldOverlay.targetKey === targetKey && runtime.isReusableRenderedState(oldOverlay, true));
  }
  runtime.shouldPreserveOverlayDuringLoading = shouldPreserveOverlayDuringLoading;
  function ensureLoadingStatusCard(overlayState, text) {
    if (!overlayState || !overlayState.root) return null;
    let card = overlayState.loadingCard || overlayState.root.querySelector(".mt-loading-card-status");
    if (!card) {
      card = document.createElement("div");
      card.className = "mt-loading-card mt-loading-card-status";
      card.dataset.mangaTranslatorOverlay = "true";
      overlayState.root.appendChild(card);
    }
    card.textContent = String(text || "OCR + 翻译中...");
    overlayState.loadingCard = card;
    return card;
  }
  runtime.ensureLoadingStatusCard = ensureLoadingStatusCard;
  function isReusableKakaoReadyPageBinding(target, handle, terminal, boundPageId, boundRevision) {
    if (!target || target.isConnected === false || !handle || !terminal) return false;
    const pageId = String(handle.pageId || "");
    const revision = String(handle.imageRevision || "");
    const terminalRevision = String(terminal.details && terminal.details.imageRevision || "");
    return !!pageId && !!revision && handle.target === target && handle.pageOcrState === "ready" && terminal.state === "ready" && String(boundPageId || "") === pageId && String(boundRevision || "") === revision && (!terminalRevision || terminalRevision === revision);
  }
  runtime.isReusableKakaoReadyPageBinding = isReusableKakaoReadyPageBinding;
  function hasReusableKakaoPageOcr(target) {
    if (!runtime.shouldUseKakaoCanonicalPipeline(target) || !runtime.kakaoCanonicalPipeline || !runtime.state.kakaoStore || typeof runtime.state.kakaoStore.getPageHandleForTarget !== "function" || typeof runtime.state.kakaoStore.getPageTerminal !== "function") {
      return false;
    }
    const handle = runtime.state.kakaoStore.getPageHandleForTarget(target);
    const terminal = handle && runtime.state.kakaoStore.getPageTerminal(handle.pageId);
    return runtime.isReusableKakaoReadyPageBinding(target, handle, terminal, runtime.state.kakaoPageIdByTarget.get(target), runtime.state.kakaoImageRevisionByTarget.get(target));
  }
  runtime.hasReusableKakaoPageOcr = hasReusableKakaoPageOcr;
  function isEmbeddedRenderStillApplied(renderedState) {
    if (!renderedState || renderedState.mode !== "embedded") {
      return true;
    }
    const target = renderedState.target;
    if (renderedState.kind === "background" && target instanceof HTMLElement) {
      const backgroundImage = String(getComputedStyle(target).backgroundImage || target.style.backgroundImage || "");
      return target.dataset.mtEmbeddedActive === "true" && /url\((["']?)data:/i.test(backgroundImage);
    }
    if (renderedState.kind !== "image" || !(target instanceof HTMLImageElement)) {
      return true;
    }
    const currentSource = String(target.currentSrc || target.getAttribute("src") || "").trim();
    return target.dataset.mtEmbeddedActive === "true" && runtime.isDataUrl(currentSource);
  }
  runtime.isEmbeddedRenderStillApplied = isEmbeddedRenderStillApplied;
  function buildOverlayRenderSignature(result) {
    try {
      return runtime.hashSourceIdentity(JSON.stringify({
        bubbles: Array.isArray(result && result.bubbles) ? result.bubbles : [],
        seamSurfaces: (Array.isArray(result && result.seamSurfaces) ? result.seamSurfaces : []).map(runtime.buildSeamSurfaceRenderSignature)
      }));
    } catch {
      return runtime.hashSourceIdentity(`${Date.now()}`);
    }
  }
  runtime.buildOverlayRenderSignature = buildOverlayRenderSignature;
  function buildOverlayDebugRenderSignature(result) {
    try {
      const debugPayloads = [result && result.debug, ...(Array.isArray(result && result.seamSurfaces) ? result.seamSurfaces.map(surface => surface && surface.debug) : [])].filter(debug => debug && typeof debug === "object");
      return runtime.hashSourceIdentity(JSON.stringify(debugPayloads.map(debug => ({
        mode: runtime.normalizeOcrDebugOverlayMode(debug.debugOverlayMode || debug.overlayMode || debug.mode),
        stages: runtime.getRenderableOcrDebugStages(debug).map(stage => ({
          name: stage.name,
          items: Array.isArray(stage.items) ? stage.items : []
        }))
      }))));
    } catch {
      return runtime.hashSourceIdentity(`${Date.now()}`);
    }
  }
  runtime.buildOverlayDebugRenderSignature = buildOverlayDebugRenderSignature;
  function isSameOverlayRenderPayload(oldOverlay, renderSignature, cleanedImage) {
    return !!oldOverlay && oldOverlay.renderSignature === renderSignature && oldOverlay.cleanedImage === cleanedImage;
  }
  runtime.isSameOverlayRenderPayload = isSameOverlayRenderPayload;
  function getSeamBubbleIntrinsicGeometry(node, canvasWidth, canvasHeight) {
    const polygonGeometry = runtime.getOverlayPolygonGeometry(node, {
      width: canvasWidth,
      height: canvasHeight
    });
    if (polygonGeometry) {
      node.style.width = `${polygonGeometry.width}px`;
      node.style.height = `${polygonGeometry.height}px`;
      runtime.applyBubbleAnchorStyle(node, {
        alignment: node.dataset.alignment,
        x: polygonGeometry.left,
        y: polygonGeometry.top,
        w: polygonGeometry.width,
        h: polygonGeometry.height,
        centerX: polygonGeometry.centerX,
        centerY: polygonGeometry.centerY,
        rotation: Number(node.dataset.rotationDeg || 0),
        unit: "px",
        allowVerticalOverflow: true
      });
      return polygonGeometry;
    }
    return {
      width: canvasWidth * Number(node.dataset.wPercent || 0) / 100,
      height: canvasHeight * Number(node.dataset.hPercent || 0) / 100
    };
  }
  runtime.getSeamBubbleIntrinsicGeometry = getSeamBubbleIntrinsicGeometry;

  function applySeamBubbleLayout(surface, bubbleNodes) {
    const layoutKey = String(surface?.layoutKey || surface?.renderKey || "");
    const cached = runtime.state.seamLayoutCache.get(layoutKey);
    let metrics = Array.isArray(cached) && cached.length === bubbleNodes.length ? cached : null;
    if (!metrics) {
      metrics = bubbleNodes.map(node => {
        const geometry = runtime.getSeamBubbleIntrinsicGeometry(
          node,
          Number(surface.canvasWidth),
          Number(surface.canvasHeight)
        );
        const sourceHeight = runtime.getBubbleOriginalTextHeight(
          node,
          geometry.height,
          Number(surface.canvasHeight)
        );
        const fontSize = runtime.fitBubbleFontSize(
          node,
          geometry.width,
          geometry.height,
          {},
          sourceHeight
        );
        return { fontSize, strokeWidth: runtime.getDynamicStrokeWidth(fontSize) };
      });
      runtime.state.seamLayoutCache.set(layoutKey, metrics);
      if (runtime.state.seamLayoutCache.size > runtime.MAX_FONT_FIT_CACHE) {
        runtime.state.seamLayoutCache.delete(runtime.state.seamLayoutCache.keys().next().value);
      }
    } else {
      bubbleNodes.forEach(node => runtime.getSeamBubbleIntrinsicGeometry(
        node,
        Number(surface.canvasWidth),
        Number(surface.canvasHeight)
      ));
    }
    bubbleNodes.forEach((node, index) => {
      const metric = metrics[index];
      if (!metric) return;
      node.style.fontSize = `${Number(metric.fontSize).toFixed(1)}px`;
      node.style.setProperty("--mt-stroke-width", `${Number(metric.strokeWidth).toFixed(1)}px`);
    });
  }
  runtime.applySeamBubbleLayout = applySeamBubbleLayout;

  function createSeamWindowNode(surface, pageId) {
    const segment = surface.segments.find(item => item.pageId === pageId);
    if (!segment) return null;
    const windowNode = document.createElement("div");
    windowNode.className = "mt-seam-window";
    windowNode.dataset.mangaTranslatorOverlay = "true";
    windowNode.dataset.seamRenderKey = surface.renderKey;
    windowNode.dataset.seamLayoutKey = surface.layoutKey;
    windowNode.dataset.seamPairKey = surface.pairKey;
    windowNode.dataset.seamPageId = pageId;
    const composite = document.createElement("div");
    composite.className = "mt-seam-composite";
    composite.dataset.mangaTranslatorOverlay = "true";
    composite.dataset.seamRenderKey = surface.renderKey;
    composite.dataset.seamLayoutKey = surface.layoutKey;
    composite.dataset.seamPairKey = surface.pairKey;
    composite.dataset.seamArtifactFingerprint = surface.artifactFingerprint || surface.cleanedImageToken || "";
    composite.dataset.seamDiagnostics = JSON.stringify(Array.isArray(surface.diagnostics) ? surface.diagnostics : []);
    composite.style.width = `${surface.canvasWidth}px`;
    composite.style.height = `${surface.canvasHeight}px`;
    if (runtime.isDataUrl(surface.cleanedImage)) {
      composite.style.backgroundImage = `url("${surface.cleanedImage}")`;
    }
    composite.classList.toggle("mt-show-source", runtime.state.seamSourceModeByRenderKey.get(surface.renderKey) === true);
    const renderPairs = surface.bubbles
      .map(runtime.projectionToRendererBubble)
      .filter(bubble => bubble.w > 0 && bubble.h > 0)
      .map((bubble, index) => runtime.createBubbleRenderNodes(bubble, index, {
        seamRenderKey: surface.renderKey
      }))
      .filter(pair => pair.coverNode || pair.textNode);
    const bubbleNodes = renderPairs.map(pair => pair.textNode).filter(Boolean);
    const coverNodes = renderPairs.map(pair => pair.coverNode).filter(Boolean);
    renderPairs.forEach(pair => {
      [pair.coverNode, pair.textNode].filter(Boolean).forEach(node => {
        node.classList.add("mt-seam-bubble");
        composite.appendChild(node);
      });
    });
    runtime.applySeamBubbleLayout(surface, bubbleNodes);
    const debugNodeCount = runtime.appendOcrDebugNodes(composite, {
      debug: surface.debug
    });
    windowNode.appendChild(composite);
    return {
      surface,
      pageId,
      segment,
      windowNode,
      composite,
      bubbleNodes,
      coverNodes,
      logicalBubbleCount: renderPairs.length,
      debugNodeCount
    };
  }
  runtime.createSeamWindowNode = createSeamWindowNode;
  function syncSeamOverlayTransforms(overlayState, rect) {
    (Array.isArray(overlayState && overlayState.seamEntries) ? overlayState.seamEntries : []).forEach(entry => {
      const transform = runtime.getSeamSegmentTransform(entry.segment, rect.width, rect.height);
      if (!transform) {
        entry.windowNode.style.display = "none";
        return;
      }
      entry.windowNode.style.display = "block";
      entry.composite.style.left = `${transform.left}px`;
      entry.composite.style.top = `${transform.top}px`;
      entry.composite.style.transform = `scale(${transform.scaleX}, ${transform.scaleY})`;
    });
  }
  runtime.syncSeamOverlayTransforms = syncSeamOverlayTransforms;
  function setSeamSourceModeForOverlays(overlays, renderKey, showSource) {
    const key = String(renderKey || "");
    if (!key || !overlays || typeof overlays.forEach !== "function") return;
    overlays.forEach(overlayState => {
      (Array.isArray(overlayState && overlayState.seamEntries) ? overlayState.seamEntries : []).filter(entry => entry.surface.renderKey === key).forEach(entry => entry.composite.classList.toggle("mt-show-source", showSource));
    });
  }
  runtime.setSeamSourceModeForOverlays = setSeamSourceModeForOverlays;
  function toggleSeamSourceMode(renderKey) {
    const key = String(renderKey || "");
    if (!key) return;
    const showSource = runtime.state.seamSourceModeByRenderKey.get(key) !== true;
    runtime.state.seamSourceModeByRenderKey.set(key, showSource);
    runtime.setSeamSourceModeForOverlays(runtime.state.overlaysById, key, showSource);
  }
  runtime.toggleSeamSourceMode = toggleSeamSourceMode;
  function getSeamSurfaceRenderKeys(seamSurfaces) {
    return new Set((Array.isArray(seamSurfaces) ? seamSurfaces : []).map(surface => String(surface && surface.renderKey || "")).filter(Boolean));
  }
  runtime.getSeamSurfaceRenderKeys = getSeamSurfaceRenderKeys;
  function buildSeamSurfaceSliceKey(renderKey, pageId) {
    const key = String(renderKey || "").trim();
    const page = String(pageId || "").trim();
    return key && page ? `${key}@${page}` : "";
  }
  runtime.buildSeamSurfaceSliceKey = buildSeamSurfaceSliceKey;
  function getSeamSurfaceSliceKeys(seamSurfaces, pageId) {
    return new Set((Array.isArray(seamSurfaces) ? seamSurfaces : []).map(surface => runtime.buildSeamSurfaceSliceKey(surface && surface.renderKey, pageId)).filter(Boolean));
  }
  runtime.getSeamSurfaceSliceKeys = getSeamSurfaceSliceKeys;
  function rootHasAnySeamRenderKey(root, renderKeys) {
    if (!root || !renderKeys || renderKeys.size === 0) return false;
    const keys = String(root.dataset && root.dataset.seamRenderKeys || "").split(/\s+/).filter(Boolean);
    return keys.some(key => renderKeys.has(key));
  }
  runtime.rootHasAnySeamRenderKey = rootHasAnySeamRenderKey;
  function rootHasAnySeamSliceKey(root, sliceKeys) {
    if (!root || !sliceKeys || sliceKeys.size === 0) return false;
    const keys = String(root.dataset && root.dataset.seamSliceKeys || "").split(/\s+/).filter(Boolean);
    return keys.some(key => sliceKeys.has(key));
  }
  runtime.rootHasAnySeamSliceKey = rootHasAnySeamSliceKey;
}
