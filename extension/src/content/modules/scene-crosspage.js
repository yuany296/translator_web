export function installSceneCrosspage(runtime) {
  function renderSeamCrossPage(input = {}) {
    const {
      pageA,
      pageB,
      canvasWidth,
      canvasHeight,
      segments,
      observations
    } = input;
    if (!pageA || !pageB || !canvasWidth || !canvasHeight || !segments) return;
    const targetA = pageA.target;
    const targetB = pageB.target;
    if (!targetA || !targetA.isConnected || !targetB || !targetB.isConnected) return;
    const renderKey = `seam-cross-${input.pairKey || `${pageA.pageId}|${pageB.pageId}`}`;
    if (!runtime.state.seamCrossPages) runtime.state.seamCrossPages = new Map();

    // 移除旧的同 key overlay（如果有）
    const oldEntry = runtime.state.seamCrossPages.get(renderKey);
    if (oldEntry && oldEntry.root && oldEntry.root.isConnected) {
      oldEntry.root.remove();
    }
    runtime.ensureOverlayLayer();
    const rectA = targetA.getBoundingClientRect();
    // CSS px per source pixel, based on merged image
    const cssPerSrcPx = rectA.width / Math.max(1, segments[0]?.naturalWidth || canvasWidth);
    const segA = segments.find(s => s.pageId === pageA.pageId);
    const segB = segments.find(s => s.pageId === pageB.pageId);
    if (!segA || !segB) return;

    // overlay 顶边 = 页 A 的裁剪区顶边在文档流中的位置
    const seamCropTop = segA.sourceCrop.y * cssPerSrcPx;
    const cssTop = rectA.top + seamCropTop;
    const cssWidth = rectA.width;
    const cssHeight = canvasHeight * cssPerSrcPx;
    const root = document.createElement("div");
    root.className = "mt-overlay-root mt-seam-cross-page";
    root.dataset.mangaTranslatorOverlay = "true";
    root.dataset.seamCrossRenderKey = renderKey;
    const bubbleNodes = [];
    const bubbles = (Array.isArray(observations) ? observations : []).filter(obs => String(obs.originalText || obs.original_text || "").trim());
    for (let idx = 0; idx < bubbles.length; idx++) {
      const obs = bubbles[idx];
      const rawBox = obs.visual?.box || obs.box || obs.bbox;
      if (!rawBox) continue;
      const bx = Number(rawBox.x ?? rawBox.left) || 0;
      const by = Number(rawBox.y ?? rawBox.top) || 0;
      const bw = Math.max(1, Number(rawBox.w ?? rawBox.width) || 0);
      const bh = Math.max(1, Number(rawBox.h ?? rawBox.height) || 0);
      const isPercent = bx <= 100 && by <= 100 && bw <= 100 && bh <= 100 && canvasWidth > 100;
      const xPct = isPercent ? bx : bx * cssPerSrcPx / cssWidth * 100;
      const yPct = isPercent ? by : by * cssPerSrcPx / cssHeight * 100;
      const wPct = isPercent ? bw : bw * cssPerSrcPx / cssWidth * 100;
      const hPct = isPercent ? bh : bh * cssPerSrcPx / cssHeight * 100;
      const originalText = String(obs.originalText || obs.original_text || "");
      const translatedText = String(obs.translatedText || obs.translated_text || originalText);
      const visual = obs.visual || {};
      const bubble = {
        x: xPct,
        y: yPct,
        w: wPct,
        h: hPct,
        original_text: originalText,
        translated_text: translatedText,
        source_line_count: Math.max(1, Math.round(originalText.length / 8)),
        bg_type: visual.bgType || visual.bg_type || "none",
        bg_color: visual.bgColor || visual.bg_color || "",
        bgConfidence: visual.bgConfidence ?? visual.bg_confidence ?? 0,
        region_type: visual.regionType || visual.region_type || "plain_text",
        region_polygon: visual.regionPolygon || visual.region_polygon || null,
        fill_box: visual.fillBox || visual.fill_box || null,
        cleaned_source_box: visual.cleanedSourceBox || visual.cleaned_source_box || null,
        alignment: runtime.normalizeBubbleAlignment(visual.alignment),
        rotation_deg: Number(visual.rotationDeg ?? visual.rotation_deg) || 0,
        font_weight: runtime.normalizeBubbleFontWeight(visual.fontWeight ?? visual.font_weight, 0),
        translation_role: String(visual.translationRole || visual.translation_role || ""),
        canonical_id: "",
        block_id: "seam-cross-" + idx,
        projection_role: "text_primary"
      };
      const node = runtime.createBubbleNode(bubble, idx, {
        backgroundTarget: false
      });
      if (!node) continue;

      // createBubbleNode 可能把韩文误判为日文竖排，根据 OCR rotation_deg 纠正
      const rotDeg = Math.abs(Number(visual.rotationDeg ?? visual.rotation_deg) || 0);
      const isVertical = rotDeg > 45 && rotDeg < 135;
      node.classList.toggle("mt-jp-vertical", isVertical);

      // 重新设置文字，确保竖排纠正后文字正确
      node.textContent = isVertical ? translatedText : translatedText;
      node.title = originalText;
      if (!isVertical) {
        node.style.removeProperty("writing-mode");
        node.style.removeProperty("text-orientation");
      }

      // 字号拟合（跨页 overlay 不走 syncOverlayPosition）
      const bubbleWidthPx = cssWidth * wPct / 100;
      const bubbleHeightPx = cssHeight * hPct / 100;
      const fittedSize = runtime.fitBubbleFontSize(node, bubbleWidthPx, bubbleHeightPx, {}, runtime.getBubbleOriginalTextHeight(node, bubbleHeightPx, cssHeight));
      node.style.fontSize = `${fittedSize}px`;
      node.style.setProperty("--mt-stroke-width", `${runtime.getDynamicStrokeWidth(fittedSize)}px`);
      bubbleNodes.push(node);
      root.appendChild(node);
    }
    if (bubbleNodes.length === 0) return;
    root.style.position = "absolute";
    root.style.left = `${rectA.left + (window.scrollX || 0)}px`;
    root.style.top = `${cssTop + (window.scrollY || 0)}px`;
    root.style.width = `${cssWidth}px`;
    root.style.height = `${cssHeight}px`;
    root.style.overflow = "visible";
    runtime.state.overlayLayer.appendChild(root);
    runtime.state.seamCrossPages.set(renderKey, {
      root,
      targetA,
      targetB,
      scale: cssPerSrcPx,
      rectA,
      seamCropTop,
      cssHeight
    });

    // 去重：隐藏 per-page 覆盖层中靠近接缝的气泡，避免和跨页 overlay 重复显示
    for (const ov of runtime.state.overlaysById.values()) {
      if (!ov || !Array.isArray(ov.bubbleNodes)) continue;
      if (ov.target === targetA) {
        // 页 A 底部（靠近接缝）的气泡
        for (const bNode of ov.bubbleNodes) {
          const yPct = Number(bNode.dataset.yPercent || "50");
          const hPct = Number(bNode.dataset.hPercent || "0");
          if (yPct + hPct * 0.5 > 85) bNode.style.display = "none";
        }
      } else if (ov.target === targetB) {
        // 页 B 顶部（靠近接缝）的气泡
        for (const bNode of ov.bubbleNodes) {
          const yPct = Number(bNode.dataset.yPercent || "50");
          const hPct = Number(bNode.dataset.hPercent || "0");
          if (yPct - hPct * 0.5 < 15) bNode.style.display = "none";
        }
      }
    }
  }
  runtime.renderSeamCrossPage = renderSeamCrossPage;
  async function renderCanonicalProjections(input = {}) {
    const pages = runtime.normalizeProjectionPages(input);
    const seamSurfaces = runtime.normalizeSeamRenderSurfaces(input).filter(surface => runtime.isSeamSurfaceRenderable(surface));
    const seamSurfacesByPage = new Map();
    const handledCanonicalIds = new Set();
    const atomicSeamPageIds = new Set();
    seamSurfaces.forEach(surface => {
      surface.handledCanonicalIds.forEach(canonicalId => handledCanonicalIds.add(canonicalId));
      surface.suppressedCanonicalIds.forEach(canonicalId => handledCanonicalIds.add(canonicalId));
      surface.pageIds.forEach(pageId => {
        if (!pages.has(pageId)) pages.set(pageId, []);
        const pageSurfaces = seamSurfacesByPage.get(pageId) || [];
        pageSurfaces.push(surface);
        seamSurfacesByPage.set(pageId, pageSurfaces);
        atomicSeamPageIds.add(pageId);
      });
    });

    // pipeline 保留一份未被 surface 接管前的逐页投影。若 DOM revision 在提交瞬间变化、
    // renderer 因而拒绝 surface，只恢复对应 canonical 的逐页结果，不让页面变空。
    const fallbackPages = runtime.normalizeProjectionPages({
      projectionsByPage: input && input.fallbackProjectionsByPage
    });
    for (const [pageId, fallbackProjections] of fallbackPages.entries()) {
      if (!pages.has(pageId)) pages.set(pageId, []);
      const current = pages.get(pageId);
      const existingKeys = new Set(current.map(projection => String(projection && (projection.projectionId || projection.id) || `${projection && projection.canonicalId || ""}|${projection && projection.role || ""}`)));
      for (const projection of fallbackProjections) {
        const canonicalId = String(projection && (projection.canonicalId || projection.groupId) || "");
        if (canonicalId && handledCanonicalIds.has(canonicalId)) continue;
        const projectionKey = String(projection && (projection.projectionId || projection.id) || `${canonicalId}|${projection && projection.role || ""}`);
        if (existingKeys.has(projectionKey)) continue;
        existingKeys.add(projectionKey);
        current.push(projection);
      }
    }
    const allTextCandidates = new Map();
    for (const [pageId, projections] of pages.entries()) {
      for (const projection of projections) {
        const rawRole = String(projection && projection.role || "text_primary");
        const role = rawRole === "primary" ? "text_primary" : rawRole === "standby" ? "text_standby" : rawRole;
        if (role !== "text_primary" && role !== "text_standby") continue;
        const canonicalId = String(projection && (projection.canonicalId || projection.groupId || projection.id) || "");
        if (!canonicalId || handledCanonicalIds.has(canonicalId)) continue;
        const target = runtime.getTargetForKakaoPageId(pageId);
        if (!target) continue;
        const candidates = allTextCandidates.get(canonicalId) || [];
        candidates.push({
          pageId,
          projection,
          target,
          role
        });
        allTextCandidates.set(canonicalId, candidates);
      }
    }
    const activeProjectionIds = new Set();
    for (const candidates of allTextCandidates.values()) {
      candidates.sort((left, right) => {
        const leftPrimary = left.role === "text_primary" ? 0 : 1;
        const rightPrimary = right.role === "text_primary" ? 0 : 1;
        return leftPrimary - rightPrimary || String(left.pageId).localeCompare(String(right.pageId));
      });
      const selected = candidates.find(candidate => candidate.projection.activeText === true) || candidates.find(candidate => candidate.projection.active !== false) || candidates[0];
      activeProjectionIds.add(String(selected.projection.projectionId || selected.projection.id || ""));
    }
    let renderedCount = 0;
    const atomicRenderTasks = [];
    for (const [pageId, projections] of pages.entries()) {
      const target = runtime.getTargetForKakaoPageId(pageId) || (pageId === String(input.pageId || "") ? input.target : null);
      if (!target || !target.isConnected) continue;
      const pageSurfaces = seamSurfacesByPage.get(pageId) || [];
      const ordinaryProjections = [...projections].filter(projection => {
        const canonicalId = String(projection && (projection.canonicalId || projection.groupId) || "");
        return !canonicalId || !handledCanonicalIds.has(canonicalId);
      });
      const bubbles = ordinaryProjections.sort((left, right) => {
        const leftCover = left && (left.role === "cover" || left.role === "cover_only" || left.coverOnly === true) ? 0 : 1;
        const rightCover = right && (right.role === "cover" || right.role === "cover_only" || right.coverOnly === true) ? 0 : 1;
        return leftCover - rightCover;
      }).filter(projection => {
        const rawRole = String(projection && projection.role || "text_primary");
        const role = rawRole === "primary" ? "text_primary" : rawRole === "standby" && projection && projection.coverOnly === true ? "cover_only" : rawRole === "standby" ? "text_standby" : rawRole === "cover" ? "cover_only" : rawRole;
        if (role === "cover_only") return projection.active !== false;
        if (typeof projection.activeText === "boolean") return projection.activeText;
        const projectionId = String(projection && (projection.projectionId || projection.id) || "");
        return activeProjectionIds.has(projectionId);
      }).map(runtime.projectionToRendererBubble).filter(bubble => bubble.w > 0 && bubble.h > 0).filter(bubble => bubble.projection_role === "cover_only" || bubble.translated_text);
      const targetKey = runtime.computeTargetKey(target);
      const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
      const defaultCleanedImage = input.result && input.result.cleanedImage || null;
      const defaultDebug = input.debug || input.result && input.result.debug || null;
      const result = {
        bubbles,
        cleanedImage: runtime.getPageMappedValue(input.cleanedImageByPage, pageId, defaultCleanedImage),
        debug: runtime.getPageMappedValue(input.debugByPage, pageId, defaultDebug),
        seamSurfaces: pageSurfaces,
        seamPageId: pageId
      };
      const pageRenderOptions = {
        ...input,
        seamSurfaces: pageSurfaces,
        translationComplete: runtime.getPageMappedValue(input.translationCompleteByPage, pageId, input.translationComplete),
        authoritativeEmpty: runtime.getPageMappedValue(input.authoritativeEmptyByPage, pageId, input.authoritativeEmpty)
      };
      const disposition = runtime.classifyCanonicalProjectionRender(bubbles, pageRenderOptions);
      const invokeRender = options => {
        const task = runtime.renderTranslationResult(target, targetKey, result, runtime.getPageMappedValue(input.payloadByPage, pageId, input.payload || null), options);
        if (atomicSeamPageIds.has(pageId)) {
          atomicRenderTasks.push(task);
          return null;
        }
        return task;
      };
      if (disposition === "pending") {
        if (runtime.hasRenderableOcrDebug(result)) {
          const task = invokeRender({
            stream: false,
            debugOnly: true
          });
          if (task) await task;
        }
        if (input.debugOnly !== true) {
          target.dataset.mtLastTranslatedKey = "";
          target.dataset.mtNoTextKey = "";
        }
        continue;
      }
      runtime.rememberLocalResult(scopedTargetKey, result);
      if (disposition === "translated") {
        const task = invokeRender({
          stream: pageSurfaces.length === 0,
          forceOverlay: pageSurfaces.length > 0
        });
        if (task) await task;
        target.dataset.mtNoTextKey = "";
        if (runtime.isCanonicalRenderComplete(ordinaryProjections, pageRenderOptions)) {
          target.dataset.mtLastTranslatedKey = scopedTargetKey;
          runtime.kakaoRetryScheduler.cancel(target);
        } else {
          target.dataset.mtLastTranslatedKey = "";
        }
      } else {
        if (runtime.hasRenderableOcrDebug(result)) {
          const task = invokeRender({
            stream: false,
            debugOnly: input.debugOnly === true
          });
          if (task) await task;
        } else {
          runtime.clearRenderedTarget(target);
        }
        target.dataset.mtNoTextKey = scopedTargetKey;
        target.dataset.mtLastTranslatedKey = "";
        runtime.kakaoRetryScheduler.cancel(target);
      }
      renderedCount += bubbles.length;
    }
    if (atomicRenderTasks.length > 0) {
      await Promise.all(atomicRenderTasks);
    }
    const seamBubbleCount = seamSurfaces.reduce((count, surface) => count + surface.bubbles.length, 0);
    return {
      ok: true,
      bubbles: renderedCount + seamBubbleCount
    };
  }
  runtime.renderCanonicalProjections = renderCanonicalProjections;
}
