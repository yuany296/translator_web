export function installSeamHandling(runtime) {
  function filterSeamOcrCandidates(candidates, request, imageSize) {
    const input = Array.isArray(candidates) ? candidates : [];
    if (!request || request.sourceType !== "seam") {
      return {
        retained: [...input],
        rejected: []
      };
    }
    const segments = runtime.normalizeObservationPageSpanMeta(request.imageMeta && request.imageMeta.pageSpans).sort((left, right) => left.canvasBox.top - right.canvasBox.top || left.pageId.localeCompare(right.pageId));
    if (segments.length !== 2) {
      return {
        retained: [],
        rejected: input.map(candidate => ({
          candidate,
          reason: "seam_geometry_unavailable"
        }))
      };
    }
    const [upperSegment, lowerSegment] = segments;
    const maxCrossHeight = Math.max(runtime.SEAM_CROSS_EDGE_WINDOW_PX * 2, Math.min(upperSegment.canvasBox.height, lowerSegment.canvasBox.height) * runtime.SEAM_CROSS_MAX_BAND_COVERAGE);
    const direct = [];
    const upperEdge = [];
    const lowerEdge = [];
    const rejected = [];
    input.forEach((candidate, index) => {
      const descriptor = runtime.describeSeamOcrCandidate(candidate, index, upperSegment, lowerSegment, imageSize, maxCrossHeight);
      if (!descriptor) {
        rejected.push({
          candidate,
          reason: "seam_invalid_geometry"
        });
        return;
      }
      if (descriptor.crossesBoundary) {
        direct.push(descriptor);
        return;
      }
      if (descriptor.upperEdgeOnly) {
        upperEdge.push(descriptor);
        return;
      }
      if (descriptor.lowerEdgeOnly) {
        lowerEdge.push(descriptor);
        return;
      }
      rejected.push({
        candidate,
        reason: "seam_not_cross_boundary"
      });
    });
    const pairCandidates = [];
    const directUpper = direct.filter(descriptor => runtime.getSeamDirectPairSide(descriptor) === "upper");
    const directLower = direct.filter(descriptor => runtime.getSeamDirectPairSide(descriptor) === "lower");
    [...upperEdge, ...directUpper].forEach(upper => {
      [...lowerEdge, ...directLower].forEach(lower => {
        if (upper.index === lower.index) return;
        const pair = runtime.buildSeamCrossPairCandidate(upper, lower, imageSize, maxCrossHeight);
        if (pair) pairCandidates.push(pair);
      });
    });
    pairCandidates.sort((left, right) => right.score - left.score || left.upper.index - right.upper.index || left.lower.index - right.lower.index);
    const used = new Set();
    const merged = [];
    for (const pair of pairCandidates) {
      if (used.has(pair.upper.index) || used.has(pair.lower.index)) continue;
      used.add(pair.upper.index);
      used.add(pair.lower.index);
      merged.push(pair.candidate);
    }
    for (const descriptor of [...upperEdge, ...lowerEdge]) {
      if (!used.has(descriptor.index)) {
        rejected.push({
          candidate: descriptor.candidate,
          reason: "seam_not_cross_boundary"
        });
      }
    }
    const retained = [...direct.filter(item => !used.has(item.index)).map(item => item.candidate), ...merged].sort((left, right) => {
      const leftBox = runtime.getSeamCandidateRawBox(left, imageSize);
      const rightBox = runtime.getSeamCandidateRawBox(right, imageSize);
      return (leftBox?.top || 0) - (rightBox?.top || 0) || (leftBox?.left || 0) - (rightBox?.left || 0) || String(left.original_text || "").localeCompare(String(right.original_text || ""));
    });
    return {
      retained,
      rejected
    };
  }
  runtime.filterSeamOcrCandidates = filterSeamOcrCandidates;
  function getSeamDirectPairSide(descriptor) {
    const rawHeight = Math.max(1, Number(descriptor && descriptor.rawBox && descriptor.rawBox.height) || 1);
    const upperHeight = Number(descriptor && descriptor.upperIntersection && descriptor.upperIntersection.height) || 0;
    const lowerHeight = Number(descriptor && descriptor.lowerIntersection && descriptor.lowerIntersection.height) || 0;
    const minimumBias = Math.max(1, rawHeight * 0.1);
    if (upperHeight - lowerHeight >= minimumBias) return "upper";
    if (lowerHeight - upperHeight >= minimumBias) return "lower";
    return "";
  }
  runtime.getSeamDirectPairSide = getSeamDirectPairSide;
  function resolveSeamCrossEdgeWindow(rawBox, maxCrossHeight) {
    const lineHeight = Math.max(1, Number(rawBox && rawBox.height) || 1);
    const adaptive = lineHeight * 1.35;
    return Math.max(runtime.SEAM_CROSS_EDGE_WINDOW_PX,
      Math.min(Math.max(runtime.SEAM_CROSS_EDGE_WINDOW_PX, maxCrossHeight * 0.45), adaptive));
  }
  runtime.resolveSeamCrossEdgeWindow = resolveSeamCrossEdgeWindow;
  function describeSeamOcrCandidate(candidate, index, upperSegment, lowerSegment, imageSize, maxCrossHeight) {
    const rawBox = runtime.getSeamCandidateRawBox(candidate, imageSize);
    const originalText = runtime.normalizeTranslationSourceText(candidate && candidate.original_text);
    if (!rawBox || !originalText) return null;
    const upperIntersection = runtime.intersectObservationBoxes(rawBox, upperSegment.canvasBox);
    const lowerIntersection = runtime.intersectObservationBoxes(rawBox, lowerSegment.canvasBox);
    const upperBottom = upperSegment.canvasBox.top + upperSegment.canvasBox.height;
    const lowerTop = lowerSegment.canvasBox.top;
    // 分页可能切在两行之间；允许按当前字号扩展边缘窗口，避免固定 24px 漏掉正常行距。
    const edgeWindow = runtime.resolveSeamCrossEdgeWindow(rawBox, maxCrossHeight);
    const textCrossesBoundary = Boolean(upperIntersection && lowerIntersection && rawBox.top < lowerTop && rawBox.top + rawBox.height > upperBottom && rawBox.height <= maxCrossHeight);
    const visualBox = runtime.getSeamCandidateVisualContributionBox(candidate, imageSize, maxCrossHeight);
    const visualCrossesBoundary = Boolean(visualBox && runtime.intersectObservationBoxes(visualBox, upperSegment.canvasBox) && runtime.intersectObservationBoxes(visualBox, lowerSegment.canvasBox) && (upperIntersection && rawBox.top + rawBox.height >= upperBottom - edgeWindow || lowerIntersection && rawBox.top <= lowerTop + edgeWindow));
    return {
      candidate,
      index,
      rawBox,
      upperIntersection,
      lowerIntersection,
      crossesBoundary: textCrossesBoundary || visualCrossesBoundary,
      upperEdgeOnly: Boolean(upperIntersection && !lowerIntersection && rawBox.top + rawBox.height >= upperBottom - edgeWindow),
      lowerEdgeOnly: Boolean(lowerIntersection && !upperIntersection && rawBox.top <= lowerTop + edgeWindow)
    };
  }
  runtime.describeSeamOcrCandidate = describeSeamOcrCandidate;
  function getSeamCandidateRawBox(candidate, imageSize) {
    return runtime.normalizeObservationPixelBox(candidate && candidate.rawBox) || runtime.normalizeObservationPixelBox({
      left: Number(candidate && candidate.x || 0) / 100 * Math.max(1, Number(imageSize && imageSize.width) || 1),
      top: Number(candidate && candidate.y || 0) / 100 * Math.max(1, Number(imageSize && imageSize.height) || 1),
      width: Number(candidate && candidate.w || 0) / 100 * Math.max(1, Number(imageSize && imageSize.width) || 1),
      height: Number(candidate && candidate.h || 0) / 100 * Math.max(1, Number(imageSize && imageSize.height) || 1)
    });
  }
  runtime.getSeamCandidateRawBox = getSeamCandidateRawBox;
  function resolveSeamCrossPairMaxGap(upperBox, lowerBox, maxCrossHeight) {
    const lineHeightSum = Math.max(2,
      (Number(upperBox && upperBox.height) || 0) + (Number(lowerBox && lowerBox.height) || 0));
    const adaptive = lineHeightSum * 0.8;
    return Math.max(runtime.SEAM_CROSS_PAIR_MAX_GAP_PX,
      Math.min(Math.max(runtime.SEAM_CROSS_PAIR_MAX_GAP_PX, maxCrossHeight * 0.45), adaptive));
  }
  runtime.resolveSeamCrossPairMaxGap = resolveSeamCrossPairMaxGap;
  function seamPairTextCanContinue(upperText, upperCandidate, lowerCandidate) {
    const upperEndsSentence = /[.!?。！？…]["'’”」』）》】]*$/u.test(upperText);
    const upperRegionId = String(upperCandidate && upperCandidate.region_id || "");
    const lowerRegionId = String(lowerCandidate && lowerCandidate.region_id || "");
    return !upperEndsSentence || Boolean(upperRegionId && upperRegionId === lowerRegionId);
  }
  runtime.seamPairTextCanContinue = seamPairTextCanContinue;
  function buildSeamCrossPairCandidate(upper, lower, imageSize, maxCrossHeight) {
    const upperText = runtime.normalizeTranslationSourceText(upper && upper.candidate && upper.candidate.original_text);
    const lowerText = runtime.normalizeTranslationSourceText(lower && lower.candidate && lower.candidate.original_text);
    if (!upperText || !lowerText || upperText.replace(/\s+/gu, "") === lowerText.replace(/\s+/gu, "")) {
      return null;
    }
    if (!runtime.seamPairTextCanContinue(upperText, upper.candidate, lower.candidate)) return null;
    const upperBox = upper.rawBox;
    const lowerBox = lower.rawBox;
    const horizontalOverlap = Math.max(0, Math.min(upperBox.left + upperBox.width, lowerBox.left + lowerBox.width) - Math.max(upperBox.left, lowerBox.left)) / Math.max(1, Math.min(upperBox.width, lowerBox.width));
    const heightRatio = Math.min(upperBox.height, lowerBox.height) / Math.max(upperBox.height, lowerBox.height, 1);
    const verticalGap = lowerBox.top - (upperBox.top + upperBox.height);
    const upperRotation = Number(upper.candidate && upper.candidate.rotation_deg) || 0;
    const lowerRotation = Number(lower.candidate && lower.candidate.rotation_deg) || 0;
    const maxPairGap = runtime.resolveSeamCrossPairMaxGap(upperBox, lowerBox, maxCrossHeight);
    if (horizontalOverlap < runtime.SEAM_CROSS_MIN_HORIZONTAL_OVERLAP || heightRatio < runtime.SEAM_CROSS_MIN_HEIGHT_RATIO || verticalGap > maxPairGap || Math.abs(upperRotation - lowerRotation) > runtime.SEAM_CROSS_MAX_ROTATION_DELTA_DEG) {
      return null;
    }
    const rawBox = {
      left: Math.min(upperBox.left, lowerBox.left),
      top: Math.min(upperBox.top, lowerBox.top),
      width: Math.max(upperBox.left + upperBox.width, lowerBox.left + lowerBox.width) - Math.min(upperBox.left, lowerBox.left),
      height: Math.max(upperBox.top + upperBox.height, lowerBox.top + lowerBox.height) - Math.min(upperBox.top, lowerBox.top)
    };
    if (rawBox.height > maxCrossHeight) return null;
    const width = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const height = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const sameSolidBackground = String(upper.candidate.bg_type || "").toLowerCase() === "solid" && String(lower.candidate.bg_type || "").toLowerCase() === "solid";
    const sameRegionType = String(upper.candidate.region_type || "") === String(lower.candidate.region_type || "");
    const candidate = {
      ...upper.candidate,
      id: `seam-cross-pair:${String(upper.candidate.id || upper.index)}:${String(lower.candidate.id || lower.index)}`,
      x: rawBox.left / width * 100,
      y: rawBox.top / height * 100,
      w: rawBox.width / width * 100,
      h: rawBox.height / height * 100,
      rawBox,
      original_text: `${upperText}\n${lowerText}`,
      confidence: Math.min(Number(upper.candidate.confidence) || 0, Number(lower.candidate.confidence) || 0),
      bg_type: sameSolidBackground ? "solid" : "none",
      bg_color: sameSolidBackground && String(upper.candidate.bg_color || "") === String(lower.candidate.bg_color || "") ? String(upper.candidate.bg_color || "") : "",
      region_id: String(upper.candidate.region_id || "") === String(lower.candidate.region_id || "") ? String(upper.candidate.region_id || "") : "",
      region_type: sameRegionType ? String(upper.candidate.region_type || "") : "plain_text",
      region_polygon: null,
      polygon: null,
      fill_box: sameSolidBackground ? {
        x: rawBox.left / width * 100,
        y: rawBox.top / height * 100,
        w: rawBox.width / width * 100,
        h: rawBox.height / height * 100
      } : null,
      rotation_deg: (upperRotation + lowerRotation) / 2,
      source_line_count: Math.max(1, Number(upper.candidate.source_line_count) || 1) + Math.max(1, Number(lower.candidate.source_line_count) || 1)
    };
    return {
      upper,
      lower,
      candidate,
      score: horizontalOverlap * 0.6 + heightRatio * 0.3 + (1 - Math.min(1, Math.max(0, verticalGap) / maxPairGap)) * 0.1
    };
  }
  runtime.buildSeamCrossPairCandidate = buildSeamCrossPairCandidate;
  function intersectObservationBoxes(left, right) {
    if (!left || !right) {
      return null;
    }
    const x1 = Math.max(left.left, right.left);
    const y1 = Math.max(left.top, right.top);
    const x2 = Math.min(left.left + left.width, right.left + right.width);
    const y2 = Math.min(left.top + left.height, right.top + right.height);
    return x2 > x1 && y2 > y1 ? {
      left: x1,
      top: y1,
      width: x2 - x1,
      height: y2 - y1
    } : null;
  }
  runtime.intersectObservationBoxes = intersectObservationBoxes;
  function quantizePercentBox(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const x = Number(value.x ?? value.left);
    const y = Number(value.y ?? value.top);
    const w = Number(value.w ?? value.width);
    const h = Number(value.h ?? value.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      return null;
    }
    return {
      x: runtime.quantizeObservationNumber(x, 0.01),
      y: runtime.quantizeObservationNumber(y, 0.01),
      w: runtime.quantizeObservationNumber(w, 0.01),
      h: runtime.quantizeObservationNumber(h, 0.01)
    };
  }
  runtime.quantizePercentBox = quantizePercentBox;
  function quantizeObservationPolygon(value) {
    return Array.isArray(value) ? value.map(point => ({
      x: runtime.quantizeObservationNumber(Array.isArray(point) ? point[0] : point && point.x, 0.01),
      y: runtime.quantizeObservationNumber(Array.isArray(point) ? point[1] : point && point.y, 0.01)
    })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)) : null;
  }
  runtime.quantizeObservationPolygon = quantizeObservationPolygon;
  function quantizeObservationNumber(value, quantum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number / quantum) * quantum : 0;
  }
  runtime.quantizeObservationNumber = quantizeObservationNumber;
  function buildCandidateGeometryKey(candidate) {
    return [runtime.normalizeTranslationSourceText(candidate && candidate.original_text), runtime.quantizeObservationNumber(candidate && candidate.x, 0.1), runtime.quantizeObservationNumber(candidate && candidate.y, 0.1), runtime.quantizeObservationNumber(candidate && candidate.w, 0.1), runtime.quantizeObservationNumber(candidate && candidate.h, 0.1)].join("|");
  }
  runtime.buildCandidateGeometryKey = buildCandidateGeometryKey;
  function sortProviderNeutralObservations(value) {
    return [...value].sort((left, right) => {
      const leftSpan = left.pageSpans && left.pageSpans[0];
      const rightSpan = right.pageSpans && right.pageSpans[0];
      return String(leftSpan && leftSpan.pageId || "").localeCompare(String(rightSpan && rightSpan.pageId || "")) || Number(leftSpan && leftSpan.box && leftSpan.box.y || 0) - Number(rightSpan && rightSpan.box && rightSpan.box.y || 0) || Number(leftSpan && leftSpan.box && leftSpan.box.x || 0) - Number(rightSpan && rightSpan.box && rightSpan.box.x || 0) || String(left.id).localeCompare(String(right.id));
    });
  }
  runtime.sortProviderNeutralObservations = sortProviderNeutralObservations;
  function buildObservationEdgeSignals(observations, filteredObservations, imageSize) {
    const bandHeight = Math.min(Math.max(1, Number(imageSize && imageSize.height) || 1), runtime.clamp(Math.round(Math.max(1, Number(imageSize && imageSize.width) || 1) * 0.15), 160, 420));
    const bandPercent = bandHeight / Math.max(1, Number(imageSize && imageSize.height) || 1) * 100;
    const buildSide = side => {
      const retainedIds = observations.filter(item => runtime.observationTouchesEdge(item, side, bandPercent)).map(item => item.id);
      const filteredIds = filteredObservations.filter(item => runtime.observationTouchesEdge(item, side, bandPercent)).map(item => item.id);
      const visualDetected = [...observations, ...filteredObservations].some(item => runtime.observationVisualTouchesEdge(item, side, bandPercent));
      return {
        detected: retainedIds.length > 0 || filteredIds.length > 0 || visualDetected,
        retainedObservationIds: retainedIds,
        filteredObservationIds: filteredIds,
        visualDetected
      };
    };
    const top = buildSide("top");
    const bottom = buildSide("bottom");
    return {
      bandHeight,
      top,
      bottom,
      hasAny: top.detected || bottom.detected
    };
  }
  runtime.buildObservationEdgeSignals = buildObservationEdgeSignals;
  function observationTouchesEdge(observation, side, bandPercent) {
    return (observation && observation.pageSpans || []).some(span => {
      const box = span && span.box;
      return box && (side === "top" ? box.y <= bandPercent : box.y + box.h >= 100 - bandPercent);
    });
  }
  runtime.observationTouchesEdge = observationTouchesEdge;
  function observationVisualTouchesEdge(observation, side, bandPercent) {
    const visual = observation && observation.visual || {};
    const polygons = [visual.polygon, visual.regionPolygon, visual.region_polygon].filter(value => Array.isArray(value) && value.length > 0);
    const polygonTouches = polygons.some(polygon => {
      const values = polygon.map(point => Number(point && point.y)).filter(Number.isFinite);
      return values.length > 0 && (side === "top" ? Math.min(...values) <= bandPercent : Math.max(...values) >= 100 - bandPercent);
    });
    if (polygonTouches) return true;
    return [visual.fillBox, visual.fill_box, visual.regionBox, visual.region_box, visual.box].filter(box => box && typeof box === "object").some(box => {
      const y = Number(box.y ?? box.top);
      const height = Number(box.h ?? box.height);
      return Number.isFinite(y) && Number.isFinite(height) && height > 0 && (side === "top" ? y <= bandPercent : y + height >= 100 - bandPercent);
    });
  }
  runtime.observationVisualTouchesEdge = observationVisualTouchesEdge;
  function removeFilteredObservationIdConflicts(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.observations) || !Array.isArray(value.filteredObservations)) {
      return value;
    }
    const retainedIds = new Set(value.observations.map(observation => String(observation && observation.id || "")).filter(Boolean));
    const filteredObservations = value.filteredObservations.filter(observation => !retainedIds.has(String(observation && observation.id || "")));
    if (filteredObservations.length === value.filteredObservations.length) return value;
    const filteredShadowedByRetained = value.filteredObservations.length - filteredObservations.length;
    return {
      ...value,
      filteredObservations,
      counts: {
        ...(value.counts && typeof value.counts === "object" ? value.counts : {}),
        retained: value.observations.length,
        filtered: filteredObservations.length,
        filteredShadowedByRetained: Math.max(filteredShadowedByRetained, Number(value.counts && value.counts.filteredShadowedByRetained) || 0)
      }
    };
  }
  runtime.removeFilteredObservationIdConflicts = removeFilteredObservationIdConflicts;
  function deepFreezeObservationResult(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    const normalized = runtime.removeFilteredObservationIdConflicts(value);
    Object.values(normalized).forEach(runtime.deepFreezeObservationResult);
    return Object.freeze(normalized);
  }
  runtime.deepFreezeObservationResult = deepFreezeObservationResult;
  function normalizeCanonicalRevision(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.floor(number) : 1;
  }
  runtime.normalizeCanonicalRevision = normalizeCanonicalRevision;
  function normalizeLanguageTag(value, fallback) {
    const text = String(value || "").trim();
    return text || fallback;
  }
  runtime.normalizeLanguageTag = normalizeLanguageTag;
  function normalizeTranslationSourceText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  }
  runtime.normalizeTranslationSourceText = normalizeTranslationSourceText;
}
