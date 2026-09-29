import { sanitizeRenderRotationDeg } from "../../rendering/cover-geometry.js";

export function installLifecyclePosition(runtime) {
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
      if (runtime.rediscoverRolledBackKakaoPage?.(target)) continue; // RIDI 滚回：标记永不匹配 → 重发现页 handle 重绑并重投影（见 recognition-binding.js）
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
      runtime.traceMaskEvent?.(overlayPageIdOf(runtime, overlayState), "sync-bail", {
        root: overlayState && overlayState.root ? Number(overlayState.root.isConnected) : -1,
        stateMask: String(overlayState && overlayState.cleanedImage || "").length
      });
      return;
    }
    // 清理图（inpainted 遮罩图）校准。它原先只在创建 root 那一刻写一次
    // --mt-cleaned-image，可清理图是**异步**产物（页级 artifact 请求回来的），
    // 覆盖层先上屏、图后到；那一页于是永远停在"没有遮罩"的那一版。这里每次
    // 同步都按 overlayState.cleanedImage 校准一次。
    const maskStyle = overlayState.root.style;
    if (maskStyle && typeof maskStyle.getPropertyValue === "function" && typeof maskStyle.setProperty === "function") {
      const maskUrl = runtime.maskCssValue?.(overlayState.cleanedImage) || "";
      const probe = String(overlayState.root.dataset.mtProbe || "");
      if (maskUrl) {
        if (maskStyle.getPropertyValue("--mt-cleaned-image") !== maskUrl) {
          maskStyle.setProperty("--mt-cleaned-image", maskUrl);
          runtime.traceMaskEvent?.(overlayPageIdOf(runtime, overlayState), "sync-write", {
            len: String(overlayState.cleanedImage).length,
            probe,
            rootPid: String(overlayState.root.dataset.pageId || "").slice(5, 13)
          });
        }
      } else if (maskStyle.getPropertyValue("--mt-cleaned-image")) {
        runtime.traceMaskEvent?.(overlayPageIdOf(runtime, overlayState), "sync-remove", {
          stateMask: String(overlayState.cleanedImage || "").length,
          connected: overlayState.root.isConnected,
          probe
        });
        maskStyle.removeProperty("--mt-cleaned-image");
      }
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
    // 覆盖层和原图挂在同一个滚动容器里（见 resolveOverlayHost），移动交给浏览器合成线程，
    // 所以离开视口不再卸载：卸载/重建才是滚动中「跳走又跳回」的来源。整章保持挂载、
    // 由容器自然裁剪 —— 与跨页（接缝）覆盖层的行为完全一致。
    const keepMounted = true;
    if (runtime.shouldHideOverlayRoot(rect, visible, keepMounted)) {
      overlayState.root.style.display = "none";
      return;
    }
    const layer = typeof runtime.ensureOverlayLayer === "function"
      ? runtime.ensureOverlayLayer(overlayState.target)
      : runtime.state.overlayLayer;
    // 每片内容容器一个图层：目标换了宿主就把 root 搬过去，否则坐标会按别的宿主算。
    if (layer && overlayState.root.parentElement !== layer) {
      layer.appendChild(overlayState.root);
    }
    const layerOrigin = layer && typeof layer.getBoundingClientRect === "function"
      ? layer.getBoundingClientRect()
      : null;
    const viewportRect = runtime.getOverlayPositionRect(rect, layerOrigin);
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
    runtime.syncLoadingOverlayCardPosition(overlayState, rect, targetVisibleRect);

    // 画面平移只更新根节点坐标；尺寸不变时不重新测量文字，避免滚动期间抖动。
    // 但字号尚未适配过的气泡（首次 sync 时覆盖层不可见导致 fit 被跳过，inline
    // fontSize 为空会继承页面默认字号）或此前 rect 无效而挂起的气泡，
    // 尺寸恢复有效后必须补一次适配，否则字号会被钉死在默认值/最小可读值上。
    const pendingFontFit = overlayState.bubbleNodes.some(
      node => node.dataset.mtFontPending === "1" || !node.style.fontSize
    );
    if (!changes.sizeChanged && !pendingFontFit) {
      return;
    }

    // 字号按气泡高度比例计算，并使用 clamp 限制上下界。
    overlayState.bubbleNodes.forEach(node => {
      const polygonGeometry = runtime.getOverlayPolygonGeometry(node, rect);
      const bubbleWidthPercent = Number(node.dataset.wPercent || "0");
      const bubbleHeightPercent = Number(node.dataset.hPercent || "0");
      const bubbleWidthPx = polygonGeometry ? polygonGeometry.width : rect.width * bubbleWidthPercent / 100;
      const bubbleHeightPx = polygonGeometry ? polygonGeometry.height : rect.height * bubbleHeightPercent / 100;
      // 几何自洽：宽盒子不会承载「竖直文字」（±90° 会把宽高互换），见 sanitizeRenderRotationDeg。
      const declaredRotation = Number(node.dataset.rotationDeg || 0);
      const renderRotation = sanitizeRenderRotationDeg(declaredRotation, bubbleWidthPx, bubbleHeightPx);
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
          rotation: renderRotation,
          unit: "px",
          allowVerticalOverflow: true
        });
      } else if (renderRotation !== declaredRotation) {
        // 没有 polygon 的气泡只在创建期按百分比排过一次版，这里补一次修正。
        runtime.applyBubbleAnchorStyle(node, {
          alignment: node.dataset.alignment,
          x: Number(node.dataset.xPercent || 0),
          y: Number(node.dataset.yPercent || 0),
          w: bubbleWidthPercent,
          h: bubbleHeightPercent,
          rotation: renderRotation,
          unit: "%",
          allowVerticalOverflow: node.dataset.stitchOverflow === "true"
        });
      }
      if (bubbleWidthPx < 2 || bubbleHeightPx < 2) {
        // 覆盖层不可见（rect 为 0）时不做字号适配：此时按面积计算会把字号
        // 压到最小可读值，之后滚动回视口也不会重新适配。
        node.dataset.mtFontPending = "1";
        return;
      }
      node.dataset.mtFontPending = "";
      const fittedSize = runtime.fitBubbleFontSize(node, bubbleWidthPx, bubbleHeightPx, {
        backgroundTarget: overlayState.isBackgroundTarget
      }, runtime.getBubbleOriginalTextHeight(node, bubbleHeightPx, rect.height));
      node.style.fontSize = `${fittedSize.toFixed(1)}px`;
      node.style.setProperty("--mt-stroke-width", `${runtime.getDynamicStrokeWidth(fittedSize).toFixed(1)}px`);
    });
  }
  runtime.syncOverlayPosition = syncOverlayPosition;
  function getLoadingOverlayCardPosition(rect, visibleRect, viewportWidth, viewportHeight) {
    if (!rect || !visibleRect) return null;
    const rectRight = Number(rect.right ?? Number(rect.left) + Number(rect.width));
    const rectBottom = Number(rect.bottom ?? Number(rect.top) + Number(rect.height));
    const visibleRight = Number(visibleRect.right ?? Number(visibleRect.left) + Number(visibleRect.width));
    const visibleBottom = Number(visibleRect.bottom ?? Number(visibleRect.top) + Number(visibleRect.height));
    const left = Math.max(Number(rect.left), Number(visibleRect.left), 0);
    const right = Math.min(rectRight, visibleRight, Number(viewportWidth));
    const top = Math.max(Number(rect.top), Number(visibleRect.top), 0);
    const bottom = Math.min(rectBottom, visibleBottom, Number(viewportHeight));
    if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return {
      left: (left + right) / 2 - Number(rect.left),
      top: (top + bottom) / 2 - Number(rect.top)
    };
  }
  runtime.getLoadingOverlayCardPosition = getLoadingOverlayCardPosition;
  function syncLoadingOverlayCardPosition(overlayState, rect, visibleRect) {
    const card = overlayState && (overlayState.loadingCard || overlayState.root.querySelector(".mt-loading-card"));
    if (!card) return;
    // 取消自动跟随：卡片只在首次可见时锚定到图片可见部分的中心，之后不再随滚动/平移重新定位。
    if (card.dataset.mtLoadingPositioned === "1") return;
    const position = runtime.getLoadingOverlayCardPosition(rect, visibleRect, window.innerWidth, window.innerHeight);
    if (!position) return;
    card.dataset.mtLoadingPositioned = "1";
    card.style.position = "absolute";
    card.style.left = `${position.left}px`;
    card.style.top = `${position.top}px`;
    card.style.transform = "translate(-50%, -50%)";
  }
  runtime.syncLoadingOverlayCardPosition = syncLoadingOverlayCardPosition;
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
  function getOverlayPositionRect(rect, origin) {
    // 覆盖层是滚动容器内的绝对定位层：坐标相对「层原点」（= 容器 padding box 原点）。
    // 容器滚动时图片与层一起移动，这个差值在滚动中恒定 —— 不再需要逐帧修正，
    // 也就不会出现覆盖层被拖着走的观感。origin 为空时退化为视口坐标。
    const originLeft = Number(origin && origin.left) || 0;
    const originTop = Number(origin && origin.top) || 0;
    return {
      left: Math.round(rect.left - originLeft),
      top: Math.round(rect.top - originTop),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }
  runtime.getOverlayPositionRect = getOverlayPositionRect;
  function shouldHideOverlayRoot(rect, visible, keepMounted) {
    if (!rect || !(Number(rect.width) >= 2) || !(Number(rect.height) >= 2)) {
      return true;
    }
    // keepMounted（KakaoPage 的页面坐标层、以及分片长条阅读器）：即使暂时离开视口也保持
    // 挂载，由浏览器自然裁剪并随原图一起进入视口 —— 卸载再重建会让覆盖层在滚动中「跳走又跳回」。
    return !keepMounted && !visible;
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

// 与 renderer-mask.js 的 overlayPageId 同一口径：**先看这一 target 此刻绑在哪一页**
// （分片原地换图会换 pageId），再看建 root 时的快照。取证流水要能和
// data-mt-mask-report 里的 pageId 对上，否则分不清"撤的是不是这一页"。
function overlayPageIdOf(runtime, overlayState) {
  const target = overlayState && overlayState.target;
  if (target && runtime.state && runtime.state.kakaoPageIdByTarget) {
    const live = String(runtime.state.kakaoPageIdByTarget.get(target) || "");
    if (live) return live;
  }
  return String((overlayState && overlayState.pageId) || "");
}
