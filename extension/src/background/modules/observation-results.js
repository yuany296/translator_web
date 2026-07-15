export function installObservationResults(runtime) {
  function buildProviderNeutralObservationResult({
    provider,
    request,
    imageSize,
    normalized,
    ocrTuning,
    ocrDebug,
    ignoreSimplifiedChinese,
    serviceCounts,
    cleanedImage,
    cleanedImageToken,
    debugOverlayMode,
    debug
  }) {
    const retained = [];
    const filteredRows = [];
    (Array.isArray(normalized) ? normalized : []).forEach(candidate => {
      let reason = runtime.getFinalCandidateDropReason(candidate, imageSize, ocrTuning, provider);
      if (!reason && candidate && candidate.non_translate === true && !runtime.isChatOcrCandidate(candidate)) {
        reason = "non-translatable-chat-metadata";
      }
      if (!reason && runtime.shouldDropSymbolOnlyBubble(candidate)) {
        reason = "symbol-only-final";
      }
      if (!reason && runtime.shouldDropMeaninglessAlphabeticBubble(candidate)) {
        reason = "meaningless-alphabetic-final";
      }
      if (!reason && ignoreSimplifiedChinese && runtime.isConfidentSimplifiedChinese(candidate.original_text)) {
        reason = "ignored-simplified-chinese";
      }
      if (reason) {
        runtime.traceFilterReason(ocrDebug, {
          stage: "final",
          engine: provider,
          dropReason: reason,
          reason,
          item: {
            text: candidate && candidate.original_text ? candidate.original_text : "",
            confidence: Number(candidate && candidate.confidence) || 0,
            rawBox: candidate && candidate.rawBox ? candidate.rawBox : null,
            percent: candidate ? {
              x: candidate.x,
              y: candidate.y,
              w: candidate.w,
              h: candidate.h
            } : null
          }
        });
        filteredRows.push({
          candidate,
          reason
        });
      } else {
        retained.push(candidate);
      }
    });
    runtime.collectDebugFilteredObservationRows(ocrDebug, imageSize).forEach(row => {
      const key = runtime.buildCandidateGeometryKey(row.candidate);
      const exists = filteredRows.some(entry => runtime.buildCandidateGeometryKey(entry.candidate) === key);
      if (!exists) {
        filteredRows.push(row);
      }
    });
    if (request && request.sourceType === "seam") {
      const seamCandidates = runtime.filterSeamOcrCandidates(retained, request, imageSize);
      retained.length = 0;
      retained.push(...seamCandidates.retained);
      filteredRows.push(...seamCandidates.rejected);
    }
    const coalesced = runtime.coalesceOverlappingOcrCandidates(retained);
    coalesced.slice(runtime.MAX_BUBBLES).forEach(candidate => {
      filteredRows.push({
        candidate,
        reason: "max_bubbles"
      });
    });
    const observations = coalesced.slice(0, runtime.MAX_BUBBLES).map(candidate => runtime.buildProviderNeutralObservation(provider, request, candidate, imageSize));
    const rawFilteredObservations = filteredRows.map(({
      candidate,
      reason
    }) => ({
      ...runtime.buildProviderNeutralObservation(provider, request, candidate, imageSize),
      filterReason: String(reason || "filtered")
    }));
    const sortedObservations = runtime.sortProviderNeutralObservations(observations);
    const retainedObservationIds = new Set(sortedObservations.map(observation => String(observation.id || "")));
    const sortedFiltered = runtime.sortProviderNeutralObservations(rawFilteredObservations).filter(observation => !retainedObservationIds.has(String(observation.id || "")));
    const filteredShadowedByRetained = rawFilteredObservations.length - sortedFiltered.length;
    const edgeSignals = runtime.buildObservationEdgeSignals(sortedObservations, sortedFiltered, imageSize);
    const result = {
      provider,
      sourceType: request.sourceType,
      pageIds: [...request.pageIds],
      imageRevisionByPage: {
        ...request.imageRevisionByPage
      },
      imageDigest: request.imageDigest,
      coordinateModelVersion: runtime.OCR_COORDINATE_MODEL_VERSION,
      observations: sortedObservations,
      filteredObservations: sortedFiltered,
      edgeSignals,
      counts: {
        retained: sortedObservations.length,
        filtered: sortedFiltered.length,
        ...(filteredShadowedByRetained > 0 ? {
          filteredShadowedByRetained
        } : {}),
        ...(serviceCounts && typeof serviceCounts === "object" ? serviceCounts : {})
      },
      ...(runtime.isDataUrl(cleanedImage) ? {
        cleanedImage
      } : {}),
      ...(String(cleanedImageToken || "") ? {
        cleanedImageToken: String(cleanedImageToken)
      } : {}),
      ...(debug ? {
        debug: runtime.buildUnifiedOcrDebugPayload(ocrDebug, retained, {
          provider,
          sourceType: request.sourceType,
          debugOverlayMode: runtime.normalizeDebugOverlayMode(debugOverlayMode)
        })
      } : {})
    };
    return runtime.deepFreezeObservationResult(result);
  }
  runtime.buildProviderNeutralObservationResult = buildProviderNeutralObservationResult;
  function collectDebugFilteredObservationRows(ocrDebug, imageSize) {
    return (ocrDebug && Array.isArray(ocrDebug.filterReasons) ? ocrDebug.filterReasons : []).map(entry => {
      const item = entry && entry.item;
      const percent = item && item.percent;
      const rawBox = item && item.rawBox;
      const text = runtime.normalizeTranslationSourceText(item && item.text);
      if (!text || !percent || !rawBox) {
        return null;
      }
      return {
        reason: String(entry.reason || "filtered"),
        candidate: {
          id: "",
          x: Number(percent.x) || 0,
          y: Number(percent.y) || 0,
          w: Math.max(0.1, Number(percent.w) || 0.1),
          h: Math.max(0.1, Number(percent.h) || 0.1),
          original_text: text,
          confidence: Number(item.confidence) || 0,
          rawBox: runtime.normalizeObservationPixelBox(rawBox) || {
            left: (Number(percent.x) || 0) / 100 * imageSize.width,
            top: (Number(percent.y) || 0) / 100 * imageSize.height,
            width: Math.max(1, (Number(percent.w) || 0.1) / 100 * imageSize.width),
            height: Math.max(1, (Number(percent.h) || 0.1) / 100 * imageSize.height)
          }
        }
      };
    }).filter(Boolean);
  }
  runtime.collectDebugFilteredObservationRows = collectDebugFilteredObservationRows;
  function buildProviderNeutralObservation(provider, request, candidate, imageSize) {
    const pageSpans = runtime.buildObservationPageSpans(request, candidate, imageSize);
    const originalText = runtime.normalizeTranslationSourceText(candidate && candidate.original_text);
    const captureIdentity = [provider, request.sourceType, request.pageIds.join(","), runtime.stableSerialize(request.imageRevisionByPage)].join("|");
    const providerBlockId = runtime.buildOcrBlockId(captureIdentity, candidate);
    const geometryFingerprint = pageSpans.map(span => [span.pageId, span.box.x, span.box.y, span.box.w, span.box.h, span.overlapRatio].join(",")).join(";");
    const id = `obs-v1-${runtime.stableHash128([captureIdentity, runtime.normalizeTranslationSourceText(originalText), geometryFingerprint].join("|"))}`;
    const visual = {
      box: runtime.quantizePercentBox(candidate),
      rawBox: runtime.normalizeObservationPixelBox(candidate && candidate.rawBox),
      fillBox: runtime.quantizePercentBox(candidate && candidate.fill_box),
      bgType: String(candidate && candidate.bg_type || "solid"),
      bgColor: String(candidate && candidate.bg_color || ""),
      bgConfidence: runtime.quantizeObservationNumber(candidate && candidate.bg_confidence, 0.001),
      regionId: String(candidate && candidate.region_id || ""),
      regionType: String(candidate && candidate.region_type || ""),
      regionPolygon: runtime.quantizeObservationPolygon(candidate && candidate.region_polygon),
      textColor: String(candidate && candidate.text_color || ""),
      strokeColor: String(candidate && candidate.stroke_color || ""),
      alignment: runtime.normalizeOcrTextAlignment(candidate && candidate.alignment),
      nonTranslate: candidate && candidate.non_translate === true,
      polygon: runtime.quantizeObservationPolygon(candidate && candidate.polygon),
      rotationDeg: runtime.quantizeObservationNumber(candidate && candidate.rotation_deg, 0.1),
      fontHeight: runtime.quantizeObservationNumber(candidate && candidate.font_height, 0.1),
      fontHeightPercent: runtime.quantizeObservationNumber(candidate && candidate.font_height_percent, 0.01),
      fontWeight: runtime.normalizeOcrFontWeight(candidate && candidate.font_weight),
      font_weight: runtime.normalizeOcrFontWeight(candidate && candidate.font_weight),
      translationRole: runtime.normalizeChatTranslationRole(candidate && candidate.translation_role),
      translation_role: runtime.normalizeChatTranslationRole(candidate && candidate.translation_role),
      sourceLineCount: Math.max(1, Number(candidate && candidate.source_line_count) || 1)
    };
    visual.memberRegionIds = Object.freeze(Array.isArray(candidate && candidate.member_region_ids) ? [...candidate.member_region_ids] : []);
    visual.detectedRegions = Object.freeze(Array.isArray(candidate && candidate.detected_regions) ? candidate.detected_regions.map(region => Object.freeze({ ...region })) : []);
    return {
      id,
      provider,
      captureId: captureIdentity,
      sourceType: request.sourceType,
      pageIds: [...request.pageIds],
      imageRevisionByPage: {
        ...request.imageRevisionByPage
      },
      pageSpans,
      originalText,
      translationRole: runtime.normalizeChatTranslationRole(candidate && candidate.translation_role),
      confidence: runtime.quantizeObservationNumber(candidate && candidate.confidence, 0.001),
      visual,
      providerBlockId
    };
  }
  runtime.buildProviderNeutralObservation = buildProviderNeutralObservation;
  function buildObservationPageSpans(request, candidate, imageSize) {
    const textBox = runtime.normalizeObservationPixelBox(candidate && candidate.rawBox) || {
      left: Number(candidate && candidate.x || 0) / 100 * imageSize.width,
      top: Number(candidate && candidate.y || 0) / 100 * imageSize.height,
      width: Number(candidate && candidate.w || 0) / 100 * imageSize.width,
      height: Number(candidate && candidate.h || 0) / 100 * imageSize.height
    };
    const configured = runtime.normalizeObservationPageSpanMeta(request && request.imageMeta && request.imageMeta.pageSpans);
    if (configured.length === 0) {
      return request.pageIds.map(pageId => ({
        pageId,
        box: runtime.quantizePercentBox(candidate),
        polygon: runtime.quantizeObservationPolygon(candidate && candidate.polygon),
        overlapRatio: runtime.quantizeObservationNumber(1 / request.pageIds.length, 0.001)
      }));
    }
    let rawBox = textBox;
    if (request && request.sourceType === "seam" && configured.length === 2) {
      const maxCrossHeight = Math.max(runtime.SEAM_CROSS_EDGE_WINDOW_PX * 2, Math.min(configured[0].canvasBox.height, configured[1].canvasBox.height) * runtime.SEAM_CROSS_MAX_BAND_COVERAGE);
      const visualBox = runtime.getSeamCandidateVisualContributionBox(candidate, imageSize, maxCrossHeight);
      if (visualBox && configured.every(entry => runtime.intersectObservationBoxes(visualBox, entry.canvasBox))) {
        // 跨页气泡可能只有背景轮廓越过分页线，文字像素仍全部落在其中一页。
        // 页面贡献必须覆盖完整视觉容器，后续才能建立双页渲染面。
        rawBox = runtime.unionObservationBoxes(textBox, visualBox);
      }
    }
    const spans = [];
    configured.forEach(entry => {
      const intersection = runtime.intersectObservationBoxes(rawBox, entry.canvasBox);
      if (!intersection) {
        return;
      }
      const scaleX = entry.pageBox.width / entry.canvasBox.width;
      const scaleY = entry.pageBox.height / entry.canvasBox.height;
      const pageLeft = entry.pageBox.left + (intersection.left - entry.canvasBox.left) * scaleX;
      const pageTop = entry.pageBox.top + (intersection.top - entry.canvasBox.top) * scaleY;
      const mapBoxToPage = value => {
        const clipped = runtime.intersectObservationBoxes(value, entry.canvasBox);
        if (!clipped) return null;
        return {
          x: runtime.quantizeObservationNumber((entry.pageBox.left + (clipped.left - entry.canvasBox.left) * scaleX) / entry.pageWidth * 100, 0.01),
          y: runtime.quantizeObservationNumber((entry.pageBox.top + (clipped.top - entry.canvasBox.top) * scaleY) / entry.pageHeight * 100, 0.01),
          w: runtime.quantizeObservationNumber(clipped.width * scaleX / entry.pageWidth * 100, 0.01),
          h: runtime.quantizeObservationNumber(clipped.height * scaleY / entry.pageHeight * 100, 0.01)
        };
      };
      const mapPolygonToPage = value => {
        if (!Array.isArray(value) || value.length < 3) return null;
        const pixels = value.map(point => ({
          x: Number(point && point.x) / 100 * imageSize.width,
          y: Number(point && point.y) / 100 * imageSize.height
        }));
        if (pixels.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
        const polygonBox = runtime.normalizeObservationPixelBox({
          left: Math.min(...pixels.map(point => point.x)),
          top: Math.min(...pixels.map(point => point.y)),
          width: Math.max(...pixels.map(point => point.x)) - Math.min(...pixels.map(point => point.x)),
          height: Math.max(...pixels.map(point => point.y)) - Math.min(...pixels.map(point => point.y))
        });
        if (!runtime.intersectObservationBoxes(polygonBox, entry.canvasBox)) return null;
        return pixels.map(point => ({
          x: runtime.quantizeObservationNumber((entry.pageBox.left + (runtime.clamp(point.x, entry.canvasBox.left, entry.canvasBox.left + entry.canvasBox.width) - entry.canvasBox.left) * scaleX) / entry.pageWidth * 100, 0.01),
          y: runtime.quantizeObservationNumber((entry.pageBox.top + (runtime.clamp(point.y, entry.canvasBox.top, entry.canvasBox.top + entry.canvasBox.height) - entry.canvasBox.top) * scaleY) / entry.pageHeight * 100, 0.01)
        }));
      };
      spans.push({
        pageId: entry.pageId,
        box: {
          x: runtime.quantizeObservationNumber(pageLeft / entry.pageWidth * 100, 0.01),
          y: runtime.quantizeObservationNumber(pageTop / entry.pageHeight * 100, 0.01),
          w: runtime.quantizeObservationNumber(intersection.width * scaleX / entry.pageWidth * 100, 0.01),
          h: runtime.quantizeObservationNumber(intersection.height * scaleY / entry.pageHeight * 100, 0.01)
        },
        polygon: null,
        visual: {
          textBox: mapBoxToPage(textBox),
          fillBox: mapBoxToPage(runtime.percentBoxToObservationPixelBox(candidate && candidate.fill_box, imageSize)),
          polygon: mapPolygonToPage(candidate && candidate.polygon),
          regionPolygon: mapPolygonToPage(candidate && candidate.region_polygon)
        },
        overlapRatio: runtime.quantizeObservationNumber(intersection.width * intersection.height / Math.max(1, rawBox.width * rawBox.height), 0.001)
      });
    });
    return spans.length > 0 ? spans : request.pageIds.map(pageId => ({
      pageId,
      box: runtime.quantizePercentBox(candidate),
      polygon: null,
      overlapRatio: 0
    }));
  }
  runtime.buildObservationPageSpans = buildObservationPageSpans;
}
