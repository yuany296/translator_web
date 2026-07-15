export function installLifecycleFontFit(runtime) {
  function fitBubbleFontSize(node, bubbleWidthPx, bubbleHeightPx, options = {}, originalTextHeight) {
    const width = Math.max(8, Math.round(bubbleWidthPx));
    const height = Math.max(8, Math.round(bubbleHeightPx));
    const text = String(node.textContent || "").trim();
    if (!text) {
      return runtime.BUBBLE_FONT_MIN;
    }
    const vertical = node.classList.contains("mt-jp-vertical");
    if (options.backgroundTarget) {
      return runtime.fitPixivBubbleFontSize(node, width, height, text, vertical);
    }
    let maxFont = options.backgroundTarget ? 34 : runtime.BUBBLE_FONT_MAX;
    const baseRatio = options.backgroundTarget ? 0.42 : runtime.BUBBLE_FONT_BASE_RATIO;
    const safetyScale = options.backgroundTarget ? 0.96 : runtime.BUBBLE_FONT_SAFETY_SCALE;
    const verticalSafetyScale = options.backgroundTarget ? 0.94 : runtime.BUBBLE_FONT_VERTICAL_SAFETY_SCALE;
    let startSize = Math.min(maxFont, runtime.clamp(height * baseRatio, runtime.BUBBLE_FONT_MIN, maxFont));

    // Cap font size to original text height — only shrink, never enlarge
    if (typeof originalTextHeight === "number" && originalTextHeight > 0) {
      const originalLineCap = originalTextHeight * runtime.BUBBLE_FONT_ORIGINAL_SCALE;
      startSize = Math.min(startSize, originalLineCap);
      maxFont = Math.min(maxFont, originalLineCap);
    }
    const sourceHeightKey = typeof originalTextHeight === "number" && originalTextHeight > 0 ? Math.round(originalTextHeight * 10) / 10 : 0;
    const cacheKey = `${options.backgroundTarget ? "bg" : "std"}|${vertical ? "v" : "h"}|${width}x${height}|${sourceHeightKey}|${text}`;
    const cachedSize = runtime.state.fontFitCache.get(cacheKey);
    if (typeof cachedSize === "number" && Number.isFinite(cachedSize)) {
      runtime.resetBubbleOverflowExpansion(node);
      const cachedProbe = runtime.ensureBubbleMeasureProbe();
      cachedProbe.className = node.className;
      cachedProbe.classList.add("mt-measure-probe");
      cachedProbe.classList.remove("mt-show-original");
      cachedProbe.style.width = `${width}px`;
      cachedProbe.style.height = `${height}px`;
      cachedProbe.style.fontSize = `${cachedSize}px`;
      cachedProbe.textContent = text;
      if (runtime.isProbeOverflowing(cachedProbe)) {
        runtime.expandBubbleForTextOverflow(node, width, height, cachedProbe);
      }
      return cachedSize;
    }
    runtime.resetBubbleOverflowExpansion(node);
    const probe = runtime.ensureBubbleMeasureProbe();
    probe.className = node.className;
    probe.classList.add("mt-measure-probe");
    probe.classList.remove("mt-show-original");
    probe.style.width = `${width}px`;
    probe.style.height = `${height}px`;
    probe.textContent = text;
    let low = runtime.BUBBLE_FONT_MIN;
    let high = startSize;
    let best = runtime.BUBBLE_FONT_MIN;
    for (let index = 0; index < runtime.BUBBLE_FONT_BINARY_STEPS; index += 1) {
      const mid = (low + high) / 2;
      probe.style.fontSize = `${mid}px`;
      if (runtime.isProbeOverflowing(probe)) {
        high = mid;
      } else {
        best = mid;
        low = mid;
      }
    }
    let safeScale = vertical ? verticalSafetyScale : safetyScale;
    let safeSize = runtime.clamp(best * safeScale, runtime.BUBBLE_FONT_MIN, maxFont);

    // Re-apply original text height cap on final result
    if (typeof originalTextHeight === "number" && originalTextHeight > 0) {
      const originalLineCap = originalTextHeight * runtime.BUBBLE_FONT_ORIGINAL_SCALE;
      safeSize = Math.min(safeSize, originalLineCap);
    }
    probe.style.fontSize = `${safeSize}px`;
    if (runtime.isProbeOverflowing(probe)) {
      runtime.expandBubbleForTextOverflow(node, width, height, probe);
    }
    const normalized = Math.round(safeSize * 10) / 10;
    runtime.rememberFontFitCache(cacheKey, normalized);
    return normalized;
  }
  runtime.fitBubbleFontSize = fitBubbleFontSize;
  function fitPixivBubbleFontSize(node, width, height, text, vertical) {
    const compactText = String(text || "").replace(/\s+/g, "");
    const length = Math.max(1, Array.from(compactText).length);
    const minReadable = vertical ? 17 : 16;
    const maxReadable = vertical ? 36 : 32;
    const area = Math.max(1, width * height);
    const areaSize = Math.sqrt(area / Math.max(1, length)) * (vertical ? 0.95 : 0.78);
    const dimensionSize = vertical ? Math.min(width * 0.72, height / Math.min(length, 8) * 1.28) : Math.min(height * 0.48, width / Math.min(length, 10) * 1.45);
    const targetSize = runtime.clamp(Math.max(areaSize, dimensionSize), minReadable, maxReadable);
    const cacheKey = `pixiv|${vertical ? "v" : "h"}|${width}x${height}|${text}`;
    const cachedSize = runtime.state.fontFitCache.get(cacheKey);
    if (typeof cachedSize === "number" && Number.isFinite(cachedSize)) {
      return cachedSize;
    }
    const probe = runtime.ensureBubbleMeasureProbe();
    probe.className = node.className;
    probe.classList.add("mt-measure-probe");
    probe.classList.remove("mt-show-original");
    probe.style.width = `${width}px`;
    probe.style.height = `${height}px`;
    probe.style.fontSize = `${targetSize}px`;
    probe.textContent = text;
    let size = targetSize;
    while (size > minReadable && runtime.isProbeOverflowing(probe)) {
      size -= 1;
      probe.style.fontSize = `${size}px`;
    }
    const normalized = Math.round(runtime.clamp(size, minReadable, maxReadable) * 10) / 10;
    runtime.rememberFontFitCache(cacheKey, normalized);
    return normalized;
  }
  runtime.fitPixivBubbleFontSize = fitPixivBubbleFontSize;
  function ensureBubbleMeasureProbe() {
    if (runtime.state.bubbleMeasureProbe && runtime.state.bubbleMeasureProbe.isConnected) {
      return runtime.state.bubbleMeasureProbe;
    }
    const probe = document.createElement("div");
    probe.className = "mt-bubble mt-measure-probe";
    document.documentElement.appendChild(probe);
    runtime.state.bubbleMeasureProbe = probe;
    return probe;
  }
  runtime.ensureBubbleMeasureProbe = ensureBubbleMeasureProbe;
  function isProbeOverflowing(probe) {
    return probe.scrollHeight > probe.clientHeight + 0.5 || probe.scrollWidth > probe.clientWidth + 0.5;
  }
  runtime.isProbeOverflowing = isProbeOverflowing;
  function resetBubbleOverflowExpansion(node) {
    if (!node || !node.style) return;
    node.style.removeProperty("min-width");
    node.style.removeProperty("min-height");
    node.style.removeProperty("--mt-overflow-expanded");
    if (node.dataset) {
      if (node.dataset.expandedForText === "true") {
        runtime.restoreBubbleFillVariable(node, "--mt-fill-left", node.dataset.originalFillLeft);
        runtime.restoreBubbleFillVariable(node, "--mt-fill-top", node.dataset.originalFillTop);
        runtime.restoreBubbleFillVariable(node, "--mt-fill-width", node.dataset.originalFillWidth);
        runtime.restoreBubbleFillVariable(node, "--mt-fill-height", node.dataset.originalFillHeight);
      }
      node.dataset.expandedForText = "";
    }
  }
  runtime.resetBubbleOverflowExpansion = resetBubbleOverflowExpansion;
  function restoreBubbleFillVariable(node, name, value) {
    if (value) {
      node.style.setProperty(name, value);
    } else {
      node.style.removeProperty(name);
    }
  }
  runtime.restoreBubbleFillVariable = restoreBubbleFillVariable;
  function expandBubbleForTextOverflow(node, width, height, probe) {
    if (!node || !probe) return;
    const requiredWidth = Math.max(width, Math.ceil(probe.scrollWidth + 2));
    const requiredHeight = Math.max(height, Math.ceil(probe.scrollHeight + 2));
    node.style.minWidth = `${requiredWidth}px`;
    node.style.minHeight = `${requiredHeight}px`;
    node.style.setProperty("--mt-overflow-expanded", "1");
    if (node.dataset) {
      node.dataset.expandedForText = "true";
    }
    if (node.classList && node.classList.contains("mt-bg-solid")) {
      if (node.dataset) {
        node.dataset.originalFillLeft = node.style.getPropertyValue("--mt-fill-left") || "";
        node.dataset.originalFillTop = node.style.getPropertyValue("--mt-fill-top") || "";
        node.dataset.originalFillWidth = node.style.getPropertyValue("--mt-fill-width") || "";
        node.dataset.originalFillHeight = node.style.getPropertyValue("--mt-fill-height") || "";
      }
      node.style.setProperty("--mt-fill-left", "0%");
      node.style.setProperty("--mt-fill-top", "0%");
      node.style.setProperty("--mt-fill-width", "100%");
      node.style.setProperty("--mt-fill-height", "100%");
    }
  }
  runtime.expandBubbleForTextOverflow = expandBubbleForTextOverflow;
  function rememberFontFitCache(key, value) {
    runtime.state.fontFitCache.set(key, value);
    if (runtime.state.fontFitCache.size <= runtime.MAX_FONT_FIT_CACHE) {
      return;
    }
    const firstKey = runtime.state.fontFitCache.keys().next().value;
    if (firstKey) {
      runtime.state.fontFitCache.delete(firstKey);
    }
  }
  runtime.rememberFontFitCache = rememberFontFitCache;
  function clearKakaoLoadingOverlay(target) {
    const targetId = runtime.state.targetIdByElement.get(target);
    if (!targetId) return false;
    const overlayState = runtime.state.overlaysById.get(targetId);
    if (!overlayState) return false;
    if (overlayState.mode !== "loading") {
      const card = overlayState.loadingCard || overlayState.root.querySelector(".mt-loading-card-status");
      if (!card) return false;
      card.remove();
      overlayState.loadingCard = null;
      return true;
    }
    runtime.removeOverlayForTarget(target);
    return true;
  }
  runtime.clearKakaoLoadingOverlay = clearKakaoLoadingOverlay;
  function syncSeamCrossPageOverlays() {
    if (!runtime.state.seamCrossPages || runtime.state.seamCrossPages.size === 0) return;
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    for (const [renderKey, entry] of runtime.state.seamCrossPages) {
      if (!entry.root.isConnected) {
        runtime.state.seamCrossPages.delete(renderKey);
        continue;
      }
      const targetA = entry.targetA && entry.targetA.isConnected ? entry.targetA : null;
      const targetB = entry.targetB && entry.targetB.isConnected ? entry.targetB : null;
      if (!targetA || !targetB) {
        entry.root.remove();
        runtime.state.seamCrossPages.delete(renderKey);
        continue;
      }
      const rectA = targetA.getBoundingClientRect();
      const cssTop = rectA.top + entry.seamCropTop;
      const newLeft = rectA.left + scrollX;
      const newTop = cssTop + scrollY;
      if (entry.lastLeft !== newLeft || entry.lastTop !== newTop) {
        entry.root.style.left = `${newLeft}px`;
        entry.root.style.top = `${newTop}px`;
        entry.lastLeft = newLeft;
        entry.lastTop = newTop;
      }
    }
  }
  runtime.syncSeamCrossPageOverlays = syncSeamCrossPageOverlays;
  function getBubbleOriginalTextHeight(node, bubbleHeightPx, imageHeightPx) {
    const sourceFontHeightPercent = Number(node && node.dataset && node.dataset.sourceFontHeightPercent);
    if (sourceFontHeightPercent > 0 && Number(imageHeightPx) > 0) {
      return Number(imageHeightPx) * sourceFontHeightPercent / 100;
    }
    return Number(bubbleHeightPx) / Math.max(1, Number(node && node.dataset && node.dataset.sourceLineCount) || 1);
  }
  runtime.getBubbleOriginalTextHeight = getBubbleOriginalTextHeight;
  function removeSeamCrossPageOverlays(target = null) {
    if (runtime.state.seamCrossPages && runtime.state.seamCrossPages.size > 0) {
      for (const [renderKey, entry] of runtime.state.seamCrossPages) {
        if (target && entry && entry.targetA !== target && entry.targetB !== target) continue;
        if (entry && entry.root && entry.root.isConnected) entry.root.remove();
        runtime.state.seamCrossPages.delete(renderKey);
      }
    }

    // 热更新或旧版本状态丢失时，DOM 中可能仍有无状态的旧根节点。
    // canonical renderer 只保留新的 hosted seam surface，旧根节点必须整体移除。
    const staleRoots = runtime.state.overlayLayer && runtime.state.overlayLayer.querySelectorAll ? runtime.state.overlayLayer.querySelectorAll(".mt-seam-cross-page") : [];
    Array.from(staleRoots).forEach(root => root.remove());
    if (runtime.state.seamCrossPages && runtime.state.seamCrossPages.size === 0) {
      runtime.state.seamCrossPages.clear();
    }
  }
  runtime.removeSeamCrossPageOverlays = removeSeamCrossPageOverlays;
  function removeSeamSurfaceEntriesForTarget(target) {
    const pageId = String(runtime.state.kakaoPageIdByTarget.get(target) || runtime.state.kakaoStore && typeof runtime.state.kakaoStore.getPageHandleForTarget === "function" && (runtime.state.kakaoStore.getPageHandleForTarget(target) || {}).pageId || "");
    if (!pageId) return;
    for (const [targetId, overlayState] of runtime.state.overlaysById) {
      const seamEntries = Array.isArray(overlayState && overlayState.seamEntries) ? overlayState.seamEntries : [];
      if (seamEntries.length === 0) continue;
      const keepEntries = [];
      for (const entry of seamEntries) {
        const pageIds = Array.isArray(entry.surface && entry.surface.pageIds) ? entry.surface.pageIds.map(String) : [];
        if (pageIds.includes(pageId)) {
          if (entry.windowNode && entry.windowNode.isConnected) entry.windowNode.remove();
        } else {
          keepEntries.push(entry);
        }
      }
      if (keepEntries.length === seamEntries.length) continue;
      overlayState.seamEntries = keepEntries;
      overlayState.root.dataset.seamRenderKeys = keepEntries.map(entry => entry.surface && entry.surface.renderKey).filter(Boolean).join(" ");
      const seamBubbleCount = keepEntries.reduce((sum, entry) => sum + (entry.bubbleNodes || []).length, 0);
      overlayState.bubbleCount = overlayState.bubbleNodes.length + seamBubbleCount;
      if (overlayState.bubbleCount === 0 && overlayState.debugNodeCount === 0) {
        if (overlayState.loadingTimeout) window.clearTimeout(overlayState.loadingTimeout);
        overlayState.root.remove();
        runtime.state.overlaysById.delete(targetId);
      }
    }
  }
  runtime.removeSeamSurfaceEntriesForTarget = removeSeamSurfaceEntriesForTarget;
  function removeOverlayForTarget(target) {
    runtime.removeSeamCrossPageOverlays(target);
    runtime.removeSeamSurfaceEntriesForTarget(target);
    const targetId = runtime.state.targetIdByElement.get(target);
    if (!targetId) {
      return;
    }
    const overlayState = runtime.state.overlaysById.get(targetId);
    if (!overlayState) {
      return;
    }

    // 清除 loading 超时定时器
    if (overlayState.loadingTimeout) {
      window.clearTimeout(overlayState.loadingTimeout);
      overlayState.loadingTimeout = 0;
    }
    overlayState.root.remove();
    runtime.state.overlaysById.delete(targetId);
    if (runtime.state.overlaysById.size === 0) {
      runtime.stopOverlayFrameSync();
    }
  }
  runtime.removeOverlayForTarget = removeOverlayForTarget;
}
