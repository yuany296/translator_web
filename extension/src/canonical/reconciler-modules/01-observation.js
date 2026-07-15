export function installReconciler01(runtime) {
  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }
  runtime.clamp = clamp;
  function roundTo(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
  }
  runtime.roundTo = roundTo;
  function normalizeText(value) {
    const text = String(value ?? "");
    const nfkc = typeof text.normalize === "function" ? text.normalize("NFKC") : text;
    return nfkc.replace(/\s+/gu, " ").trim();
  }
  runtime.normalizeText = normalizeText;
  function normalizeComparableText(value) {
    return runtime.normalizeText(value).toLocaleLowerCase().replace(/\s+/gu, "");
  }
  runtime.normalizeComparableText = normalizeComparableText;
  function stableSerialize(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(item => runtime.stableSerialize(item)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${runtime.stableSerialize(value[key])}`).join(",")}}`;
  }

  // 同步、跨浏览器稳定的 128-bit 非加密摘要。imageRevision 仍由调用方用
  // SHA-256 计算；这里仅用于可重建的语义 ID。
  runtime.stableSerialize = stableSerialize;
  function stableHash(value) {
    const text = typeof value === "string" ? value : runtime.stableSerialize(value);
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    let h3 = 0x85ebca6b;
    let h4 = 0xc2b2ae35;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x5bd1e995);
      h3 = Math.imul(h3 ^ code, 0x27d4eb2d);
      h4 = Math.imul(h4 ^ code, 0x165667b1);
      h2 ^= h1 >>> 13;
      h3 ^= h2 >>> 15;
      h4 ^= h3 >>> 16;
    }
    return [h1, h2, h3, h4].map(part => (part >>> 0).toString(16).padStart(8, "0")).join("");
  }
  runtime.stableHash = stableHash;
  function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) runtime.deepFreeze(child, seen);
    return Object.freeze(value);
  }
  runtime.deepFreeze = deepFreeze;
  function normalizeStableImageSource(source, baseUrl) {
    const raw = String(source || "").trim();
    if (!raw) return "";
    try {
      const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
      url.hash = "";
      const retained = [];
      for (const [name, value] of url.searchParams.entries()) {
        if (!runtime.AUTH_QUERY_PARAM_RE.test(name)) retained.push([name, value]);
      }
      retained.sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
      url.search = "";
      for (const [name, value] of retained) url.searchParams.append(name, value);
      return url.href;
    } catch {
      const [withoutFragment] = raw.split("#", 1);
      const [pathname, query = ""] = withoutFragment.split("?", 2);
      const retained = query.split("&").filter(Boolean).filter(part => !runtime.AUTH_QUERY_PARAM_RE.test(decodeURIComponent(part.split("=", 1)[0] || ""))).sort();
      return `${pathname}${retained.length ? `?${retained.join("&")}` : ""}`;
    }
  }
  runtime.normalizeStableImageSource = normalizeStableImageSource;
  function buildChapterId(chapterUrl) {
    const raw = String(chapterUrl || "");
    let stable = raw.split("#", 1)[0];
    try {
      const url = new URL(raw);
      url.hash = "";
      stable = url.href;
    } catch {
      // 相对地址仍按去 fragment 的原值生成稳定 ID。
    }
    return `chapter_${runtime.stableHash(stable)}`;
  }
  runtime.buildChapterId = buildChapterId;
  function buildPageId({
    chapterId,
    source,
    stableSource,
    width,
    height,
    baseUrl
  } = {}) {
    const normalizedSource = runtime.normalizeStableImageSource(stableSource || source, baseUrl);
    return `page_${runtime.stableHash({
      chapterId: String(chapterId || ""),
      source: normalizedSource,
      width: Math.max(0, Math.round(Number(width) || 0)),
      height: Math.max(0, Math.round(Number(height) || 0))
    })}`;
  }
  runtime.buildPageId = buildPageId;
  function normalizeBox(box) {
    const input = box && typeof box === "object" ? box : {};
    const left = Number(input.left ?? input.x ?? 0) || 0;
    const top = Number(input.top ?? input.y ?? 0) || 0;
    const width = Math.max(0, Number(input.width ?? input.w ?? 0) || 0);
    const height = Math.max(0, Number(input.height ?? input.h ?? 0) || 0);
    return {
      left: runtime.roundTo(left),
      top: runtime.roundTo(top),
      width: runtime.roundTo(width),
      height: runtime.roundTo(height)
    };
  }
  runtime.normalizeBox = normalizeBox;
  function normalizePolygon(polygon) {
    if (!Array.isArray(polygon)) return [];
    return polygon.map(point => {
      const x = Number(Array.isArray(point) ? point[0] : point?.x);
      const y = Number(Array.isArray(point) ? point[1] : point?.y);
      return Number.isFinite(x) && Number.isFinite(y) ? {
        x: runtime.roundTo(x),
        y: runtime.roundTo(y)
      } : null;
    }).filter(Boolean);
  }
  runtime.normalizePolygon = normalizePolygon;
  function polygonBox(polygon) {
    if (!Array.isArray(polygon) || polygon.length === 0) return null;
    const xs = polygon.map(point => Number(point.x)).filter(Number.isFinite);
    const ys = polygon.map(point => Number(point.y)).filter(Number.isFinite);
    if (!xs.length || !ys.length) return null;
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return runtime.normalizeBox({
      left,
      top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top
    });
  }
  runtime.polygonBox = polygonBox;
  function normalizePageSpan(span) {
    const polygon = runtime.normalizePolygon(span?.polygon);
    const box = runtime.normalizeBox(span?.box || runtime.polygonBox(polygon));
    const spanVisual = span?.visual && typeof span.visual === "object" ? span.visual : {};
    return {
      pageId: String(span?.pageId || ""),
      box,
      polygon,
      visual: {
        textBox: spanVisual.textBox ? runtime.normalizeBox(spanVisual.textBox) : null,
        fillBox: spanVisual.fillBox ? runtime.normalizeBox(spanVisual.fillBox) : null,
        polygon: runtime.normalizePolygon(spanVisual.polygon),
        regionPolygon: runtime.normalizePolygon(spanVisual.regionPolygon)
      },
      overlapRatio: runtime.roundTo(runtime.clamp(span?.overlapRatio, 0, 1)),
      coordinateSpace: String(span?.coordinateSpace || span?.box?.coordinateSpace || "auto"),
      regionType: String(span?.regionType || "")
    };
  }
  runtime.normalizePageSpan = normalizePageSpan;
  function observationIdentityPayload(input, spans, pageIds, revisions, text) {
    return {
      model: runtime.RECONCILE_MODEL_VERSION,
      provider: String(input.provider || input.ocrProvider || "unknown"),
      captureId: String(input.captureId || input.captureIdentity || `${input.sourceType || "page"}:${pageIds.join("+")}`),
      sourceType: input.sourceType === "seam" ? "seam" : "page",
      pageIds: [...pageIds].sort(),
      imageRevisionByPage: Object.fromEntries(Object.entries(revisions).sort(([left], [right]) => left.localeCompare(right))),
      originalText: text,
      pageSpans: spans.map(span => ({
        pageId: span.pageId,
        box: span.box,
        polygon: span.polygon,
        overlapRatio: span.overlapRatio,
        coordinateSpace: span.coordinateSpace,
        regionType: span.regionType
      })).sort((left, right) => left.pageId.localeCompare(right.pageId) || runtime.stableSerialize(left).localeCompare(runtime.stableSerialize(right)))
    };
  }
  runtime.observationIdentityPayload = observationIdentityPayload;
  function createObservation(input = {}) {
    const spans = (Array.isArray(input.pageSpans) ? input.pageSpans : []).map(runtime.normalizePageSpan).filter(span => span.pageId);
    const pageIds = Array.from(new Set([...(Array.isArray(input.pageIds) ? input.pageIds : []), ...spans.map(span => span.pageId)].map(String).filter(Boolean))).sort();
    const revisions = {};
    for (const pageId of pageIds) {
      revisions[pageId] = String(input.imageRevisionByPage?.[pageId] || input.imageRevision || "");
    }
    const originalText = runtime.normalizeText(input.originalText ?? input.original_text ?? input.text);
    const identity = runtime.observationIdentityPayload(input, spans, pageIds, revisions, originalText);
    const id = String(input.id || `obs_${runtime.stableHash(identity)}`);
    return runtime.deepFreeze({
      id,
      sourceType: input.sourceType === "seam" ? "seam" : "page",
      pageIds,
      imageRevisionByPage: revisions,
      pageSpans: spans,
      originalText,
      confidence: runtime.roundTo(runtime.clamp(input.confidence ?? input.score ?? 0, 0, 1)),
      visual: input.visual && typeof input.visual === "object" ? JSON.parse(JSON.stringify(input.visual)) : {},
      providerBlockId: String(input.providerBlockId ?? input.provider_block_id ?? input.block_id ?? ""),
      provider: String(input.provider || input.ocrProvider || "unknown"),
      captureId: String(input.captureId || input.captureIdentity || ""),
      filterReason: String(input.filterReason || input.filter_reason || "")
    });
  }
  runtime.createObservation = createObservation;
  function normalizePage(page, fallbackIndex = 0) {
    const pageId = String(page?.pageId || "");
    return runtime.deepFreeze({
      ...page,
      pageId,
      chapterId: String(page?.chapterId || ""),
      imageRevision: String(page?.imageRevision || ""),
      width: Math.max(1, Number(page?.width ?? page?.naturalWidth) || 1),
      height: Math.max(1, Number(page?.height ?? page?.naturalHeight) || 1),
      readingOrder: Number.isFinite(Number(page?.readingOrder ?? page?.index)) ? Number(page?.readingOrder ?? page?.index) : fallbackIndex,
      shortPage: Boolean(page?.shortPage ?? page?.isShortPage)
    });
  }
  runtime.normalizePage = normalizePage;
  function sortPages(pages) {
    return (Array.isArray(pages) ? pages : []).map(runtime.normalizePage).filter(page => page.pageId).sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
  }
  runtime.sortPages = sortPages;
  function calculateSeamBandHeight(pageAWidth, pageBWidth) {
    return runtime.clamp(Math.round(Math.min(Number(pageAWidth) || 0, Number(pageBWidth) || 0) * runtime.SEAM_BAND_WIDTH_RATIO), runtime.SEAM_BAND_MIN_PX, runtime.SEAM_BAND_MAX_PX);
  }
  runtime.calculateSeamBandHeight = calculateSeamBandHeight;
  function buildSeamPairKey(pageA, pageB) {
    const pages = [runtime.normalizePage(pageA, 0), runtime.normalizePage(pageB, 1)].sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    const pairId = `pair_${runtime.stableHash(pages.map(page => page.pageId))}`;
    return `${pairId}:${pages.map(page => `${page.pageId}@${page.imageRevision}`).join("+")}`;
  }
  runtime.buildSeamPairKey = buildSeamPairKey;
  function buildSeamPlan(pageAInput, pageBInput, options = {}) {
    const [pageA, pageB] = [runtime.normalizePage(pageAInput, 0), runtime.normalizePage(pageBInput, 1)].sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    const bandHeight = runtime.calculateSeamBandHeight(pageA.width, pageB.width);
    const upperHeight = Math.min(pageA.height, bandHeight);
    const lowerHeight = Math.min(pageB.height, bandHeight);
    const overlapPx = runtime.clamp(options.overlapPx ?? options.overlapPixels ?? 0, 0, Math.min(upperHeight, lowerHeight));
    return runtime.deepFreeze({
      pairKey: runtime.buildSeamPairKey(pageA, pageB),
      pageIds: [pageA.pageId, pageB.pageId],
      imageRevisionByPage: {
        [pageA.pageId]: pageA.imageRevision,
        [pageB.pageId]: pageB.imageRevision
      },
      bandHeight,
      upperCrop: {
        pageId: pageA.pageId,
        x: 0,
        y: Math.max(0, pageA.height - upperHeight),
        width: pageA.width,
        height: upperHeight
      },
      lowerCrop: {
        pageId: pageB.pageId,
        x: 0,
        y: 0,
        width: pageB.width,
        height: lowerHeight
      },
      overlapPx,
      canvasWidth: Math.max(pageA.width, pageB.width),
      canvasHeight: Math.max(1, upperHeight + lowerHeight - overlapPx),
      draws: [{
        pageId: pageA.pageId,
        sourceY: Math.max(0, pageA.height - upperHeight),
        sourceHeight: upperHeight,
        destY: 0
      }, {
        pageId: pageB.pageId,
        sourceY: 0,
        sourceHeight: lowerHeight,
        destY: Math.max(0, upperHeight - overlapPx)
      }]
    });
  }
  runtime.buildSeamPlan = buildSeamPlan;
}
