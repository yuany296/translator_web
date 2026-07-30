export function installLifecycleBubble(runtime) {
  function updateLoadingOverlayText(target, targetKey, text) {
    const targetId = runtime.state.targetIdByElement.get(target);
    if (!targetId) {
      return;
    }
    const overlayState = runtime.state.overlaysById.get(targetId);
    if (!overlayState || overlayState.targetKey !== targetKey) {
      return;
    }
    const node = overlayState.loadingCard || overlayState.root.querySelector(".mt-loading-card");
    if (!node) {
      return;
    }
    node.textContent = String(text || "OCR + 翻译中...");
  }
  runtime.updateLoadingOverlayText = updateLoadingOverlayText;
  function createBubbleNode(bubble, index, options = {}) {
    let x = runtime.clamp(Number(bubble.x), 0, 100);
    let y = bubble.stitch_overflow === true ? Number(bubble.y) : runtime.clamp(Number(bubble.y), 0, 100);
    let w = runtime.clamp(Number(bubble.w), 0, 100);
    let h = runtime.clamp(Number(bubble.h), 0, 100);
    if (w <= 0 || h <= 0) {
      return null;
    }
    if (options.backgroundTarget) {
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      w = runtime.clamp(Math.max(w * 2.6, 18), 1, 92);
      h = runtime.clamp(Math.max(h * 2.2, 10), 1, 62);
      x = runtime.clamp(centerX - w / 2, 0, 100 - w);
      y = runtime.clamp(centerY - h / 2, 0, 100 - h);
    }
    const projectionRole = String(bubble.projection_role || "text_primary");
    const coverOnly = projectionRole === "cover_only";
    const originalText = runtime.cleanRenderableText(bubble.original_text || "");
    const translatedText = coverOnly ? "" : runtime.cleanRenderableText(bubble.translated_text || "") || originalText;
    if (!coverOnly && !translatedText) {
      return null;
    }
    const bgType = runtime.normalizeBgType(bubble.bg_type);
    const alignment = runtime.normalizeBubbleAlignment(bubble.alignment);
    const fontWeight = runtime.normalizeBubbleFontWeight(bubble.font_weight || bubble.fontWeight || bubble.visual && (bubble.visual.fontWeight || bubble.visual.font_weight), 600);
    const node = document.createElement("div");
    const renderColors = runtime.getBubbleRenderColors(bubble, bgType);
    node.className = `mt-bubble mt-bg-${bgType}`;
    node.classList.add(`mt-align-${alignment}`);
    if (coverOnly) node.classList.add("mt-cover-only");
    if (options.textOnly) node.classList.add("mt-text-layer");
    node.dataset.mangaTranslatorOverlay = "true";
    node.dataset.index = String(index);
    node.dataset.mode = coverOnly ? "cover" : "translated";
    node.dataset.projectionRole = projectionRole;
    node.dataset.original = originalText;
    node.dataset.translated = translatedText;
    node.dataset.sourceLineCount = String(Math.max(1, Math.round(Number(bubble.source_line_count) || 1)));
    node.dataset.sourceFontHeightPercent = String(Number(bubble.font_height_percent || bubble.fontHeightPercent || bubble.visual && (bubble.visual.fontHeightPercent || bubble.visual.font_height_percent) || 0));
    node.dataset.alignment = alignment;
    node.dataset.fontWeight = String(fontWeight);
    node.dataset.translationRole = String(bubble.translation_role || bubble.translationRole || "");
    node.dataset.rotationDeg = String(runtime.normalizeBubbleRotation(bubble.rotation_deg, bubble.region_type));
    if (Array.isArray(bubble.polygon)) {
      node.dataset.polygon = JSON.stringify(bubble.polygon);
    }
    node.dataset.wPercent = String(w);
    node.dataset.hPercent = String(h);
    node.dataset.xPercent = String(x);
    node.dataset.yPercent = String(y);
    node.dataset.backgroundTarget = options.backgroundTarget ? "true" : "";
    node.dataset.stitchOverflow = bubble.stitch_overflow === true ? "true" : "";
    node.dataset.blockId = String(bubble.block_id || bubble.id || `block-${index}`);
    node.dataset.canonicalId = String(bubble.canonical_id || "");
    node.dataset.seamRenderKey = String(options.seamRenderKey || "");
    if (bgType === "none") {
      const sourceBox = runtime.normalizeFillBox(bubble.cleaned_source_box) || {
        x,
        y,
        w,
        h
      };
      const patchStyle = runtime.getCleanedPatchStyle(sourceBox);
      node.style.setProperty("--mt-cleaned-size-x", patchStyle.sizeX);
      node.style.setProperty("--mt-cleaned-size-y", patchStyle.sizeY);
      node.style.setProperty("--mt-cleaned-position-x", patchStyle.positionX);
      node.style.setProperty("--mt-cleaned-position-y", patchStyle.positionY);
    }
    if (bubble.bg_color) {
      node.style.setProperty("--mt-adaptive-bg", String(bubble.bg_color));
    }
    node.style.setProperty("--mt-text-color", renderColors.textColor);
    node.style.setProperty("--mt-stroke-color", renderColors.strokeColor);
    node.style.setProperty("--mt-font-weight", String(fontWeight));
    node.dataset.regionType = String(bubble.region_type || "plain_text");
    const fillBox = bgType === "solid" ? runtime.buildSolidBackgroundBox({
      x,
      y,
      w,
      h
    }, bubble.fill_box, bubble.stitch_overflow === true) : null;
    if (fillBox) {
      node.style.setProperty("--mt-fill-left", (fillBox.x - x) / w * 100 + "%");
      node.style.setProperty("--mt-fill-top", (fillBox.y - y) / h * 100 + "%");
      node.style.setProperty("--mt-fill-width", fillBox.w / w * 100 + "%");
      node.style.setProperty("--mt-fill-height", fillBox.h / h * 100 + "%");
    }
    if (bgType === "solid" && Array.isArray(bubble.region_polygon)) {
      const clipTarget = fillBox || { x, y, w, h };
      const clip = runtime.buildRegionClipPath(bubble.region_polygon, clipTarget.x, clipTarget.y, clipTarget.w, clipTarget.h);
      if (clip) node.style.setProperty("--mt-region-clip", clip);
    }
    // Tilted text: use counter-rotated fill div so the polygon clip-path is in world space
    const absAngle = Math.abs(runtime.normalizeBubbleRotation(bubble.rotation_deg, bubble.region_type));
    if (bgType === "solid" && !node.style.getPropertyValue("--mt-region-clip") && absAngle > 2 && Array.isArray(bubble.polygon) && bubble.polygon.length >= 4) {
      const fillDiv = document.createElement("div");
      fillDiv.className = "mt-fill-tilted";
      fillDiv.dataset.mangaTranslatorOverlay = "true";
      const invAngle = -runtime.normalizeBubbleRotation(bubble.rotation_deg, bubble.region_type);
      fillDiv.style.transform = `rotate(${invAngle}deg)`;
      fillDiv.style.transformOrigin = "center center";
      fillDiv.style.background = String(bubble.bg_color || "rgba(255,255,255,0.96)");
      const clipRef = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
      const fillClip = runtime.buildRegionClipPath(bubble.polygon, clipRef.x, clipRef.y, clipRef.w, clipRef.h);
      if (fillClip) fillDiv.style.clipPath = fillClip;
      node.appendChild(fillDiv);
    }
    // Horizontal text: use ::before with polygon clip-path fallback (element is not rotated)
    if (bgType === "solid" && !node.style.getPropertyValue("--mt-region-clip") && absAngle <= 2 && Array.isArray(bubble.polygon) && bubble.polygon.length >= 4) {
      const clipTarget = fillBox || { x, y, w, h };
      const clip = runtime.buildRegionClipPath(bubble.polygon, clipTarget.x, clipTarget.y, clipTarget.w, clipTarget.h);
      if (clip) node.style.setProperty("--mt-region-clip", clip);
    }
    node.style.width = `${w}%`;
    node.style.height = `${h}%`;
    const rotation = runtime.normalizeBubbleRotation(bubble.rotation_deg, bubble.region_type);
    runtime.applyBubbleAnchorStyle(node, {
      alignment,
      x,
      y,
      w,
      h,
      rotation,
      unit: "%",
      allowVerticalOverflow: bubble.stitch_overflow === true
    });
    node.textContent = coverOnly ? "" : runtime.formatTranslationForOriginalLines(translatedText, Number(node.dataset.sourceLineCount));
    node.title = coverOnly ? "" : originalText || translatedText;
    if (!coverOnly) {
      runtime.applyBubbleTextLayout(node, translatedText);
    }
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const seamOverlay = node.closest(".mt-cross-page-overlay");
      const seamRenderKey = String(seamOverlay?.dataset?.seamRenderKey || node.dataset.seamRenderKey || "");
      if (seamRenderKey) {
        runtime.toggleSeamSourceMode(seamRenderKey);
      } else {
        runtime.toggleOverlaySourceMode(node);
      }
    });
    return node;
  }
  runtime.createBubbleNode = createBubbleNode;
  function resolveBubbleCoverBox(bubble) {
    const allowVerticalOverflow = bubble && bubble.stitch_overflow === true;
    return runtime.normalizeFillBox(bubble && bubble.fill_box, allowVerticalOverflow) || runtime.normalizeFillBox(bubble, allowVerticalOverflow);
  }
  runtime.resolveBubbleCoverBox = resolveBubbleCoverBox;
  function createBubbleRenderNodes(bubble, index, options = {}) {
    const role = String(bubble && bubble.projection_role || "text_primary");
    const coverBox = resolveBubbleCoverBox(bubble) || {};
    const coverBubble = {
      ...bubble,
      x: coverBox.x != null ? coverBox.x : bubble.x,
      y: coverBox.y != null ? coverBox.y : bubble.y,
      w: coverBox.w != null ? coverBox.w : bubble.w,
      h: coverBox.h != null ? coverBox.h : bubble.h,
      projection_role: "cover_only",
      original_text: "",
      translated_text: "",
      fill_box: null,
      region_polygon: null
    };
    const coverNode = createBubbleNode(coverBubble, index, options);
    const textNode = role === "cover_only" ? null : createBubbleNode(bubble, index, {
      ...options,
      textOnly: true
    });
    return { coverNode, textNode };
  }
  runtime.createBubbleRenderNodes = createBubbleRenderNodes;
  function applyBubbleAnchorStyle(node, {
    alignment = "center",
    x = 0,
    y = 0,
    w = 0,
    h = 0,
    centerX = null,
    centerY = null,
    rotation = 0,
    unit = "%",
    allowVerticalOverflow = false
  } = {}) {
    const normalized = runtime.normalizeBubbleAlignment(alignment);
    const top = allowVerticalOverflow ? Number(y) || 0 : runtime.clamp(Number(y) || 0, 0, unit === "%" ? 100 : Number.MAX_SAFE_INTEGER);
    const left = Number(x) || 0;
    const width = Math.max(0, Number(w) || 0);
    const height = Math.max(0, Number(h) || 0);
    const angle = Number(rotation) || 0;
    const shouldUseCenterRotationAnchor = Math.abs(angle) >= runtime.BUBBLE_ROTATION_NEAR_HORIZONTAL;
    if (shouldUseCenterRotationAnchor) {
      const explicitCenterX = centerX !== null && centerX !== undefined && Number.isFinite(Number(centerX)) ? Number(centerX) : left + width / 2;
      const explicitCenterY = centerY !== null && centerY !== undefined && Number.isFinite(Number(centerY)) ? Number(centerY) : top + height / 2;
      const anchorCenterX = unit === "%" ? runtime.clamp(explicitCenterX, 0, 100) : explicitCenterX;
      const anchorCenterY = allowVerticalOverflow ? explicitCenterY : unit === "%" ? runtime.clamp(explicitCenterY, 0, 100) : explicitCenterY;
      node.style.left = `${anchorCenterX}${unit}`;
      node.style.top = `${anchorCenterY}${unit}`;
      node.style.transformOrigin = "center center";
      node.style.setProperty("--mt-base-transform", `translate(-50%, -50%) rotate(${angle.toFixed(2)}deg)`);
      return;
    }
    if (normalized === "left") {
      node.style.left = `${left}${unit}`;
      node.style.top = `${top}${unit}`;
      node.style.transformOrigin = "left top";
      node.style.setProperty("--mt-base-transform", `rotate(${angle.toFixed(2)}deg)`);
      return;
    }
    if (normalized === "right") {
      const anchorX = unit === "%" ? runtime.clamp(left + width, 0, 100) : left + width;
      node.style.left = `${anchorX}${unit}`;
      node.style.top = `${top}${unit}`;
      node.style.transformOrigin = "right top";
      node.style.setProperty("--mt-base-transform", `translate(-100%, 0) rotate(${angle.toFixed(2)}deg)`);
      return;
    }
    const fallbackCenterX = unit === "%" ? runtime.clamp(left + width / 2, 0, 100) : left + width / 2;
    const fallbackCenterY = allowVerticalOverflow ? top + height / 2 : unit === "%" ? runtime.clamp(top + height / 2, 0, 100) : top + height / 2;
    node.style.left = `${fallbackCenterX}${unit}`;
    node.style.top = `${fallbackCenterY}${unit}`;
    node.style.transformOrigin = "center center";
    node.style.setProperty("--mt-base-transform", `translate(-50%, -50%) rotate(${angle.toFixed(2)}deg)`);
  }
  runtime.applyBubbleAnchorStyle = applyBubbleAnchorStyle;
  function buildRegionClipPath(points, x, y, width, height) {
    if (!Array.isArray(points) || points.length < 3 || width <= 0 || height <= 0) {
      return "";
    }
    const values = points.map(point => {
      const localX = (Number(point && point.x) - x) / width * 100;
      const localY = (Number(point && point.y) - y) / height * 100;
      return Number.isFinite(localX) && Number.isFinite(localY) ? `${localX.toFixed(2)}% ${localY.toFixed(2)}%` : "";
    });
    return values.every(Boolean) ? `polygon(${values.join(", ")})` : "";
  }
  runtime.buildRegionClipPath = buildRegionClipPath;
  function formatTranslationForOriginalLines(text, requestedLines) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    const lineCount = Math.max(1, Math.min(8, Math.round(Number(requestedLines) || 1)));
    if (!raw || lineCount <= 1 || raw.includes("\n")) {
      return raw;
    }
    const isCjk = /[\u3400-\u9fff]/.test(raw);
    const units = isCjk ? Array.from(raw.replace(/\s+/g, "")) : raw.split(/\s+/).filter(Boolean);
    if (units.length <= lineCount) {
      return raw;
    }

    // Choose all line breaks together. Greedy wrapping makes the last line
    // very short and is the source of isolated characters in speech bubbles.
    const targetLength = units.length / lineCount;
    const punctuation = /[，。！？、；：,.!?;:]/;
    const states = Array.from({
      length: lineCount + 1
    }, () => new Map());
    states[0].set(0, {
      score: 0,
      breaks: []
    });
    for (let line = 1; line <= lineCount; line += 1) {
      const current = states[line];
      for (let end = line; end <= units.length - (lineCount - line); end += 1) {
        let best = null;
        for (let start = line - 1; start < end; start += 1) {
          const previous = states[line - 1].get(start);
          if (!previous) continue;
          const length = end - start;
          let score = previous.score + (length - targetLength) ** 2;
          if (length === 1) score += 120;
          if (line === lineCount && length <= 2) score += 45;
          if (isCjk && start > 0 && !punctuation.test(units[start - 1])) score += 4;
          const candidate = {
            score,
            breaks: [...previous.breaks, end]
          };
          if (!best || candidate.score < best.score) best = candidate;
        }
        if (best) current.set(end, best);
      }
    }
    const result = states[lineCount].get(units.length);
    if (!result) return raw;
    const rows = [];
    let start = 0;
    result.breaks.forEach(end => {
      rows.push(units.slice(start, end).join(isCjk ? "" : " "));
      start = end;
    });
    return rows.filter(Boolean).join("\n");
  }
  runtime.formatTranslationForOriginalLines = formatTranslationForOriginalLines;
  function toggleOverlaySourceMode(node) {
    const root = node.closest(".mt-overlay-root");
    if (!root) {
      return;
    }
    root.classList.toggle("mt-show-source");
  }
  runtime.toggleOverlaySourceMode = toggleOverlaySourceMode;
  function applyBubbleTextLayout(node, text) {
    const vertical = runtime.shouldUseVerticalJapaneseLayout(node, text);
    node.classList.toggle("mt-jp-vertical", vertical);
  }
  runtime.applyBubbleTextLayout = applyBubbleTextLayout;
  function shouldUseVerticalJapaneseLayout(node, text) {
    const originalText = String(node && node.dataset && node.dataset.original || "").trim();
    if (originalText && /[\uac00-\ud7afA-Za-z]/.test(originalText) && !runtime.looksLikeJapaneseText(originalText)) {
      return false;
    }
    const rotation = Math.abs(runtime.normalizeBubbleRotation(node && node.dataset && node.dataset.rotationDeg, node && node.dataset && node.dataset.regionType));
    if (rotation >= 45 && rotation <= 135) {
      return runtime.looksLikeCjkText(text);
    }
    const backgroundTarget = node.dataset.backgroundTarget === "true";
    if (backgroundTarget && runtime.looksLikeCjkText(text)) {
      const hPercent = Number(node.dataset.hPercent || "0");
      const wPercent = Number(node.dataset.wPercent || "1");
      return hPercent / Math.max(wPercent, 0.1) >= 0.5;
    }
    if (!runtime.looksLikeJapaneseText(text)) {
      return false;
    }
    const hPercent = Number(node.dataset.hPercent || "0");
    const wPercent = Number(node.dataset.wPercent || "1");
    const ratio = hPercent / Math.max(wPercent, 0.1);

    // Prefer vertical layout on tall/narrow bubbles to keep reading natural.
    return ratio >= 0.82;
  }
  runtime.shouldUseVerticalJapaneseLayout = shouldUseVerticalJapaneseLayout;
  function looksLikeCjkText(text) {
    return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(text || ""));
  }
  runtime.looksLikeCjkText = looksLikeCjkText;
  function looksLikeJapaneseText(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return false;
    }
    if (/[\u3040-\u30ff\u31f0-\u31ff\u30fc\uff66-\uff9f]/.test(raw)) {
      return true;
    }
    if (/[\u3001\u3002\u30fb\u300c\u300d\u300e\u300f\u301c]/.test(raw) && /[\u4e00-\u9fff]/.test(raw)) {
      return true;
    }
    return false;
  }
  runtime.looksLikeJapaneseText = looksLikeJapaneseText;
  function syncAllOverlays() {
    if (runtime.state.invalidated) {
      return;
    }
    if (runtime.state.overlaysById.size > 0) {
      for (const overlayState of runtime.state.overlaysById.values()) {
        runtime.syncOverlayPosition(overlayState);
      }
      runtime.syncKakaoVisualDuplicateBubbles();
      runtime.ensureOverlayFrameSync();
    }
    runtime.recoverRenderedTargets();
  }
  runtime.syncAllOverlays = syncAllOverlays;
}
