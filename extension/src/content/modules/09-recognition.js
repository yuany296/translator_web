export function installContent09(runtime) {
  function describeKakaoStitchTarget(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return null;
    }
    const rect = target.getBoundingClientRect();
    const width = Number(rect.width || 0);
    const height = Number(rect.height || 0);
    if (!(width > 0 && height > 0)) {
      return null;
    }
    return {
      left: Number(rect.left || 0),
      top: Number(rect.top || 0),
      right: Number(rect.right || Number(rect.left || 0) + width),
      bottom: Number(rect.bottom || Number(rect.top || 0) + height),
      width,
      height,
      sourceKey: runtime.getQuickSourceToken(target),
      currentSrc: target.currentSrc || "",
      src: target.getAttribute && target.getAttribute("src") || ""
    };
  }
  runtime.describeKakaoStitchTarget = describeKakaoStitchTarget;
  function buildKakaoStitchCandidateEntries(targets) {
    return runtime.KP.buildKakaoStitchCandidateEntries(targets, runtime.describeKakaoStitchTarget);
  }
  runtime.buildKakaoStitchCandidateEntries = buildKakaoStitchCandidateEntries;
  function findKakaoStitchNeighborTarget(entries, ownerIndex, direction) {
    return runtime.KP.findKakaoStitchNeighborTarget(entries, ownerIndex, direction);
  }
  runtime.findKakaoStitchNeighborTarget = findKakaoStitchNeighborTarget;
  function findKakaoShortPageAttachmentOwnerTarget(entries, targetIndex, direction) {
    return runtime.KP.findKakaoShortPageAttachmentOwnerTarget(entries, targetIndex, direction);
  }
  runtime.findKakaoShortPageAttachmentOwnerTarget = findKakaoShortPageAttachmentOwnerTarget;
  function isKakaoStitchCandidatePastNeighborWindow(owner, candidate, direction) {
    return runtime.KP.isKakaoStitchCandidatePastNeighborWindow(owner, candidate, direction);
  }
  runtime.isKakaoStitchCandidatePastNeighborWindow = isKakaoStitchCandidatePastNeighborWindow;
  function isVerifiedKakaoStitchNeighbor(owner, candidate, direction) {
    return runtime.KP.isVerifiedKakaoStitchNeighbor(owner, candidate, direction);
  }
  runtime.isVerifiedKakaoStitchNeighbor = isVerifiedKakaoStitchNeighbor;
  function buildKakaoStitchWindowPlan({
    owner,
    previous,
    next,
    canonicalWidth,
    ownerHeight,
    previousHeight,
    nextHeight
  }) {
    return runtime.KP.buildKakaoStitchWindowPlan({
      owner,
      previous,
      next,
      canonicalWidth,
      ownerHeight,
      previousHeight,
      nextHeight
    });
  }
  runtime.buildKakaoStitchWindowPlan = buildKakaoStitchWindowPlan;
  function isAttachableKakaoShortPage(candidate, owner, candidateHeight, ownerHeight) {
    return runtime.KP.isAttachableKakaoShortPage(candidate, owner, candidateHeight, ownerHeight);
  }
  runtime.isAttachableKakaoShortPage = isAttachableKakaoShortPage;
  async function requestTranslationForPayload(payload, requestKey) {
    const pageId = `single:${requestKey}`;
    const ocr = await runtime.sendRuntimeMessage({
      type: "OCR_DATA_URL", dataUrl: payload.dataUrl, sourceType: "page",
      pageIds: [pageId], targetKey: requestKey, imageMeta: runtime.buildPayloadImageMeta(payload)
    });
    if (!ocr?.ok) return ocr;
    const observations = ocr.result?.observations || [];
    const translation = await runtime.sendRuntimeMessage({
      type: "TRANSLATE_TEXT_BLOCKS",
      items: observations.map((item) => ({ id: item.id, revision: 1, original_text: item.originalText }))
    });
    if (!translation?.ok) return translation;
    const translated = new Map(translation.translations.map((item) => [item.id, item.translated_text]));
    return { ok: true, result: { bubbles: observations.map((item) => ({
      ...(item.visual?.box || {}), original_text: item.originalText,
      translated_text: translated.get(item.id) || item.originalText, visual: item.visual
    })), cleanedImage: ocr.result.cleanedImage || null, debug: ocr.result.debug || null } };
  }
  runtime.requestTranslationForPayload = requestTranslationForPayload;
  function getBubbleLineCount(bubble) {
    return runtime.KP.getBubbleLineCount(bubble);
  }
  runtime.getBubbleLineCount = getBubbleLineCount;
  function shouldFallbackFromKakaoStitch(payload, rawResult, mappedResult) {
    return runtime.KP.shouldFallbackFromKakaoStitch(payload, rawResult, mappedResult);
  }
  runtime.shouldFallbackFromKakaoStitch = shouldFallbackFromKakaoStitch;
  async function extractAdjacentKakaoPayload(target) {
    try {
      const payload = await runtime.extractImagePayload(target);
      return payload && runtime.isDataUrl(payload.dataUrl) ? payload : null;
    } catch {
      return null;
    }
  }
  runtime.extractAdjacentKakaoPayload = extractAdjacentKakaoPayload;
  function mapKakaoStitchedResultForPipeline(result, payload, target, targetKey) {
    if (!payload || !payload.stitch || !result || !Array.isArray(result.bubbles)) {
      return result;
    }
    const targetRect = target && typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
    const mappedResult = runtime.KP.mapKakaoStitchedResult(result, payload.stitch, targetRect, window.scrollX || 0, window.scrollY || 0);
    const mapped = Array.isArray(mappedResult && mappedResult.bubbles) ? mappedResult.bubbles : [];
    const withGlobalBoxes = mapped.map(bubble => ({
      ...bubble,
      global_box: runtime.computeKakaoGlobalBoxFromTarget(bubble, target)
    }));
    runtime.tracePipeline("mapped", target, {
      rawBubbleCount: result.bubbles.length,
      mappedBubbleCount: mapped.length,
      targetKey: String(targetKey).slice(0, 80)
    });
    return {
      ...mappedResult,
      bubbles: withGlobalBoxes
    };
  }
  runtime.mapKakaoStitchedResultForPipeline = mapKakaoStitchedResultForPipeline;
  function mapKakaoStitchedResult(result, payload, target, targetKey) {
    const mappedResult = runtime.mapKakaoStitchedResultForPipeline(result, payload, target, targetKey);
    if (!mappedResult || !Array.isArray(mappedResult.bubbles)) {
      return mappedResult;
    }
    const targetRect = target && typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
    return {
      ...mappedResult,
      bubbles: runtime.dedupeKakaoGlobalBubbles(mappedResult.bubbles, target, targetRect, targetKey)
    };
  }
  runtime.mapKakaoStitchedResult = mapKakaoStitchedResult;
  function mapKakaoStitchedFillBox(box, ownerY, ownerH, compositeH) {
    return runtime.KP.mapKakaoStitchedFillBox(box, ownerY, ownerH, compositeH);
  }
  runtime.mapKakaoStitchedFillBox = mapKakaoStitchedFillBox;
  function mapKakaoStitchedPolygon(points, ownerY, ownerH, compositeH) {
    return runtime.KP.mapKakaoStitchedPolygon(points, ownerY, ownerH, compositeH);
  }
  runtime.mapKakaoStitchedPolygon = mapKakaoStitchedPolygon;
  function computeKakaoGlobalBoxFromTarget(bubble, target) {
    if (!target || typeof target.getBoundingClientRect !== "function") return null;
    const rect = target.getBoundingClientRect();
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const bx = Number(bubble.x);
    const by = Number(bubble.y);
    const bw = Number(bubble.w);
    const bh = Number(bubble.h);
    if (![bx, by, bw, bh].every(Number.isFinite)) return null;
    return {
      left: rect.left + scrollX + bx / 100 * rect.width,
      top: rect.top + scrollY + by / 100 * rect.height,
      width: bw / 100 * rect.width,
      height: bh / 100 * rect.height
    };
  }
  runtime.computeKakaoGlobalBoxFromTarget = computeKakaoGlobalBoxFromTarget;
  function normalizeKakaoStitchSegments(stitch, compositeWidth, compositeHeight, ownerDraw) {
    return runtime.KP.normalizeKakaoStitchSegments(stitch, compositeWidth, compositeHeight, ownerDraw);
  }
  runtime.normalizeKakaoStitchSegments = normalizeKakaoStitchSegments;
  function getKakaoStitchOwnerOverlap(bubbleRect, segments) {
    return runtime.KP.getKakaoStitchOwnerOverlap(bubbleRect, segments);
  }
  runtime.getKakaoStitchOwnerOverlap = getKakaoStitchOwnerOverlap;
  function normalizeKakaoStitchDebugCoordinates(debug, stitch) {
    return runtime.KP.normalizeKakaoStitchDebugCoordinates(debug, stitch);
  }
  runtime.normalizeKakaoStitchDebugCoordinates = normalizeKakaoStitchDebugCoordinates;
  function normalizeDebugCoordinateItems(items, debug, context = {}) {
    return runtime.KP.normalizeDebugCoordinateItems(items, debug, context);
  }
  runtime.normalizeDebugCoordinateItems = normalizeDebugCoordinateItems;
  function getDebugItemPercentWithImageSize(item, imageWidth, imageHeight) {
    return runtime.KP.getDebugItemPercent(item, imageWidth, imageHeight);
  }
  runtime.getDebugItemPercentWithImageSize = getDebugItemPercentWithImageSize;
  async function dedupeKakaoResultByPageCoordinates(result, target, targetKey, scopedTargetKey = targetKey) {
    if (!runtime.IS_KAKAOPAGE_READER || !result || !Array.isArray(result.bubbles) || !targetKey) {
      return result;
    }
    return runtime.KP.dedupeKakaoResultByPageCoordinates({
      result,
      target,
      targetKey,
      scopedTargetKey,
      store: runtime.state.kakaoStore,
      adapters: {
        translateTrimmedBubble: runtime.translateTrimmedKakaoBubble,
        onSupersededEntry: runtime.removeSupersededKakaoGlobalEntry
      },
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0
    });
  }
  runtime.dedupeKakaoResultByPageCoordinates = dedupeKakaoResultByPageCoordinates;
  function trimKakaoBubbleBoundary(bubble, overlap) {
    return runtime.KP.trimKakaoBubbleBoundary(bubble, overlap);
  }
  runtime.trimKakaoBubbleBoundary = trimKakaoBubbleBoundary;
  function sliceTextByNormalizedBoundary(text, overlapLength, keepSuffix) {
    return runtime.KP.sliceTextByNormalizedBoundary(text, overlapLength, keepSuffix);
  }
  runtime.sliceTextByNormalizedBoundary = sliceTextByNormalizedBoundary;
  async function translateTrimmedKakaoBubble(bubble, targetKey) {
    try {
      const response = await runtime.sendRuntimeMessage({
        type: "TRANSLATE_TEXT_BLOCKS",
        sourceImageId: `${targetKey}|boundary-trim`,
        items: [{
          id: String(bubble.block_id || bubble.id || "boundary-trimmed"),
          original_text: bubble.original_text,
          x: bubble.x,
          y: bubble.y,
          w: bubble.w,
          h: bubble.h
        }]
      });
      const translated = response && response.ok && Array.isArray(response.translations) ? response.translations[0] : null;
      return {
        ...bubble,
        translated_text: runtime.cleanRenderableText(translated && translated.translated_text || "") || bubble.original_text
      };
    } catch {
      return {
        ...bubble,
        translated_text: bubble.original_text
      };
    }
  }
  runtime.translateTrimmedKakaoBubble = translateTrimmedKakaoBubble;
  function filterOcrDebugFinalBubbles(debug, bubbles) {
    return runtime.KP.filterOcrDebugFinalBubbles(debug, bubbles);
  }
  runtime.filterOcrDebugFinalBubbles = filterOcrDebugFinalBubbles;
  function syncOcrDebugFinalBubbles(debug, bubbles) {
    return runtime.KP.syncOcrDebugFinalBubbles(debug, bubbles);
  }
  runtime.syncOcrDebugFinalBubbles = syncOcrDebugFinalBubbles;
  function dedupeKakaoGlobalBubbles(bubbles, target, targetRect, targetKey) {
    return runtime.KP.runDedupeGlobalBubbles(bubbles, target, targetRect, targetKey, runtime.state.kakaoStore, {
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
      onSupersededEntry: runtime.removeSupersededKakaoGlobalEntry
    });
  }
  runtime.dedupeKakaoGlobalBubbles = dedupeKakaoGlobalBubbles;
  function isKakaoGlobalDuplicateCandidate(candidate, entry) {
    return runtime.KP.isKakaoGlobalDuplicateCandidate(candidate, entry);
  }
  runtime.isKakaoGlobalDuplicateCandidate = isKakaoGlobalDuplicateCandidate;
  function isKakaoBoundaryOwnPair(candidate, entry) {
    return runtime.KP.isKakaoBoundaryOwnPair(candidate, entry);
  }
  runtime.isKakaoBoundaryOwnPair = isKakaoBoundaryOwnPair;
  function isKakaoBoundaryNeighborBubble(bubble) {
    return runtime.KP.isKakaoBoundaryNeighborBubble(bubble);
  }
  runtime.isKakaoBoundaryNeighborBubble = isKakaoBoundaryNeighborBubble;
  function areKakaoGlobalBoxesRelated(leftBox, rightBox) {
    return runtime.KP.areKakaoGlobalBoxesRelated(leftBox, rightBox);
  }
  runtime.areKakaoGlobalBoxesRelated = areKakaoGlobalBoxesRelated;
  function areOcrTextsDuplicateOrContained(first, second) {
    return runtime.KP.areOcrTextsDuplicateOrContained(first, second);
  }
  runtime.areOcrTextsDuplicateOrContained = areOcrTextsDuplicateOrContained;
  function hasSubstantialOcrTokenOverlap(first, second) {
    return runtime.KP.hasSubstantialOcrTokenOverlap(first, second);
  }
  runtime.hasSubstantialOcrTokenOverlap = hasSubstantialOcrTokenOverlap;
  function getLongestCommonSubstringLength(firstChars, secondChars, stopAt) {
    return runtime.KP.getLongestCommonSubstringLength(firstChars, secondChars, stopAt);
  }
  runtime.getLongestCommonSubstringLength = getLongestCommonSubstringLength;
  function getSubstantialOcrBoundaryOverlap(first, second) {
    return runtime.KP.getSubstantialOcrBoundaryOverlap(first, second);
  }
  runtime.getSubstantialOcrBoundaryOverlap = getSubstantialOcrBoundaryOverlap;
  function removeSupersededKakaoGlobalEntry(entry) {
    if (!entry) {
      return;
    }
    const ownerEntries = runtime.state.kakaoStore.getEntriesForKey(entry.targetKey);
    runtime.state.kakaoStore.setEntriesForKey(entry.targetKey, ownerEntries.filter(candidate => candidate !== entry && !(candidate.bubble && entry.bubble && candidate.bubble === entry.bubble)));
    if (Array.isArray(entry.bubbleContainer)) {
      const index = entry.bubbleContainer.indexOf(entry.bubble);
      if (index >= 0) {
        entry.bubbleContainer.splice(index, 1);
      }
    }
    if (Array.isArray(entry.entryContainer)) {
      const index = entry.entryContainer.indexOf(entry);
      if (index >= 0) {
        entry.entryContainer.splice(index, 1);
      }
    }
    const cacheKey = entry.scopedTargetKey || entry.targetKey;
    const cached = runtime.state.localResultCache.get(cacheKey);
    if (!cached || !Array.isArray(cached.bubbles)) {
      return;
    }
    const remaining = cached.bubbles.filter(bubble => runtime.normalizeOcrSimilarityText(bubble.original_text) !== entry.text);
    if (remaining.length === cached.bubbles.length) {
      return;
    }
    const nextResult = {
      ...cached,
      bubbles: remaining,
      debug: runtime.filterOcrDebugFinalBubbles(cached.debug, remaining)
    };
    runtime.state.localResultCache.set(cacheKey, nextResult);
    if (!entry.target || entry.target.isConnected === false) {
      return;
    }
    if (runtime.shouldUseEmbeddedRender(entry.target)) {
      runtime.restoreEmbeddedForTarget(entry.target);
      entry.target.dataset.mtLastTranslatedKey = "";
      runtime.queueTranslate(entry.target, {
        manual: true,
        force: true,
        reason: "kakao-cross-page-dedupe"
      });
      return;
    }
    runtime.renderOverlay(entry.target, entry.targetKey, nextResult);
  }
  runtime.removeSupersededKakaoGlobalEntry = removeSupersededKakaoGlobalEntry;
  function pageBoxIntersectionRatio(left, right) {
    return runtime.KP.pageBoxIntersectionRatio(left, right);
  }
  runtime.pageBoxIntersectionRatio = pageBoxIntersectionRatio;
  function normalizeOcrSimilarityText(value) {
    return runtime.KP.normalizeOcrSimilarityText(value);
  }
  runtime.normalizeOcrSimilarityText = normalizeOcrSimilarityText;
}
