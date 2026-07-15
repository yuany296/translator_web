export function installContent13(runtime) {
  async function renderKakaoPipelineResult({
    target,
    targetKey,
    scopedTargetKey,
    result,
    payload,
    response,
    options,
    context
  }) {
    const expectedSourceImageId = String(payload && payload.sourceImageId || "");
    if (!target.isConnected || expectedSourceImageId && runtime.getSourceImageIdForTarget(target) !== expectedSourceImageId) {
      runtime.clearRenderedTarget(target);
      return;
    }
    runtime.releaseUncoveredKakaoShortPages(context && context.stitchPayload || payload, result, target, "ownerSucceededWithoutShortPageBubble");
    runtime.rememberLocalResult(scopedTargetKey, result);
    if (result.bubbles.length > 0) {
      runtime.updateLoadingOverlayText(target, targetKey, runtime.shouldUseEmbeddedRender(target) ? "生成嵌入图片中..." : "排版中...");
      await runtime.renderTranslationResult(target, targetKey, result, payload, {
        stream: true
      });
      target.dataset.mtNoTextKey = "";
    } else {
      runtime.updateLoadingOverlayText(target, targetKey, "未识别到文本");
      await runtime.sleep(1500);
      runtime.clearRenderedTarget(target);
      target.dataset.mtNoTextKey = targetKey;
    }
    target.dataset.mtLastTranslatedKey = targetKey;
    await runtime.reportStatus("info", "translation done", {
      reason: options && options.reason,
      bubbles: result.bubbles.length,
      cached: !!(response && response.cached)
    });
  }
  runtime.renderKakaoPipelineResult = renderKakaoPipelineResult;
  function releaseKakaoPipelineErrorAttachments(payload, owner, ownerScopedKey) {
    const attachedKeys = payload && Array.isArray(payload.attachedShortPageKeys) ? payload.attachedShortPageKeys : [];
    for (const shortKey of attachedKeys) {
      const target = runtime.findTargetByScopedKey(shortKey);
      if (!target) {
        continue;
      }
      runtime.KP.releaseShortPagesForOwner(runtime.state.kakaoStore, [target], ownerScopedKey);
      runtime.tracePipeline("short-detached", target, {
        reason: "ownerFailedReleasingShortPage",
        ownerScopedKey
      });
    }
  }
  runtime.releaseKakaoPipelineErrorAttachments = releaseKakaoPipelineErrorAttachments;
  async function reportKakaoPipelineError(error, target, options) {
    const reason = runtime.getErrorMessage(error);
    if (runtime.CONTEXT_INVALIDATED_RE.test(reason)) {
      return;
    }
    const restored = runtime.clearKakaoLoadingOverlay(target);
    runtime.tracePipeline("pipeline-error-restore", target, {
      restored,
      reason
    });
    await runtime.reportStatus("error", reason, {
      reason: options && options.reason,
      targetTag: target && target.tagName ? target.tagName.toLowerCase() : "unknown"
    });
  }
  runtime.reportKakaoPipelineError = reportKakaoPipelineError;
  function projectionToRendererBubble(projection) {
    const source = projection && projection.bubble && typeof projection.bubble === "object" ? projection.bubble : projection || {};
    const rawGeometry = projection && (projection.geometry || projection.pageLocalBox || projection.box) || source.geometry || source.pageLocalBox || source.box || source;
    const geometry = Array.isArray(rawGeometry) ? rawGeometry[0] || {} : rawGeometry;
    const visual = projection && projection.visual || source.visual || {};
    const rawRole = String(projection && projection.role || source.projection_role || "text_primary");
    const role = rawRole === "primary" ? "text_primary" : rawRole === "standby" && projection && projection.coverOnly === true ? "cover_only" : rawRole === "standby" ? "text_standby" : rawRole === "cover" ? "cover_only" : rawRole;
    const originalText = String(projection && (projection.originalText || projection.original_text) || source.originalText || source.original_text || "");
    const translatedText = String(projection && (projection.translatedText || projection.translated_text) || source.translatedText || source.translated_text || "");
    return {
      ...source,
      x: Number(geometry && (geometry.x ?? geometry.left) || 0),
      y: Number(geometry && (geometry.y ?? geometry.top) || 0),
      w: Number(geometry && (geometry.w ?? geometry.width) || 0),
      h: Number(geometry && (geometry.h ?? geometry.height) || 0),
      fill_box: source.fill_box || visual.fill_box || visual.fillBox || null,
      bg_type: source.bg_type || visual.bg_type || visual.bgType || "none",
      bg_color: source.bg_color || visual.bg_color || visual.bgColor || "",
      bg_confidence: Number(source.bg_confidence || visual.bg_confidence || visual.bgConfidence || 0),
      region_id: String(source.region_id || visual.region_id || visual.regionId || ""),
      region_type: String(source.region_type || visual.region_type || visual.regionType || "plain_text"),
      region_polygon: source.region_polygon || visual.region_polygon || visual.regionPolygon || null,
      polygon: source.polygon || visual.polygon || null,
      text_color: source.text_color || visual.text_color || visual.textColor || "",
      stroke_color: source.stroke_color || visual.stroke_color || visual.strokeColor || "",
      alignment: runtime.normalizeBubbleAlignment(source.alignment || visual.alignment),
      rotation_deg: Number(source.rotation_deg || visual.rotation_deg || visual.rotationDeg || 0),
      font_height: Number(source.font_height || visual.font_height || visual.fontHeight || 0),
      font_height_percent: Number(source.font_height_percent || visual.font_height_percent || visual.fontHeightPercent || 0),
      font_weight: runtime.normalizeBubbleFontWeight(source.font_weight || source.fontWeight || visual.font_weight || visual.fontWeight, 0),
      translation_role: String(source.translation_role || source.translationRole || visual.translation_role || visual.translationRole || ""),
      source_line_count: Math.max(1, Number(source.source_line_count || visual.source_line_count || visual.sourceLineCount || 1)),
      block_id: String(projection && (projection.projectionId || projection.id) || source.block_id || source.id || ""),
      canonical_id: String(projection && (projection.canonicalId || projection.groupId) || source.canonical_id || ""),
      canonical_revision: Math.max(1, Number(projection && (projection.canonicalRevision || projection.groupRevision || projection.revision) || source.canonical_revision || 1)),
      projection_role: role,
      original_text: originalText,
      translated_text: role === "cover_only" ? "" : translatedText
    };
  }
  runtime.projectionToRendererBubble = projectionToRendererBubble;
  function normalizeProjectionPages(input) {
    const normalized = new Map();
    const add = (pageId, projections) => {
      if (!pageId) return;
      normalized.set(String(pageId), Array.isArray(projections) ? projections : []);
    };
    if (input && input.projectionsByPage instanceof Map) {
      for (const [pageId, projections] of input.projectionsByPage.entries()) add(pageId, projections);
    } else if (input && input.projectionsByPage && typeof input.projectionsByPage === "object") {
      for (const [pageId, projections] of Object.entries(input.projectionsByPage)) add(pageId, projections);
    } else {
      add(input && input.pageId, input && input.projections);
    }
    return normalized;
  }
  runtime.normalizeProjectionPages = normalizeProjectionPages;
  function getPageMappedValue(values, pageId, fallback = null) {
    const key = String(pageId || "");
    if (values instanceof Map) {
      return values.has(key) ? values.get(key) : fallback;
    }
    if (values && typeof values === "object" && Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key];
    }
    return fallback;
  }
  runtime.getPageMappedValue = getPageMappedValue;
  function normalizeSeamRect(value) {
    const rect = value && typeof value === "object" ? value : {};
    return {
      x: Number(rect.x || 0),
      y: Number(rect.y || 0),
      w: Number(rect.w || rect.width || 0),
      h: Number(rect.h || rect.height || 0)
    };
  }
  runtime.normalizeSeamRect = normalizeSeamRect;
  function normalizeSeamRenderSurfaces(input = {}) {
    const values = Array.isArray(input && input.seamSurfaces) ? input.seamSurfaces : [];
    return values.map(surface => {
      const pageIds = Array.isArray(surface && surface.pageIds) ? surface.pageIds.map(String).filter(Boolean) : [];
      const segments = Array.isArray(surface && surface.segments) ? surface.segments.map(segment => ({
        pageId: String(segment && segment.pageId || ""),
        drawRect: runtime.normalizeSeamRect(segment && segment.drawRect),
        sourceCrop: runtime.normalizeSeamRect(segment && segment.sourceCrop),
        naturalWidth: Number(segment && segment.naturalWidth || 0),
        naturalHeight: Number(segment && segment.naturalHeight || 0)
      })) : [];
      return {
        renderKey: String(surface && surface.renderKey || ""),
        layoutKey: String(surface && surface.layoutKey || surface && surface.renderKey || ""),
        pairKey: String(surface && surface.pairKey || ""),
        coordinateSpace: String(surface && surface.coordinateSpace || ""),
        canvasWidth: Number(surface && surface.canvasWidth || 0),
        canvasHeight: Number(surface && surface.canvasHeight || 0),
        pageIds,
        imageRevisionByPage: surface && surface.imageRevisionByPage && typeof surface.imageRevisionByPage === "object" ? {
          ...surface.imageRevisionByPage
        } : {},
        canonicalRevisionById: surface && surface.canonicalRevisionById && typeof surface.canonicalRevisionById === "object" ? {
          ...surface.canonicalRevisionById
        } : {},
        translationFingerprintByCanonicalId: surface && surface.translationFingerprintByCanonicalId && typeof surface.translationFingerprintByCanonicalId === "object" ? {
          ...surface.translationFingerprintByCanonicalId
        } : {},
        artifactFingerprint: String(surface && surface.artifactFingerprint || ""),
        segments,
        cleanedImage: String(surface && surface.cleanedImage || ""),
        cleanedImageToken: String(surface && surface.cleanedImageToken || ""),
        bubbles: Array.isArray(surface && surface.bubbles) ? surface.bubbles : [],
        debug: surface && surface.debug && typeof surface.debug === "object" ? surface.debug : null,
        diagnostics: Array.isArray(surface && surface.diagnostics) ? surface.diagnostics.map(item => ({
          ...item
        })) : [],
        handledCanonicalIds: Array.isArray(surface && surface.handledCanonicalIds) ? surface.handledCanonicalIds.map(String).filter(Boolean) : [],
        suppressedCanonicalIds: Array.isArray(surface && surface.suppressedCanonicalIds) ? surface.suppressedCanonicalIds.map(String).filter(Boolean) : []
      };
    });
  }
  runtime.normalizeSeamRenderSurfaces = normalizeSeamRenderSurfaces;
  function getSeamSegmentTransform(segment, pageCssWidth, pageCssHeight) {
    const drawRect = runtime.normalizeSeamRect(segment && segment.drawRect);
    const sourceCrop = runtime.normalizeSeamRect(segment && segment.sourceCrop);
    const naturalWidth = Number(segment && segment.naturalWidth || 0);
    const naturalHeight = Number(segment && segment.naturalHeight || 0);
    const pageWidth = Number(pageCssWidth || 0);
    const pageHeight = Number(pageCssHeight || 0);
    if (!(drawRect.w > 0 && drawRect.h > 0) || !(sourceCrop.w > 0 && sourceCrop.h > 0) || !(naturalWidth > 0 && naturalHeight > 0) || !(pageWidth > 0 && pageHeight > 0)) {
      return null;
    }
    const scaleX = sourceCrop.w / drawRect.w * (pageWidth / naturalWidth);
    const scaleY = sourceCrop.h / drawRect.h * (pageHeight / naturalHeight);
    return {
      scaleX,
      scaleY,
      left: sourceCrop.x * pageWidth / naturalWidth - drawRect.x * scaleX,
      top: sourceCrop.y * pageHeight / naturalHeight - drawRect.y * scaleY
    };
  }
  runtime.getSeamSegmentTransform = getSeamSegmentTransform;
  function getSeamSurfaceHostPageId(surface, resolveTarget = runtime.getTargetForKakaoPageId) {
    const pageIds = Array.isArray(surface && surface.pageIds) ? surface.pageIds.map(String).filter(Boolean) : [];
    return pageIds.find(pageId => {
      const target = typeof resolveTarget === "function" ? resolveTarget(pageId) : null;
      return !!target && target.isConnected !== false;
    }) || pageIds[0] || "";
  }
  runtime.getSeamSurfaceHostPageId = getSeamSurfaceHostPageId;
  function buildSeamSurfaceRenderSignature(surface) {
    try {
      return runtime.hashSourceIdentity(JSON.stringify({
        renderKey: String(surface && surface.renderKey || ""),
        layoutKey: String(surface && surface.layoutKey || ""),
        pairKey: String(surface && surface.pairKey || ""),
        coordinateSpace: String(surface && surface.coordinateSpace || ""),
        canvasWidth: Number(surface && surface.canvasWidth || 0),
        canvasHeight: Number(surface && surface.canvasHeight || 0),
        pageIds: Array.isArray(surface && surface.pageIds) ? surface.pageIds : [],
        imageRevisionByPage: surface && surface.imageRevisionByPage || {},
        canonicalRevisionById: surface && surface.canonicalRevisionById || {},
        translationFingerprintByCanonicalId: surface && surface.translationFingerprintByCanonicalId || {},
        artifactFingerprint: String(surface && surface.artifactFingerprint || ""),
        segments: Array.isArray(surface && surface.segments) ? surface.segments : [],
        cleanedImageHash: runtime.hashSourceIdentity(String(surface && surface.cleanedImage || "")),
        bubbles: Array.isArray(surface && surface.bubbles) ? surface.bubbles : [],
        diagnostics: Array.isArray(surface && surface.diagnostics) ? surface.diagnostics : [],
        handledCanonicalIds: Array.isArray(surface && surface.handledCanonicalIds) ? surface.handledCanonicalIds : [],
        suppressedCanonicalIds: Array.isArray(surface && surface.suppressedCanonicalIds) ? surface.suppressedCanonicalIds : []
      }));
    } catch {
      return "";
    }
  }
  runtime.buildSeamSurfaceRenderSignature = buildSeamSurfaceRenderSignature;
  function isSeamSurfaceRenderable(surface, resolveTarget = runtime.getTargetForKakaoPageId, resolveRevision = target => runtime.state.kakaoImageRevisionByTarget.get(target)) {
    const requiresCleanedImage = (Array.isArray(surface && surface.bubbles) ? surface.bubbles : []).some(bubble => String(bubble && (bubble.bg_type || bubble.visual && (bubble.visual.bgType || bubble.visual.bg_type)) || "none").trim().toLowerCase() !== "solid");
    if (!surface || !surface.renderKey || !surface.layoutKey || !(surface.canvasWidth > 0 && surface.canvasHeight > 0) || requiresCleanedImage && !runtime.isDataUrl(surface.cleanedImage) || !Array.isArray(surface.pageIds) || surface.pageIds.length < 2 || new Set(surface.pageIds).size !== surface.pageIds.length) {
      return false;
    }
    return surface.pageIds.every(pageId => {
      const segment = surface.segments.find(item => item.pageId === pageId);
      if (!segment || !runtime.getSeamSegmentTransform(segment, 1, 1)) return false;
      const target = typeof resolveTarget === "function" ? resolveTarget(pageId) : null;
      if (!target || target.isConnected === false) return false;
      const expectedRevision = String(surface.imageRevisionByPage && surface.imageRevisionByPage[pageId] || "");
      const currentRevision = String(typeof resolveRevision === "function" ? resolveRevision(target, pageId) || "" : "");
      return !!expectedRevision && currentRevision === expectedRevision;
    });
  }
  runtime.isSeamSurfaceRenderable = isSeamSurfaceRenderable;
  function classifyCanonicalProjectionRender(bubbles, input = {}) {
    const seamBubbleCount = (Array.isArray(input && input.seamSurfaces) ? input.seamSurfaces : []).reduce((count, surface) => count + (Array.isArray(surface && surface.bubbles) ? surface.bubbles.length : 0), 0);
    if (Array.isArray(bubbles) && bubbles.length > 0 || seamBubbleCount > 0) return "translated";
    return input && input.authoritativeEmpty === true ? "no-text" : "pending";
  }
  runtime.classifyCanonicalProjectionRender = classifyCanonicalProjectionRender;
  function isCanonicalRenderComplete(projections, input = {}) {
    return input.translationComplete !== false && !(Array.isArray(projections) ? projections : []).some(projection => projection && (projection.provisional === true || projection.pendingCanonicalId));
  }
  runtime.isCanonicalRenderComplete = isCanonicalRenderComplete;
  function hasRenderableOcrDebug(result) {
    const debugPayloads = [result && result.debug, ...(Array.isArray(result && result.seamSurfaces) ? result.seamSurfaces.map(surface => surface && surface.debug) : [])].filter(debug => debug && typeof debug === "object");
    return debugPayloads.some(debug => runtime.getRenderableOcrDebugStages(debug).some(stage => Array.isArray(stage.items) && stage.items.length > 0));
  }
  runtime.hasRenderableOcrDebug = hasRenderableOcrDebug;
  function normalizeOcrDebugOverlayMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "raw" || text === "filtered" || text === "merged" || text === "final" ? text : "final";
  }
  runtime.normalizeOcrDebugOverlayMode = normalizeOcrDebugOverlayMode;
  function getDebugFilterReasonItems(debug) {
    return (Array.isArray(debug && debug.filterReasons) ? debug.filterReasons : []).map(entry => entry && entry.item).filter(Boolean);
  }
  runtime.getDebugFilterReasonItems = getDebugFilterReasonItems;
  function getRenderableOcrDebugStages(debug) {
    if (!debug || typeof debug !== "object") {
      return [];
    }
    const mode = runtime.normalizeOcrDebugOverlayMode(debug.debugOverlayMode || debug.overlayMode || debug.mode);
    if (mode === "raw") {
      return [{
        name: "raw",
        items: debug.rawItems,
        className: "mt-debug-raw"
      }];
    }
    if (mode === "filtered") {
      return [{
        name: "filtered",
        items: debug.filteredItems || runtime.getDebugFilterReasonItems(debug),
        className: "mt-debug-duplicate"
      }, {
        name: "duplicate",
        items: debug.duplicateItems,
        className: "mt-debug-duplicate"
      }];
    }
    if (mode === "merged") {
      return [{
        name: "deduped",
        items: debug.dedupedItems,
        className: "mt-debug-deduped"
      }, {
        name: "merged",
        items: debug.mergedItems || debug.lineItems,
        className: "mt-debug-deduped"
      }];
    }
    return [{
      name: "raw",
      items: debug.rawItems,
      className: "mt-debug-raw"
    }, {
      name: "block",
      items: debug.finalBubbles || debug.items,
      className: "mt-debug-block"
    }];
  }
  runtime.getRenderableOcrDebugStages = getRenderableOcrDebugStages;
}
