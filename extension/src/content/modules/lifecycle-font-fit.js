export function installLifecycleFontFit(runtime) {
  function fitBubbleFontSize(node, bubbleWidthPx, bubbleHeightPx, options = {}, originalTextHeight) {
    const width = Math.max(8, Math.round(bubbleWidthPx));
    const height = Math.max(8, Math.round(bubbleHeightPx));
    const text = String(node.textContent || "").trim();
    if (!text) return runtime.BUBBLE_FONT_MIN;

    const vertical = node.classList.contains("mt-jp-vertical");
    if (options.backgroundTarget) {
      return runtime.fitPixivBubbleFontSize(node, width, height, text, vertical);
    }
    // Preferred start: original text height (when reliable) > height-based estimate
    const originalH = Number(originalTextHeight) || 0;
    let startSize;
    if (originalH > 0) {
      // Original text fit in this space — use its height as the preferred starting point
      startSize = Math.min(originalH, runtime.BUBBLE_FONT_MAX);
    } else {
      startSize = Math.min(runtime.clamp(height * runtime.BUBBLE_FONT_BASE_RATIO, runtime.BUBBLE_FONT_MIN, runtime.BUBBLE_FONT_MAX), runtime.BUBBLE_FONT_MAX);
    }
    // Cap at the bubble's nominal height (don't exceed what the region can display)
    let maxFont = Math.min(runtime.BUBBLE_FONT_MAX, height * 0.88);
    if (originalH > 0) {
      startSize = Math.min(startSize, originalH * runtime.BUBBLE_FONT_ORIGINAL_SCALE);
      maxFont = Math.min(maxFont, originalH * runtime.BUBBLE_FONT_ORIGINAL_SCALE);
    }
    const sourceHeightKey = originalH > 0 ? Math.round(originalH * 10) / 10 : 0;
    const cacheKey = `std|${vertical ? "v" : "h"}|${width}x${height}|${sourceHeightKey}|${text}`;
    const cachedSize = runtime.state.fontFitCache.get(cacheKey);
    if (Number.isFinite(cachedSize)) {
      const cachedProbe = runtime.prepareBubbleMeasureProbe(node, width, height, text, cachedSize);
      if (runtime.isProbeOverflowing(cachedProbe)) {
        runtime.expandBubbleForTextOverflow(node, width, height, cachedProbe);
      }
      return cachedSize;
    }

    runtime.resetBubbleOverflowExpansion(node);
    const probe = runtime.prepareBubbleMeasureProbe(node, width, height, text, startSize);
    // Binary search: low starts at MIN, high at startSize (the preferred)
    let low = runtime.BUBBLE_FONT_MIN;
    let high = startSize;
    let best = runtime.BUBBLE_FONT_MIN;
    for (let index = 0; index < runtime.BUBBLE_FONT_BINARY_STEPS; index += 1) {
      const mid = (low + high) / 2;
      probe.style.fontSize = `${mid}px`;
      if (runtime.isProbeOverflowing(probe)) high = mid;
      else {
        best = mid;
        low = mid;
      }
    }
    const safetyScale = vertical
      ? runtime.BUBBLE_FONT_VERTICAL_SAFETY_SCALE
      : runtime.BUBBLE_FONT_SAFETY_SCALE;
    let safeSize = runtime.clamp(best * safetyScale, runtime.BUBBLE_FONT_MIN, maxFont);
    probe.style.fontSize = `${safeSize}px`;
    if (runtime.isProbeOverflowing(probe)) {
      runtime.expandBubbleForTextOverflow(node, width, height, probe);
    }
    const normalized = Math.round(safeSize * 10) / 10;
    runtime.rememberFontFitCache(cacheKey, normalized);
    if (runtime.ENABLE_PIPELINE_TRACE) {
      const preview = text.length > 24 ? text.slice(0, 22) + "…" : text;
      console.debug("[MangaTranslator][font-fit]", { text: preview,
        originalH: Number(originalH.toFixed(1)),
        startSize: Number(startSize.toFixed(1)),
        best: Number(best.toFixed(1)),
        safeSize: Number(normalized.toFixed(1)),
        width, height,
        chars: [...text].length,
        overflow: Number(best.toFixed(1)) < Number(startSize.toFixed(1)) ? `height|width` : "none"
      });
    }
    return normalized;
  }
  runtime.fitBubbleFontSize = fitBubbleFontSize;

  function fitPixivBubbleFontSize(node, width, height, text, vertical) {
    const compactText = String(text).replace(/\s+/g, "");
    const length = Math.max(1, Array.from(compactText).length);
    const minReadable = vertical ? 17 : 16;
    const maxReadable = vertical ? 36 : 32;
    const areaSize = Math.sqrt(width * height / length) * (vertical ? 0.95 : 0.78);
    const dimensionSize = vertical
      ? Math.min(width * 0.72, height / Math.min(length, 8) * 1.28)
      : Math.min(height * 0.48, width / Math.min(length, 10) * 1.45);
    const targetSize = runtime.clamp(Math.max(areaSize, dimensionSize), minReadable, maxReadable);
    const cacheKey = `pixiv|${vertical ? "v" : "h"}|${width}x${height}|${text}`;
    const cachedSize = runtime.state.fontFitCache.get(cacheKey);
    if (Number.isFinite(cachedSize)) return cachedSize;

    const probe = runtime.prepareBubbleMeasureProbe(node, width, height, text, targetSize);
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
    if (runtime.state.bubbleMeasureProbe?.isConnected) return runtime.state.bubbleMeasureProbe;
    const probe = document.createElement("div");
    probe.className = "mt-bubble mt-measure-probe";
    document.documentElement.appendChild(probe);
    runtime.state.bubbleMeasureProbe = probe;
    return probe;
  }
  runtime.ensureBubbleMeasureProbe = ensureBubbleMeasureProbe;

  function prepareBubbleMeasureProbe(node, width, height, text, fontSize) {
    runtime.resetBubbleOverflowExpansion(node);
    const probe = runtime.ensureBubbleMeasureProbe();
    probe.className = node.className;
    probe.classList.add("mt-measure-probe");
    probe.classList.remove("mt-show-original");
    probe.style.width = `${width}px`;
    probe.style.height = `${height}px`;
    probe.style.fontSize = `${fontSize}px`;
    probe.replaceChildren();
    // node.children 是 HTMLCollection,没有数组方法;必须 Array.from 才能 .some。
    const hasInnerContent = Array.from(node.children || []).some(child => child.className === "mt-bubble-content");
    if (hasInnerContent) {
      // 气泡文字在 .mt-bubble-content 内层渲染：探针复制同样的两层结构，
      // 保证行距/换行测量与实际节点一致。
      const inner = document.createElement("div");
      inner.className = "mt-bubble-content";
      inner.textContent = text;
      probe.appendChild(inner);
    } else {
      probe.textContent = text;
    }
    return probe;
  }
  runtime.prepareBubbleMeasureProbe = prepareBubbleMeasureProbe;

  runtime.isProbeOverflowing = (probe) => (
    probe.scrollHeight > probe.clientHeight + 0.5 ||
    probe.scrollWidth > probe.clientWidth + 0.5
  );

  function resetBubbleOverflowExpansion(node) {
    if (!node?.style) return;
    node.style.removeProperty("min-width");
    node.style.removeProperty("min-height");
    node.style.removeProperty("--mt-overflow-expanded");
    if (node.dataset?.expandedForText === "true") {
      runtime.restoreBubbleFillVariable(node, "--mt-fill-left", node.dataset.originalFillLeft);
      runtime.restoreBubbleFillVariable(node, "--mt-fill-top", node.dataset.originalFillTop);
      runtime.restoreBubbleFillVariable(node, "--mt-fill-width", node.dataset.originalFillWidth);
      runtime.restoreBubbleFillVariable(node, "--mt-fill-height", node.dataset.originalFillHeight);
    }
    if (node.dataset) node.dataset.expandedForText = "";
  }
  runtime.resetBubbleOverflowExpansion = resetBubbleOverflowExpansion;

  runtime.restoreBubbleFillVariable = (node, name, value) => {
    if (value) node.style.setProperty(name, value);
    else node.style.removeProperty(name);
  };

  function expandBubbleForTextOverflow(node, width, height, probe) {
    if (!node || !probe) return;
    node.style.minWidth = `${Math.max(width, Math.ceil(probe.scrollWidth + 2))}px`;
    node.style.minHeight = `${Math.max(height, Math.ceil(probe.scrollHeight + 2))}px`;
    node.style.setProperty("--mt-overflow-expanded", "1");
    if (!node.dataset) return;
    node.dataset.expandedForText = "true";
    if (!node.classList.contains("mt-bg-solid")) return;
    node.dataset.originalFillLeft = node.style.getPropertyValue("--mt-fill-left") || "";
    node.dataset.originalFillTop = node.style.getPropertyValue("--mt-fill-top") || "";
    node.dataset.originalFillWidth = node.style.getPropertyValue("--mt-fill-width") || "";
    node.dataset.originalFillHeight = node.style.getPropertyValue("--mt-fill-height") || "";
    node.style.setProperty("--mt-fill-left", "0%");
    node.style.setProperty("--mt-fill-top", "0%");
    node.style.setProperty("--mt-fill-width", "100%");
    node.style.setProperty("--mt-fill-height", "100%");
  }
  runtime.expandBubbleForTextOverflow = expandBubbleForTextOverflow;

  function rememberFontFitCache(key, value) {
    runtime.state.fontFitCache.set(key, value);
    if (runtime.state.fontFitCache.size <= runtime.MAX_FONT_FIT_CACHE) return;
    runtime.state.fontFitCache.delete(runtime.state.fontFitCache.keys().next().value);
  }
  runtime.rememberFontFitCache = rememberFontFitCache;

  runtime.getBubbleOriginalTextHeight = (node, bubbleHeightPx, imageHeightPx) => {
    const sourceHeightPercent = Number(node?.dataset?.sourceFontHeightPercent);
    if (sourceHeightPercent > 0 && Number(imageHeightPx) > 0) {
      return Number(imageHeightPx) * sourceHeightPercent / 100;
    }
    return Number(bubbleHeightPx) / Math.max(1, Number(node?.dataset?.sourceLineCount) || 1);
  };
}
