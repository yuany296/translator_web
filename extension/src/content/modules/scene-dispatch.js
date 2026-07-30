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
    const novelImage = runtime.isNovelImageTarget?.(target) === true;
    return (runtime.isEmbeddedRenderMode() || novelImage) && !runtime.isBackgroundImageTarget(target);
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
        bubbles: Array.isArray(result && result.bubbles) ? result.bubbles : []
      }));
    } catch {
      return runtime.hashSourceIdentity(`${Date.now()}`);
    }
  }
  runtime.buildOverlayRenderSignature = buildOverlayRenderSignature;
  function buildOverlayDebugRenderSignature(result) {
    try {
      const debugPayloads = [result && result.debug].filter(debug => debug && typeof debug === "object");
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
}
