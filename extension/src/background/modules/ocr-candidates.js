export function installOcrCandidates(runtime) {
  function keepOrTraceFinalCandidate(item, imageSize, tuning, debug, engine) {
    const reason = runtime.getFinalCandidateDropReason(item, imageSize, tuning, engine);
    if (!reason) {
      return true;
    }
    runtime.traceFilterReason(debug, {
      stage: "final",
      engine,
      id: item && item.id,
      reason,
      item: {
        text: item && item.original_text ? item.original_text : "",
        confidence: Number(item && item.confidence) || 0,
        rawBox: item && item.rawBox ? item.rawBox : null,
        percent: item ? {
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h
        } : null
      }
    });
    return false;
  }
  runtime.keepOrTraceFinalCandidate = keepOrTraceFinalCandidate;
  function getOcrWordDropReason(item, imageSize, tuning = runtime.getDefaultOcrTuning()) {
    const box = runtime.getBaiduItemBox(item);
    const text = String(item && (item.words || item.text) ? item.words || item.text : "").replace(/\s+/g, "");
    if (!box || !text) {
      return "empty-text-or-box";
    }
    if (runtime.isSymbolOnlyText(text)) {
      return "symbol-only";
    }
    if (runtime.isLikelyMojibakeShortOcrText(text)) {
      return "mojibake-short-fragment";
    }
    const meaningfulText = runtime.isMeaningfulOcrText(text);
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const area = box.width * box.height;
    const areaRatio = area / Math.max(1, imageWidth * imageHeight);
    const confidence = Number(item.confidence || item.score || 0);
    const aspectRatio = Math.max(box.width / Math.max(1, box.height), box.height / Math.max(1, box.width));
    const scriptChars = runtime.countScriptChars(text);
    const reliableShortSpeechBubble = runtime.isReliableShortSpeechBubbleItem(item);
    if (!reliableShortSpeechBubble && confidence > 0 && confidence < Number(tuning.confidenceThreshold || 0)) {
      const stronglyUncertainMeaningfulText = runtime.isReliableMeaningfulShortOcrText(text) && confidence < 0.45;
      if (!meaningfulText || stronglyUncertainMeaningfulText || areaRatio < 0.0012) {
        return "low-confidence";
      }
    }
    if (area < Number(tuning.minBoxArea || 0)) {
      return "too-small-area";
    }
    if (areaRatio > Number(tuning.maxBoxArea || 1)) {
      return "too-large-area";
    }
    if (box.width < Number(tuning.minBoxWidth || 0) || box.height < Number(tuning.minBoxHeight || 0)) {
      return "too-small-dimension";
    }
    const maxAspectRatio = Number(tuning.maxAspectRatio || 100);
    if (aspectRatio > maxAspectRatio && !runtime.isReadableHorizontalOcrLine(item, box, text, maxAspectRatio)) {
      return "bad-aspect-ratio";
    }
    if (!reliableShortSpeechBubble && !runtime.isReliableMeaningfulShortOcrText(text) && scriptChars <= 1 && areaRatio < 0.003 && confidence < 0.98) {
      return "tiny-single-character";
    }
    if (!reliableShortSpeechBubble && !meaningfulText && runtime.shouldDropLowConfidenceLocalPaddleText(text, confidence)) {
      return "weak-script-confidence";
    }
    return "";
  }
  runtime.getOcrWordDropReason = getOcrWordDropReason;
  function isReadableHorizontalOcrLine(item, box, text, maxAspectRatio) {
    if (!box || !(box.width > box.height)) {
      return false;
    }
    const confidence = Number(item && (item.confidence || item.score) || 0);
    const readableChars = runtime.normalizeTextForLocalPaddle(text).length;
    const aspectRatio = box.width / Math.max(1, box.height);
    const configuredLimit = Math.max(1, Number(maxAspectRatio) || 1);

    // 长横排句子的宽高比天然会超过普通气泡阈值；使用字符密度和置信度确认它是完整文本行，
    // 同时继续拒绝字符很少的细长装饰框或检测噪声。
    return confidence >= 0.72 && readableChars >= 12 && readableChars / aspectRatio >= 0.8 && aspectRatio <= configuredLimit * 1.75;
  }
  runtime.isReadableHorizontalOcrLine = isReadableHorizontalOcrLine;
  function getFinalCandidateDropReason(item, imageSize, tuning, engine) {
    if (!item || !item.original_text) {
      return "empty-final-text";
    }
    const box = runtime.getNormalizedCandidatePixelBox(item, imageSize);
    if (!box) {
      return "invalid-final-box";
    }
    const confidence = Number(item.confidence || 0);
    const reliableShortSpeechBubble = runtime.isReliableShortSpeechBubbleItem(item);
    if (!reliableShortSpeechBubble && confidence > 0 && confidence < Number(tuning.confidenceThreshold || 0)) {
      const text = String(item.original_text || "");
      const scriptChars = runtime.countScriptChars(text);
      const meaningfulText = runtime.isMeaningfulOcrText(text);
      const areaRatio = box.width * box.height / Math.max(1, (Number(imageSize && imageSize.width) || 1) * (Number(imageSize && imageSize.height) || 1));
      const stronglyUncertainMeaningfulText = runtime.isReliableMeaningfulShortOcrText(text) && confidence < 0.45;
      if (!meaningfulText || stronglyUncertainMeaningfulText || areaRatio < 0.0012) {
        return "low-confidence-final";
      }
    }
    if (engine === "local_paddle" && runtime.shouldDropLocalPaddleCandidateBubble(item, imageSize)) {
      return "local-paddle-candidate-noise";
    }
    return "";
  }
  runtime.getFinalCandidateDropReason = getFinalCandidateDropReason;
  function traceFilterReason(debug, entry) {
    if (!debug || !Array.isArray(debug.filterReasons)) {
      return;
    }
    const item = entry && entry.item;
    const text = String(entry && entry.text || item && (item.text || item.words || item.original_text) || "").trim();
    const dropReason = String(entry && (entry.dropReason || entry.reason) || "filtered");
    debug.filterReasons.push({
      ...entry,
      text,
      dropReason,
      reason: String(entry && entry.reason || dropReason)
    });
  }
  runtime.traceFilterReason = traceFilterReason;
  function toDebugOcrItem(item, index, imageSize, stage) {
    const box = runtime.getDebugItemBox(item);
    const text = String(item && (item.words || item.text) ? item.words || item.text : "").trim();
    return {
      id: `${stage || "ocr"}-${index}`,
      stage,
      text,
      confidence: Number(item && (item.confidence ?? item.score)) || 0,
      rawBox: box,
      percent: runtime.boxToPercent(box, imageSize),
      engine: item && item.lang ? item.lang : "",
      source: item && item.variant ? item.variant : "",
      raw: item || null
    };
  }
  runtime.toDebugOcrItem = toDebugOcrItem;
  function getDebugItemBox(item) {
    if (!item) {
      return null;
    }
    if (item.rawBox) {
      return runtime.normalizeDebugBox(item.rawBox);
    }
    if (item.location) {
      return runtime.normalizeDebugBox(item.location);
    }
    if (item.box) {
      return runtime.normalizeDebugBox(item.box);
    }
    return null;
  }
  runtime.getDebugItemBox = getDebugItemBox;
  function normalizeDebugBox(box) {
    const left = Number(box && (box.left ?? box.x));
    const top = Number(box && (box.top ?? box.y));
    const width = Number(box && (box.width ?? box.w));
    const height = Number(box && (box.height ?? box.h));
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      return null;
    }
    return {
      left,
      top,
      width,
      height
    };
  }
  runtime.normalizeDebugBox = normalizeDebugBox;
  function boxToPercent(box, imageSize) {
    if (!box) {
      return null;
    }
    const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
    return {
      x: box.left / width * 100,
      y: box.top / height * 100,
      w: box.width / width * 100,
      h: box.height / height * 100
    };
  }
  runtime.boxToPercent = boxToPercent;
  function buildUnifiedOcrDebugPayload(debug, candidates, extras = {}) {
    const finalBubbles = (candidates || []).map(item => ({
      id: item.id,
      blockId: item.block_id || item.id,
      text: item.original_text,
      confidence: item.confidence || 0,
      rawBox: item.rawBox || null,
      box: item.rawBox || null,
      percent: {
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h
      },
      translatedText: item.translated_text || "",
      isDuplicate: false
    }));
    if (debug) {
      debug.finalBubbles = finalBubbles;
    }
    return {
      ...(debug || {}),
      ...extras,
      items: finalBubbles,
      finalBubbles
    };
  }
  runtime.buildUnifiedOcrDebugPayload = buildUnifiedOcrDebugPayload;
  function buildLocalOcrDebugId(targetKey, imageMeta = null) {
    const mode = runtime.normalizeOcrRequestMode(imageMeta && imageMeta.ocrMode);
    const admission = String(imageMeta && imageMeta.stitchAdmission || "").trim();
    const reason = String(imageMeta && imageMeta.fallbackReason || imageMeta && imageMeta.stitchRejectionReason || "").trim();
    return [String(targetKey || `target-${Date.now()}`), `mode-${mode}`, admission, reason ? `reason-${runtime.hashString(reason).slice(0, 8)}` : ""].filter(Boolean).join("-").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80);
  }
  runtime.buildLocalOcrDebugId = buildLocalOcrDebugId;
  function normalizeLocalPaddleOcrBox(item, imageSize) {
    const rawBox = item && (item.box || item.location || item.bbox || item.boundingBox);
    let left;
    let top;
    let right;
    let bottom;
    if (Array.isArray(rawBox) && rawBox.length >= 4 && rawBox.every(value => typeof value === "number")) {
      left = rawBox[0];
      top = rawBox[1];
      right = rawBox[2];
      bottom = rawBox[3];
      if (right <= left || bottom <= top) {
        right = left + Math.max(1, rawBox[2]);
        bottom = top + Math.max(1, rawBox[3]);
      }
    } else if (rawBox && typeof rawBox === "object") {
      left = runtime.toNumber(rawBox.left !== undefined ? rawBox.left : rawBox.x, NaN);
      top = runtime.toNumber(rawBox.top !== undefined ? rawBox.top : rawBox.y, NaN);
      const width = runtime.toNumber(rawBox.width !== undefined ? rawBox.width : rawBox.w, NaN);
      const height = runtime.toNumber(rawBox.height !== undefined ? rawBox.height : rawBox.h, NaN);
      right = rawBox.right !== undefined ? runtime.toNumber(rawBox.right, NaN) : left + width;
      bottom = rawBox.bottom !== undefined ? runtime.toNumber(rawBox.bottom, NaN) : top + height;
    } else if (Array.isArray(item && item.points)) {
      const points = item.points.map(point => {
        if (Array.isArray(point) && point.length >= 2) {
          return {
            x: Number(point[0]),
            y: Number(point[1])
          };
        }
        if (point && typeof point === "object") {
          return {
            x: Number(point.x),
            y: Number(point.y)
          };
        }
        return null;
      }).filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length > 0) {
        left = Math.min(...points.map(point => point.x));
        top = Math.min(...points.map(point => point.y));
        right = Math.max(...points.map(point => point.x));
        bottom = Math.max(...points.map(point => point.y));
      }
    }
    if (![left, top, right, bottom].every(Number.isFinite)) {
      return null;
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const safeLeft = runtime.clamp(left, 0, imageWidth);
    const safeTop = runtime.clamp(top, 0, imageHeight);
    const safeRight = runtime.clamp(right, safeLeft + 1, imageWidth);
    const safeBottom = runtime.clamp(bottom, safeTop + 1, imageHeight);
    return {
      left: safeLeft,
      top: safeTop,
      width: safeRight - safeLeft,
      height: safeBottom - safeTop
    };
  }
  runtime.normalizeLocalPaddleOcrBox = normalizeLocalPaddleOcrBox;
}
