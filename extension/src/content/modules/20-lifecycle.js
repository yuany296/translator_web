export function installContent20(runtime) {
  function recoverRenderedTargets() {
    const now = Date.now();
    if (now - runtime.state.lastRecoveryAt < runtime.RECOVERY_SCAN_GAP_MS) {
      return;
    }
    runtime.state.lastRecoveryAt = now;
    const candidates = Array.from(document.querySelectorAll(runtime.TARGET_SELECTOR)).filter(target => runtime.isSupportedTarget(target)).filter(target => target.isConnected).filter(target => runtime.passesTargetFilter(target, false)).filter(target => runtime.isRectVisible(target.getBoundingClientRect())).map(target => ({
      target,
      area: runtime.getVisibleArea(target.getBoundingClientRect())
    })).sort((left, right) => right.area - left.area).slice(0, runtime.MAX_RECOVERY_TARGETS);
    for (const item of candidates) {
      const target = item.target;
      runtime.registerTarget(target);
      if (runtime.state.inflightByTarget.has(target) || runtime.state.queuedTargets.has(target)) {
        continue;
      }
      const targetKey = runtime.computeTargetKey(target);
      const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
      const renderedKey = target.dataset.mtLastTranslatedKey || "";
      if (runtime.shouldUseKakaoCanonicalPipeline(target) && runtime.kakaoCanonicalPipeline && runtime.state.autoTranslatePageEnabled && runtime.hasPendingTranslationMarkerState(target, targetKey, scopedTargetKey)) {
        // 并发刷新可能让页面保持“有 OCR 证据、投影尚未完成”的 pending 状态。
        // 它没有完成标记，必须在重新进入视口时显式回到统一队列，不能被恢复扫描直接跳过。
        runtime.queuePageAutoTranslate(target);
        continue;
      }
      if (!runtime.matchesTargetMarker(renderedKey, targetKey, scopedTargetKey)) {
        continue;
      }

      // “无文字”是正常终态，本来就不应该存在气泡；恢复扫描不得重新启动 OCR。
      if (runtime.hasSettledNoTextMarker(target, targetKey, scopedTargetKey)) {
        runtime.clearKakaoLoadingOverlay(target);
        runtime.kakaoRetryScheduler.cancel(target);
        continue;
      }
      const targetId = runtime.state.targetIdByElement.get(target);
      if (targetId) {
        const renderedState = runtime.getExistingRenderedState(targetId);
        if (renderedState && runtime.isEmbeddedRenderStillApplied(renderedState)) {
          continue;
        }
        if (renderedState && renderedState.mode === "embedded") {
          runtime.state.embeddedById.delete(targetId);
        }
      }
      if (runtime.shouldUseKakaoCanonicalPipeline(target) && runtime.kakaoCanonicalPipeline) {
        // 所有恢复作业都进入统一队列，确保 queued/inflight 与 finally 清理可观测且成对。
        runtime.queueTranslate(target, {
          manual: true,
          reason: "overlay-recovery"
        });
        continue;
      }
      const localCachedResult = runtime.state.localResultCache.get(scopedTargetKey) || runtime.state.localResultCache.get(targetKey);
      if (localCachedResult && Array.isArray(localCachedResult.bubbles) && localCachedResult.bubbles.length > 0) {
        if (runtime.shouldUseEmbeddedRender(target)) {
          runtime.extractTargetPayload(target, scopedTargetKey).then(payload => runtime.renderTranslationResult(target, targetKey, localCachedResult, payload)).catch(() => {
            // 当前图片不可读时跳过恢复，避免自动触发新的翻译请求。
          });
        } else {
          // 恢复 overlay 时重新去重，确保缓存结果与当前全局去重状态一致。
          // 避免之前被跨图去重移除的气泡在恢复时因未重新比对而再次出现。
          runtime.dedupeKakaoResultByPageCoordinates(localCachedResult, target, targetKey).then(dedupedResult => {
            runtime.state.localResultCache.set(scopedTargetKey, dedupedResult);
            runtime.renderOverlay(target, targetKey, dedupedResult);
          });
        }
        target.dataset.mtLastTranslatedKey = targetKey;
        continue;
      }
    }
  }
  runtime.recoverRenderedTargets = recoverRenderedTargets;
  function syncOverlayPosition(overlayState) {
    if (!overlayState || !overlayState.target || !overlayState.root.isConnected) {
      return;
    }
    if (overlayState.sourceToken && runtime.getQuickSourceToken(overlayState.target) !== overlayState.sourceToken) {
      const stalePageId = String(runtime.state.kakaoPageIdByTarget.get(overlayState.target) || "");
      if (stalePageId) {
        if (runtime.state.kakaoStore && typeof runtime.state.kakaoStore.unbindPageTarget === "function") {
          runtime.state.kakaoStore.unbindPageTarget(overlayState.target);
        }
        runtime.unbindKakaoTargetFromPage(overlayState.target);
        runtime.scheduleKakaoProjectionRefresh([stalePageId], "page-handle-source-changed");
      }
      overlayState.root.remove();
      runtime.state.overlaysById.delete(overlayState.targetId);
      if (runtime.state.overlaysById.size === 0) {
        runtime.stopOverlayFrameSync();
      }
      return;
    }
    if (!overlayState.target.isConnected) {
      const disconnectedPageId = runtime.detachKakaoTargetHandle(overlayState.target);
      if (disconnectedPageId) {
        runtime.scheduleKakaoProjectionRefresh([disconnectedPageId], "page-handle-disconnected");
      }
      overlayState.root.remove();
      runtime.state.overlaysById.delete(overlayState.targetId);
      if (runtime.state.overlaysById.size === 0) {
        runtime.stopOverlayFrameSync();
      }
      return;
    }
    const rect = runtime.getOverlayDisplayRect(overlayState);
    const targetVisibleRect = runtime.getVisibleViewportRect(overlayState.target);
    if (!targetVisibleRect) {
      overlayState.root.style.display = "none";
      overlayState.root.style.removeProperty("clip-path");
      return;
    }
    const visible = runtime.isRectVisible(runtime.getOverlayVisibilityRect(overlayState, rect));
    const useDocumentFlow = runtime.IS_KAKAOPAGE_READER;
    if (runtime.shouldHideOverlayRoot(rect, visible, useDocumentFlow)) {
      overlayState.root.style.display = "none";
      return;
    }
    const viewportRect = runtime.getOverlayPositionRect(rect, useDocumentFlow, window.scrollX || 0, window.scrollY || 0);
    const changes = runtime.compareOverlayViewportRects(overlayState.lastViewportRect, viewportRect);
    overlayState.root.style.display = "block";
    const clipLeft = Math.max(0, targetVisibleRect.left - rect.left);
    const clipRight = Math.max(0, rect.right - targetVisibleRect.right);
    if (clipLeft > 0.5 || clipRight > 0.5) {
      overlayState.root.style.clipPath = `inset(0 ${clipRight}px 0 ${clipLeft}px)`;
    } else {
      overlayState.root.style.removeProperty("clip-path");
    }
    if (changes.positionChanged || changes.sizeChanged) {
      overlayState.root.style.left = `${viewportRect.left}px`;
      overlayState.root.style.top = `${viewportRect.top}px`;
      overlayState.root.style.width = `${viewportRect.width}px`;
      overlayState.root.style.height = `${viewportRect.height}px`;
      overlayState.lastViewportRect = viewportRect;
    }

    // seam 内部使用固定的合并画布；页面尺寸变化时只更新整幅场景的平移和缩放，
    // 不触发译文重新换行或字号拟合。
    if (changes.sizeChanged) {
      runtime.syncSeamOverlayTransforms(overlayState, {
        width: viewportRect.width,
        height: viewportRect.height
      });
    }

    // 画面平移只更新根节点坐标；尺寸不变时不重新测量文字，避免滚动期间抖动。
    if (!changes.sizeChanged) {
      return;
    }

    // 字号按气泡高度比例计算，并使用 clamp 限制上下界。
    overlayState.bubbleNodes.forEach(node => {
      const polygonGeometry = runtime.getOverlayPolygonGeometry(node, rect);
      const bubbleWidthPercent = Number(node.dataset.wPercent || "0");
      const bubbleHeightPercent = Number(node.dataset.hPercent || "0");
      const bubbleWidthPx = polygonGeometry ? polygonGeometry.width : rect.width * bubbleWidthPercent / 100;
      const bubbleHeightPx = polygonGeometry ? polygonGeometry.height : rect.height * bubbleHeightPercent / 100;
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
      }
      const fittedSize = runtime.fitBubbleFontSize(node, bubbleWidthPx, bubbleHeightPx, {
        backgroundTarget: overlayState.isBackgroundTarget
      }, runtime.getBubbleOriginalTextHeight(node, bubbleHeightPx, rect.height));
      node.style.fontSize = `${fittedSize.toFixed(1)}px`;
      node.style.setProperty("--mt-stroke-width", `${runtime.getDynamicStrokeWidth(fittedSize).toFixed(1)}px`);
    });
  }
  runtime.syncOverlayPosition = syncOverlayPosition;
  function compareOverlayViewportRects(previous, next) {
    if (!previous) {
      return {
        positionChanged: true,
        sizeChanged: true
      };
    }
    return {
      positionChanged: previous.left !== next.left || previous.top !== next.top,
      sizeChanged: previous.width !== next.width || previous.height !== next.height
    };
  }
  runtime.compareOverlayViewportRects = compareOverlayViewportRects;
  function getOverlayPositionRect(rect, useDocumentFlow, scrollX = 0, scrollY = 0) {
    const offsetX = useDocumentFlow ? Number(scrollX) || 0 : 0;
    const offsetY = useDocumentFlow ? Number(scrollY) || 0 : 0;
    return {
      left: Math.round(rect.left + offsetX),
      top: Math.round(rect.top + offsetY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }
  runtime.getOverlayPositionRect = getOverlayPositionRect;
  function shouldHideOverlayRoot(rect, visible, useDocumentFlow) {
    if (!rect || !(Number(rect.width) >= 2) || !(Number(rect.height) >= 2)) {
      return true;
    }
    // 页面坐标覆盖层即使暂时离开视口也保持挂载，由浏览器自然裁剪并随原图一起进入视口。
    return !useDocumentFlow && !visible;
  }
  runtime.shouldHideOverlayRoot = shouldHideOverlayRoot;
  function getOverlayVisibilityRect(overlayState, rect) {
    let minY = 0;
    let maxY = 100;
    Array.from(overlayState && overlayState.bubbleNodes || []).forEach(node => {
      if (!node || !node.dataset || node.dataset.stitchOverflow !== "true") {
        return;
      }
      const y = Number(node.dataset.yPercent);
      const h = Number(node.dataset.hPercent);
      if (!Number.isFinite(y) || !Number.isFinite(h) || h <= 0) {
        return;
      }
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + h);
    });
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top + minY / 100 * rect.height,
      bottom: rect.top + maxY / 100 * rect.height,
      width: rect.width,
      height: (maxY - minY) / 100 * rect.height
    };
  }
  runtime.getOverlayVisibilityRect = getOverlayVisibilityRect;
  function getDynamicStrokeWidth(fontSize) {
    const width = runtime.clamp((Number(fontSize) || 0) * 0.085, 1.8, 4.2);
    return Math.round(width * 10) / 10;
  }
  runtime.getDynamicStrokeWidth = getDynamicStrokeWidth;
  function getOverlayPolygonGeometry(node, rect) {
    if (!node.dataset.polygon) {
      return null;
    }
    try {
      const polygon = JSON.parse(node.dataset.polygon);
      if (!Array.isArray(polygon) || polygon.length < 4) {
        return null;
      }
      const points = polygon.slice(0, 4).map(point => ({
        x: Number(point.x) / 100 * rect.width,
        y: Number(point.y) / 100 * rect.height
      }));
      if (!points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) {
        return null;
      }
      const edges = points.map((point, index) => {
        const next = points[(index + 1) % points.length];
        return Math.hypot(next.x - point.x, next.y - point.y);
      });
      // 后端按文字基线方向排列四点，因此 0/2 边是宽度，1/3 边是高度。
      const left = Math.min(...points.map(point => point.x));
      const top = Math.min(...points.map(point => point.y));
      const right = Math.max(...points.map(point => point.x));
      const bottom = Math.max(...points.map(point => point.y));
      const width = Math.max(8, (edges[0] + edges[2]) / 2);
      const height = Math.max(8, (edges[1] + edges[3]) / 2);
      return {
        left,
        top,
        right,
        bottom,
        centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
        width: Math.max(8, width),
        height
      };
    } catch {
      return null;
    }
  }
  runtime.getOverlayPolygonGeometry = getOverlayPolygonGeometry;
}
