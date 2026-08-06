export function installRendererCanvas(runtime) {
  function getEmbeddedPolygonGeometry(value, canvasWidth, canvasHeight) {
    if (!Array.isArray(value) || value.length < 4) return null;
    const points = value.slice(0, 4).map(point => ({
      x: Number(point?.x) / 100 * canvasWidth,
      y: Number(point?.y) / 100 * canvasHeight
    }));
    if (!points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
    const edges = points.map((point, index) => {
      const next = points[(index + 1) % points.length];
      return Math.hypot(next.x - point.x, next.y - point.y);
    });
    return {
      centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      width: Math.max(8, (edges[0] + edges[2]) / 2),
      height: Math.max(8, (edges[1] + edges[3]) / 2)
    };
  }
  runtime.getEmbeddedPolygonGeometry = getEmbeddedPolygonGeometry;

  function drawFittedText(ctx, text, box, bgType, options = {}) {
    const textScale = Number(options.textScale || 1);
    const minFont = Number(options.minFont || 8);
    // 上限只作异常保护;preferredFont(原文字高)正常时才是真正的目标字号。
    const maxFont = Number(options.maxFont || 120);
    const preferredFont = Number(options.preferredFont || 0);
    const maxWidth = Math.max(6, box.w * Number(options.widthUsage || 0.82));
    const maxHeight = Math.max(6, box.h * Number(options.heightUsage || 0.68));
    const family = '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
    let best = { size: minFont, lines: [text] };
    let low = minFont;
    let high = Math.max(minFont + 1, Math.min(
      maxFont,
      box.h * 0.68 * textScale,
      box.w * 0.38 * textScale
    ));
    if (preferredFont > 0) {
      // 以 OCR 测得的原文字高为目标字号（canvas 像素，无需 textScale），
      // 译文装不下时才向下缩小，与 DOM 覆盖层的 fitBubbleFontSize 行为一致。
      high = Math.min(high, preferredFont * 1.08);
    }
    for (let index = 0; index < 9; index += 1) {
      const size = (low + high) / 2;
      ctx.font = `600 ${size}px ${family}`;
      const lines = runtime.wrapCanvasText(ctx, text, maxWidth);
      const lineHeight = size * 1.22;
      const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
      if (lines.length * lineHeight <= maxHeight && widest <= maxWidth) {
        best = { size, lines };
        low = size;
      } else high = size;
    }
    ctx.save();
    ctx.font = `500 ${best.size}px ${family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    if (bgType === "none") {
      ctx.strokeStyle = String(options.strokeColor || "#ffffff");
      ctx.lineWidth = runtime.getDynamicStrokeWidth(best.size);
    }
    const lineHeight = best.size * 1.22;
    const startY = box.y + box.h / 2 - (best.lines.length - 1) * lineHeight / 2;
    const centerX = box.x + box.w / 2;
    best.lines.forEach((line, index) => {
      const lineY = startY + index * lineHeight;
      if (bgType === "none") ctx.strokeText(line, centerX, lineY);
      ctx.fillStyle = String(options.textColor || "#111827");
      ctx.fillText(line, centerX, lineY);
    });
    ctx.restore();
  }
  runtime.drawFittedText = drawFittedText;

  function wrapCanvasText(ctx, text, maxWidth) {
    const paragraphs = String(text || "").split(/\n+/).map(item => item.trim()).filter(Boolean);
    const lines = [];
    paragraphs.forEach(paragraph => {
      const tokens = runtime.segmentCanvasText(paragraph);
      const joiner = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(paragraph) ? "" : " ";
      let current = "";
      tokens.forEach(token => {
        const next = current ? `${current}${joiner}${token}` : token;
        if (ctx.measureText(next).width <= maxWidth || !current) current = next;
        else {
          lines.push(current);
          current = token;
        }
      });
      if (current) lines.push(current);
    });
    return lines.length > 0 ? lines : [String(text || "")];
  }
  runtime.wrapCanvasText = wrapCanvasText;

  function segmentCanvasText(text) {
    const raw = String(text || "").trim();
    if (!raw) return [];
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) {
      return Array.from(raw.replace(/\s+/g, ""));
    }
    return raw.split(/(\s+)/).filter(token => token && !/^\s+$/.test(token));
  }
  runtime.segmentCanvasText = segmentCanvasText;

  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Embedded image decode failed"));
      image.src = dataUrl;
    });
  }
  runtime.loadImageFromDataUrl = loadImageFromDataUrl;
  async function decodeDataUrlImageSize(dataUrl) {
    const image = await runtime.loadImageFromDataUrl(dataUrl);
    return {
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0
    };
  }
  runtime.decodeDataUrlImageSize = decodeDataUrlImageSize;
  function shouldKeepLoadingOverlayAfterTimeout(target, taskActive) {
    return Boolean(target && target.isConnected !== false && taskActive);
  }
  runtime.shouldKeepLoadingOverlayAfterTimeout = shouldKeepLoadingOverlayAfterTimeout;
  function getLoadingOverlayRecoveryDiagnostic(settled) {
    return {
      level: "info",
      code: settled ? "loading-overlay-recovered-settled" : "loading-overlay-recovered-orphan"
    };
  }
  runtime.getLoadingOverlayRecoveryDiagnostic = getLoadingOverlayRecoveryDiagnostic;
  function scheduleLoadingOverlayTimeout(overlayState) {
    if (!overlayState) return;
    if (overlayState.loadingTimeout) {
      window.clearTimeout(overlayState.loadingTimeout);
    }
    overlayState.loadingTimeout = window.setTimeout(() => {
      overlayState.loadingTimeout = 0;
      if (!overlayState.root.isConnected) return;
      const current = runtime.state.overlaysById.get(overlayState.targetId);
      const hasProgressCard = current && (current.mode === "loading" || current.loadingCard && current.loadingCard.isConnected);
      if (current !== overlayState || !hasProgressCard) return;
      const target = overlayState.target;
      const targetKey = overlayState.targetKey;
      const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
      const settled = runtime.hasSettledTranslationMarker(target, targetKey, scopedTargetKey);
      const taskActive = runtime.state.inflightByTarget.has(target) || runtime.state.queuedTargets.has(target);
      if (runtime.shouldKeepLoadingOverlayAfterTimeout(target, taskActive)) {
        // 慢任务仍在队列或执行时，loading 是真实状态，不能因 UI 看门时间到而消失。
        runtime.syncOverlayPosition(overlayState);
        runtime.scheduleLoadingOverlayTimeout(overlayState);
        runtime.reportStatus("warn", "loading-overlay-still-active", {
          targetKey: String(targetKey).slice(0, 80),
          settled,
          taskActive
        }).catch(() => {});
        return;
      }
      const diagnostic = runtime.getLoadingOverlayRecoveryDiagnostic(settled);
      const diagnosticTargetKey = String(targetKey).slice(0, 80) || "unknown-target";
      // 看门狗已经成功恢复 UI，不应以 console.warn 进入扩展错误列表。
      console.info(`[MangaTranslator] Recovered stale loading overlay (${diagnostic.code}): ${diagnosticTargetKey}`);
      if (overlayState.mode === "loading") {
        overlayState.root.remove();
        runtime.state.overlaysById.delete(overlayState.targetId);
        if (runtime.state.overlaysById.size === 0) {
          runtime.stopOverlayFrameSync();
        }
      } else {
        runtime.clearKakaoLoadingOverlay(target);
      }
      if (target.isConnected && runtime.state.autoTranslatePageEnabled && !settled) {
        runtime.scheduleAutoTranslateRetry(target);
      }
      runtime.reportStatus(diagnostic.level, diagnostic.code, {
        targetKey: String(targetKey).slice(0, 80),
        settled,
        taskActive
      }).catch(() => {});
    }, runtime.LOADING_OVERLAY_TIMEOUT_MS);
  }
  runtime.scheduleLoadingOverlayTimeout = scheduleLoadingOverlayTimeout;
  function renderLoadingOverlay(target, targetKey, text) {
    runtime.ensureOverlayLayer();
    const targetId = runtime.getTargetId(target);
    const oldOverlay = runtime.state.overlaysById.get(targetId);
    if (oldOverlay && oldOverlay.targetKey === targetKey && oldOverlay.mode === "loading") {
      runtime.updateLoadingOverlayText(target, targetKey, text);
      runtime.syncOverlayPosition(oldOverlay);
      runtime.scheduleLoadingOverlayTimeout(oldOverlay);
      return;
    }
    if (runtime.shouldPreserveOverlayDuringLoading(oldOverlay, targetKey)) {
      // 已有译文可继续显示，后续 seam/投影阶段在后台完成，避免稳定内容闪烁。
      // 同时保留独立的进度胶囊，避免后台仍在运行时 loading 从画面消失。
      runtime.ensureLoadingStatusCard(oldOverlay, text);
      runtime.syncOverlayPosition(oldOverlay);
      runtime.scheduleLoadingOverlayTimeout(oldOverlay);
      return;
    }
    if (oldOverlay) {
      if (oldOverlay.loadingTimeout) {
        window.clearTimeout(oldOverlay.loadingTimeout);
        oldOverlay.loadingTimeout = 0;
      }
      oldOverlay.root.remove();
      runtime.state.overlaysById.delete(targetId);
    }
    const root = document.createElement("div");
    root.className = "mt-overlay-root mt-overlay-loading";
    root.dataset.mangaTranslatorOverlay = "true";
    root.dataset.targetId = targetId;
    const loadingCard = document.createElement("div");
    loadingCard.className = "mt-loading-card";
    loadingCard.dataset.mangaTranslatorOverlay = "true";
    loadingCard.textContent = String(text || "OCR + 翻译中...");
    root.appendChild(loadingCard);
    const overlayState = {
      target,
      targetId,
      targetKey,
      root,
      bubbleNodes: [],
      bubbleCount: 0,
      mode: "loading",
      loadingTimeout: 0
    };
    runtime.state.overlayLayer.appendChild(root);
    runtime.state.overlaysById.set(targetId, overlayState);
    runtime.syncOverlayPosition(overlayState);
    runtime.ensureOverlayFrameSync();
    runtime.scheduleLoadingOverlayTimeout(overlayState);
  }
  runtime.renderLoadingOverlay = renderLoadingOverlay;
}
