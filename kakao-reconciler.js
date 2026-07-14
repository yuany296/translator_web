/* ===================================================================
 * kakao-reconciler.js — Kakao 单页权威 OCR 的纯逻辑归并层
 *
 * 本模块不访问 DOM、chrome.* 或网络。内容脚本只把稳定的页面身份与
 * provider-neutral Observation 交进来；模块负责确定性归并、覆盖账本与
 * 每页渲染投影。浏览器通过全局对象使用，Node 测试可直接 import。
 * =================================================================== */
(function () {
  "use strict";

  if (globalThis.MangaTranslatorKakaoReconciler) {
    return;
  }

  const RECONCILE_MODEL_VERSION = "kakao-canonical-v1";
  const GEOMETRY_WEIGHT = 0.35;
  const VISUAL_WEIGHT = 0.30;
  const SEAM_WEIGHT = 0.25;
  const TEXT_WEIGHT = 0.10;
  const MERGE_THRESHOLD = 0.75;
  const REVIEW_THRESHOLD = 0.60;
  const MAX_COMPONENT_PAGES = 3;
  const DEFAULT_EDGE_WAIT_MS = 8000;
  const MIN_SEAM_PAGE_CONTRIBUTION = 0.08;
  // seam 仅用于确认真正跨页的文字；大范围取样会把完整气泡和阅读器 UI 再次送入 OCR。
  const SEAM_BAND_WIDTH_RATIO = 0.15;
  const SEAM_BAND_MIN_PX = 64;
  const SEAM_BAND_MAX_PX = 96;
  const FUZZY_SEAM_FRAGMENT_MIN_LENGTH = 5;
  const FUZZY_SEAM_FRAGMENT_THRESHOLD = 0.80;
  const FUZZY_OCR_QUOTE_RE = /['"‘’“”＇＂]/gu;
  const AUTH_QUERY_PARAM_RE = /^(?:signature|credential|expires|policy|token|key-pair-id|x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders))$/i;

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function roundTo(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function normalizeText(value) {
    const text = String(value ?? "");
    const nfkc = typeof text.normalize === "function" ? text.normalize("NFKC") : text;
    return nfkc.replace(/\s+/gu, " ").trim();
  }

  function normalizeComparableText(value) {
    return normalizeText(value).toLocaleLowerCase().replace(/\s+/gu, "");
  }

  function stableSerialize(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }

  // 同步、跨浏览器稳定的 128-bit 非加密摘要。imageRevision 仍由调用方用
  // SHA-256 计算；这里仅用于可重建的语义 ID。
  function stableHash(value) {
    const text = typeof value === "string" ? value : stableSerialize(value);
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
    return [h1, h2, h3, h4]
      .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
  }

  function normalizeStableImageSource(source, baseUrl) {
    const raw = String(source || "").trim();
    if (!raw) return "";
    try {
      const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
      url.hash = "";
      const retained = [];
      for (const [name, value] of url.searchParams.entries()) {
        if (!AUTH_QUERY_PARAM_RE.test(name)) retained.push([name, value]);
      }
      retained.sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
      url.search = "";
      for (const [name, value] of retained) url.searchParams.append(name, value);
      return url.href;
    } catch {
      const [withoutFragment] = raw.split("#", 1);
      const [pathname, query = ""] = withoutFragment.split("?", 2);
      const retained = query
        .split("&")
        .filter(Boolean)
        .filter((part) => !AUTH_QUERY_PARAM_RE.test(decodeURIComponent(part.split("=", 1)[0] || "")))
        .sort();
      return `${pathname}${retained.length ? `?${retained.join("&")}` : ""}`;
    }
  }

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
    return `chapter_${stableHash(stable)}`;
  }

  function buildPageId({ chapterId, source, stableSource, width, height, baseUrl } = {}) {
    const normalizedSource = normalizeStableImageSource(stableSource || source, baseUrl);
    return `page_${stableHash({
      chapterId: String(chapterId || ""),
      source: normalizedSource,
      width: Math.max(0, Math.round(Number(width) || 0)),
      height: Math.max(0, Math.round(Number(height) || 0))
    })}`;
  }

  function normalizeBox(box) {
    const input = box && typeof box === "object" ? box : {};
    const left = Number(input.left ?? input.x ?? 0) || 0;
    const top = Number(input.top ?? input.y ?? 0) || 0;
    const width = Math.max(0, Number(input.width ?? input.w ?? 0) || 0);
    const height = Math.max(0, Number(input.height ?? input.h ?? 0) || 0);
    return {
      left: roundTo(left),
      top: roundTo(top),
      width: roundTo(width),
      height: roundTo(height)
    };
  }

  function normalizePolygon(polygon) {
    if (!Array.isArray(polygon)) return [];
    return polygon
      .map((point) => {
        const x = Number(Array.isArray(point) ? point[0] : point?.x);
        const y = Number(Array.isArray(point) ? point[1] : point?.y);
        return Number.isFinite(x) && Number.isFinite(y) ? { x: roundTo(x), y: roundTo(y) } : null;
      })
      .filter(Boolean);
  }

  function polygonBox(polygon) {
    if (!Array.isArray(polygon) || polygon.length === 0) return null;
    const xs = polygon.map((point) => Number(point.x)).filter(Number.isFinite);
    const ys = polygon.map((point) => Number(point.y)).filter(Number.isFinite);
    if (!xs.length || !ys.length) return null;
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return normalizeBox({
      left,
      top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top
    });
  }

  function normalizePageSpan(span) {
    const polygon = normalizePolygon(span?.polygon);
    const box = normalizeBox(span?.box || polygonBox(polygon));
    return {
      pageId: String(span?.pageId || ""),
      box,
      polygon,
      overlapRatio: roundTo(clamp(span?.overlapRatio, 0, 1)),
      coordinateSpace: String(span?.coordinateSpace || span?.box?.coordinateSpace || "auto"),
      regionType: String(span?.regionType || "")
    };
  }

  function observationIdentityPayload(input, spans, pageIds, revisions, text) {
    return {
      model: RECONCILE_MODEL_VERSION,
      provider: String(input.provider || input.ocrProvider || "unknown"),
      captureId: String(input.captureId || input.captureIdentity || `${input.sourceType || "page"}:${pageIds.join("+")}`),
      sourceType: input.sourceType === "seam" ? "seam" : "page",
      pageIds: [...pageIds].sort(),
      imageRevisionByPage: Object.fromEntries(Object.entries(revisions).sort(([left], [right]) => left.localeCompare(right))),
      originalText: text,
      pageSpans: spans
        .map((span) => ({
          pageId: span.pageId,
          box: span.box,
          polygon: span.polygon,
          overlapRatio: span.overlapRatio,
          coordinateSpace: span.coordinateSpace,
          regionType: span.regionType
        }))
        .sort((left, right) => left.pageId.localeCompare(right.pageId) || stableSerialize(left).localeCompare(stableSerialize(right)))
    };
  }

  function createObservation(input = {}) {
    const spans = (Array.isArray(input.pageSpans) ? input.pageSpans : [])
      .map(normalizePageSpan)
      .filter((span) => span.pageId);
    const pageIds = Array.from(new Set([
      ...(Array.isArray(input.pageIds) ? input.pageIds : []),
      ...spans.map((span) => span.pageId)
    ].map(String).filter(Boolean))).sort();
    const revisions = {};
    for (const pageId of pageIds) {
      revisions[pageId] = String(input.imageRevisionByPage?.[pageId] || input.imageRevision || "");
    }
    const originalText = normalizeText(input.originalText ?? input.original_text ?? input.text);
    const identity = observationIdentityPayload(input, spans, pageIds, revisions, originalText);
    const id = String(input.id || `obs_${stableHash(identity)}`);
    return deepFreeze({
      id,
      sourceType: input.sourceType === "seam" ? "seam" : "page",
      pageIds,
      imageRevisionByPage: revisions,
      pageSpans: spans,
      originalText,
      confidence: roundTo(clamp(input.confidence ?? input.score ?? 0, 0, 1)),
      visual: input.visual && typeof input.visual === "object" ? JSON.parse(JSON.stringify(input.visual)) : {},
      providerBlockId: String(input.providerBlockId ?? input.provider_block_id ?? input.block_id ?? ""),
      provider: String(input.provider || input.ocrProvider || "unknown"),
      captureId: String(input.captureId || input.captureIdentity || ""),
      filterReason: String(input.filterReason || input.filter_reason || "")
    });
  }

  function normalizePage(page, fallbackIndex = 0) {
    const pageId = String(page?.pageId || "");
    return deepFreeze({
      ...page,
      pageId,
      chapterId: String(page?.chapterId || ""),
      imageRevision: String(page?.imageRevision || ""),
      width: Math.max(1, Number(page?.width ?? page?.naturalWidth) || 1),
      height: Math.max(1, Number(page?.height ?? page?.naturalHeight) || 1),
      readingOrder: Number.isFinite(Number(page?.readingOrder ?? page?.index))
        ? Number(page?.readingOrder ?? page?.index)
        : fallbackIndex,
      shortPage: Boolean(page?.shortPage ?? page?.isShortPage)
    });
  }

  function sortPages(pages) {
    return (Array.isArray(pages) ? pages : [])
      .map(normalizePage)
      .filter((page) => page.pageId)
      .sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
  }

  function calculateSeamBandHeight(pageAWidth, pageBWidth) {
    return clamp(
      Math.round(Math.min(Number(pageAWidth) || 0, Number(pageBWidth) || 0) * SEAM_BAND_WIDTH_RATIO),
      SEAM_BAND_MIN_PX,
      SEAM_BAND_MAX_PX
    );
  }

  function buildSeamPairKey(pageA, pageB) {
    const pages = [normalizePage(pageA, 0), normalizePage(pageB, 1)]
      .sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    const pairId = `pair_${stableHash(pages.map((page) => page.pageId))}`;
    return `${pairId}:${pages.map((page) => `${page.pageId}@${page.imageRevision}`).join("+")}`;
  }

  function buildSeamPlan(pageAInput, pageBInput, options = {}) {
    const [pageA, pageB] = [normalizePage(pageAInput, 0), normalizePage(pageBInput, 1)]
      .sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    const bandHeight = calculateSeamBandHeight(pageA.width, pageB.width);
    const upperHeight = Math.min(pageA.height, bandHeight);
    const lowerHeight = Math.min(pageB.height, bandHeight);
    const overlapPx = clamp(options.overlapPx ?? options.overlapPixels ?? 0, 0, Math.min(upperHeight, lowerHeight));
    return deepFreeze({
      pairKey: buildSeamPairKey(pageA, pageB),
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
      draws: [
        { pageId: pageA.pageId, sourceY: Math.max(0, pageA.height - upperHeight), sourceHeight: upperHeight, destY: 0 },
        { pageId: pageB.pageId, sourceY: 0, sourceHeight: lowerHeight, destY: Math.max(0, upperHeight - overlapPx) }
      ]
    });
  }

  function boxInNormalizedPage(span, page) {
    const box = normalizeBox(span?.box || polygonBox(span?.polygon));
    const coordinateSpace = String(span?.coordinateSpace || "auto").toLowerCase();
    const looksNormalized = coordinateSpace === "normalized" || coordinateSpace === "ratio";
    const looksPercent = coordinateSpace === "percent"
      || (coordinateSpace === "auto"
        && Math.max(Math.abs(box.left), Math.abs(box.top), box.width, box.height) <= 100.0001);
    const divisorX = looksNormalized ? 1 : looksPercent ? 100 : page.width;
    const divisorY = looksNormalized ? 1 : looksPercent ? 100 : page.height;
    return {
      left: box.left / divisorX,
      top: box.top / divisorY,
      width: box.width / divisorX,
      height: box.height / divisorY
    };
  }

  function getSpan(observation, pageId) {
    return observation?.pageSpans?.find((span) => span.pageId === pageId) || null;
  }

  function isSpanAtEdge(span, page, edge, bandHeight) {
    if (!span || !page) return false;
    const box = boxInNormalizedPage(span, page);
    const bandRatio = Math.min(1, bandHeight / page.height);
    if (edge === "bottom") return box.top + box.height >= 1 - bandRatio;
    return box.top <= bandRatio;
  }

  function observationTouchesEdge(observation, page, edge, bandHeight) {
    if (!observation?.pageIds?.includes(page.pageId)) return false;
    return isSpanAtEdge(getSpan(observation, page.pageId), page, edge, bandHeight);
  }

  function hasSignalForPage(edgeSignals, pageId, edge) {
    function detected(value) {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value > 0;
      if (Array.isArray(value)) return value.length > 0 && value.some((item) => detected(item));
      if (!value || typeof value !== "object") return false;
      if (Object.prototype.hasOwnProperty.call(value, "detected")) return value.detected === true;
      if (Object.prototype.hasOwnProperty.call(value, "visualDetected")) return value.visualDetected === true;
      if (Object.prototype.hasOwnProperty.call(value, "visual_detected")) return value.visual_detected === true;
      if (Array.isArray(value.ids)) return value.ids.length > 0;
      if (Array.isArray(value.regionIds)) return value.regionIds.length > 0;
      if (Array.isArray(value.regions)) return value.regions.length > 0;
      if (Array.isArray(value.polygons)) return value.polygons.length > 0;
      return false;
    }
    if (!edgeSignals) return false;
    if (edgeSignals === true) return true;
    if (Array.isArray(edgeSignals)) {
      return edgeSignals.some((signal) => {
        if (!signal || typeof signal !== "object") return Boolean(signal);
        return (!signal.pageId || signal.pageId === pageId)
          && (!signal.edge || signal.edge === edge)
          && detected(signal);
      });
    }
    const direct = edgeSignals[pageId];
    if (direct === true) return true;
    if (direct && typeof direct === "object") {
      if (Object.prototype.hasOwnProperty.call(direct, edge)) return detected(direct[edge]);
      return detected(direct);
    }
    if (Object.prototype.hasOwnProperty.call(edgeSignals, edge)) return detected(edgeSignals[edge]);
    return detected(edgeSignals);
  }

  function evaluateSeamEvidence({
    pageA: pageAInput,
    pageB: pageBInput,
    observations = [],
    filteredObservations = [],
    edgeSignals,
    overlapRisk
  } = {}) {
    const [pageA, pageB] = [normalizePage(pageAInput, 0), normalizePage(pageBInput, 1)]
      .sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    const bandHeight = calculateSeamBandHeight(pageA.width, pageB.width);
    const reasons = [];
    const pageById = new Map([[pageA.pageId, pageA], [pageB.pageId, pageB]]);
    const allObservations = [...observations, ...filteredObservations]
      .map((observation) => observation?.pageSpans ? observation : createObservation(observation))
      .filter((observation) => isRevisionCurrent(observation, pageById));
    if (allObservations.some((observation) => observationTouchesEdge(observation, pageA, "bottom", bandHeight))) {
      reasons.push("upper_ocr_edge");
    }
    if (allObservations.some((observation) => observationTouchesEdge(observation, pageB, "top", bandHeight))) {
      reasons.push("lower_ocr_edge");
    }
    if (hasSignalForPage(edgeSignals, pageA.pageId, "bottom")) reasons.push("upper_visual_edge");
    if (hasSignalForPage(edgeSignals, pageB.pageId, "top")) reasons.push("lower_visual_edge");
    if (pageA.shortPage || pageB.shortPage) reasons.push("short_page");
    if (overlapRisk === true || overlapRisk?.detected || overlapRisk?.accepted || overlapRisk?.risk || overlapRisk?.fragmentRisk
      || Number(overlapRisk?.overlapPixels) > 0 || Number(overlapRisk?.ratio) > 0
      || Number(overlapRisk?.rows) > 0 || (Array.isArray(overlapRisk?.rows) && overlapRisk.rows.length > 0)) {
      reasons.push(overlapRisk?.fragmentRisk ? "fragment_structure" : "pixel_overlap");
    }
    const uniqueReasons = Array.from(new Set(reasons)).sort();
    return deepFreeze({
      shouldRun: uniqueReasons.length > 0,
      reasons: uniqueReasons,
      pairKey: buildSeamPairKey(pageA, pageB),
      bandHeight
    });
  }

  function isRevisionCurrent(observation, pageById) {
    for (const pageId of observation.pageIds) {
      const page = pageById.get(pageId);
      if (!page) return false;
      if (page.imageRevision && observation.imageRevisionByPage?.[pageId] !== page.imageRevision) return false;
    }
    return true;
  }

  function intersectionArea(left, right) {
    const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
    return width * height;
  }

  function overlapOverSmaller(left, right) {
    const denominator = Math.min(left.width * left.height, right.width * right.height);
    return denominator > 0 ? intersectionArea(left, right) / denominator : 0;
  }

  function horizontalRelation(left, right) {
    const overlap = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
    const overlapRatio = overlap / Math.max(0.0001, Math.min(left.width, right.width));
    const leftCenter = left.left + left.width / 2;
    const rightCenter = right.left + right.width / 2;
    const centerDistance = Math.abs(leftCenter - rightCenter);
    const centerScore = 1 - clamp(centerDistance / Math.max(0.0001, Math.max(left.width, right.width) * 1.5), 0, 1);
    return { overlapRatio: clamp(overlapRatio, 0, 1), centerScore: clamp(centerScore, 0, 1), centerDistance };
  }

  function regionTypeOf(observation, span) {
    return String(span?.regionType || observation?.visual?.regionType || observation?.visual?.region_type || "").trim().toLowerCase();
  }

  function regionsCompatible(leftObservation, leftSpan, rightObservation, rightSpan) {
    const left = regionTypeOf(leftObservation, leftSpan);
    const right = regionTypeOf(rightObservation, rightSpan);
    return !left || !right || left === right;
  }

  function diceSimilarity(leftText, rightText) {
    const left = Array.from(normalizeComparableText(leftText));
    const right = Array.from(normalizeComparableText(rightText));
    if (!left.length || !right.length) return 0;
    if (left.join("") === right.join("")) return 1;
    if (left.length === 1 || right.length === 1) return left.some((char) => right.includes(char)) ? 0.5 : 0;
    const counts = new Map();
    for (let index = 0; index < left.length - 1; index += 1) {
      const pair = `${left[index]}\u0000${left[index + 1]}`;
      counts.set(pair, (counts.get(pair) || 0) + 1);
    }
    let matches = 0;
    for (let index = 0; index < right.length - 1; index += 1) {
      const pair = `${right[index]}\u0000${right[index + 1]}`;
      const count = counts.get(pair) || 0;
      if (count > 0) {
        matches += 1;
        counts.set(pair, count - 1);
      }
    }
    return (2 * matches) / ((left.length - 1) + (right.length - 1));
  }

  function textSimilarity(leftText, rightText) {
    const left = normalizeComparableText(leftText);
    const right = normalizeComparableText(rightText);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    const containment = longer.includes(shorter) ? shorter.length / longer.length : 0;
    return clamp(Math.max(containment, diceSimilarity(left, right)), 0, 1);
  }

  function fuzzyFragmentSimilarity(leftText, rightText) {
    const normalizeFragment = (value) => Array.from(
      normalizeComparableText(value).replace(FUZZY_OCR_QUOTE_RE, "")
    );
    const left = normalizeFragment(leftText);
    const right = normalizeFragment(rightText);
    if (!left.length || !right.length) return 0;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    if (shorter.length < FUZZY_SEAM_FRAGMENT_MIN_LENGTH) return 0;

    const editDistance = (first, second) => {
      let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
      for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
        const current = [firstIndex];
        for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
          const substitution = previous[secondIndex - 1]
            + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1);
          current[secondIndex] = Math.min(
            previous[secondIndex] + 1,
            current[secondIndex - 1] + 1,
            substitution
          );
        }
        previous = current;
      }
      return previous[second.length];
    };

    let best = 0;
    const minimumWindowLength = Math.max(1, shorter.length - 1);
    const maximumWindowLength = Math.min(longer.length, shorter.length + 1);
    for (let windowLength = minimumWindowLength; windowLength <= maximumWindowLength; windowLength += 1) {
      for (let start = 0; start + windowLength <= longer.length; start += 1) {
        const window = longer.slice(start, start + windowLength);
        const denominator = Math.max(shorter.length, window.length);
        best = Math.max(best, 1 - editDistance(shorter, window) / denominator);
      }
    }
    return clamp(best, 0, 1);
  }

  function suffixPrefixOverlap(leftText, rightText) {
    const left = Array.from(normalizeText(leftText));
    const right = Array.from(normalizeText(rightText));
    const max = Math.min(left.length, right.length);
    for (let length = max; length >= 1; length -= 1) {
      if (left.slice(left.length - length).join("") === right.slice(0, length).join("")) return length;
    }
    return 0;
  }

  function joinContinuationText(leftText, rightText) {
    const left = normalizeText(leftText);
    const right = normalizeText(rightText);
    if (!left) return right;
    if (!right) return left;
    if (left.includes(right)) return left;
    if (right.includes(left)) return right;
    const overlap = suffixPrefixOverlap(left, right);
    return `${left}${right.slice(overlap)}`;
  }

  function hasStrongTextRelation(leftText, rightText) {
    const left = normalizeComparableText(leftText);
    const right = normalizeComparableText(rightText);
    if (!left || !right) return false;
    if (textSimilarity(left, right) >= 0.55) return true;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    if (shorter.length >= 2 && longer.includes(shorter)) return true;
    const overlap = Math.max(suffixPrefixOverlap(left, right), suffixPrefixOverlap(right, left));
    if (overlap >= Math.max(2, Math.ceil(Math.min(left.length, right.length) * 0.45))) return true;
    // OCR 在跨页边缘容易把一个韩文字形识错，或多带一个引号。只对足够长的
    // seam 片段做近似子串比较；保留数学、货币等语义符号，避免误合并。
    return fuzzyFragmentSimilarity(left, right) >= FUZZY_SEAM_FRAGMENT_THRESHOLD;
  }

  function visualIdentity(value) {
    const visual = value?.visual || {};
    // regionId 只在一次 OCR 捕获内有意义，不能当作跨捕获的视觉身份。
    return String(visual.regionHash || visual.region_hash || visual.visualHash || visual.visual_hash || visual.hash || "");
  }

  function hasSharedVisualIdentity(...observations) {
    const identities = observations.map(visualIdentity);
    return identities.length > 1 && identities.every(Boolean) && identities.every((identity) => identity === identities[0]);
  }

  function seamContributionByPage(observation) {
    const contributions = new Map();
    for (const span of Array.isArray(observation?.pageSpans) ? observation.pageSpans : []) {
      const pageId = String(span?.pageId || "");
      if (!pageId) continue;
      const explicitRatio = Number(span?.overlapRatio);
      const box = normalizeBox(span?.box);
      const fallbackArea = Math.max(0, box.width) * Math.max(0, box.height);
      // overlapRatio=0 是坐标映射明确给出的“没有贡献”，不能再用 box
      // 面积回退成正权重，否则纯上下文 OCR 会伪装成跨页证据。
      const weight = Number.isFinite(explicitRatio) ? Math.max(0, explicitRatio) : fallbackArea;
      contributions.set(pageId, Math.max(contributions.get(pageId) || 0, weight));
    }
    return contributions;
  }

  function hasMeaningfulCrossPageContribution(observation, requiredPageIds = []) {
    if (observation?.sourceType !== "seam") return false;
    const contributions = seamContributionByPage(observation);
    const pageIds = (Array.isArray(requiredPageIds) && requiredPageIds.length
      ? requiredPageIds.map(String)
      : [...contributions.keys()]
    ).filter((pageId, index, values) => pageId && values.indexOf(pageId) === index);
    if (pageIds.length < 2 || pageIds.some((pageId) => !contributions.has(pageId))) return false;
    const weights = pageIds.map((pageId) => contributions.get(pageId) || 0);
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) return false;
    return weights.every((value) => value / total >= MIN_SEAM_PAGE_CONTRIBUTION);
  }

  function observationQuality(observation) {
    const text = normalizeText(observation.originalText);
    const terminal = /[.!?。！？…]\s*$/u.test(text) ? 0.08 : 0;
    const replacementPenalty = (text.match(/[�□]/gu) || []).length * 0.03;
    return roundTo(
      clamp(observation.confidence, 0, 1) * 0.48
      + clamp(Array.from(text).length / 80, 0, 1) * 0.36
      + terminal
      + (text ? 0.08 : 0)
      - replacementPenalty,
      6
    );
  }

  function compareObservationsByPage(left, right, pageIndex) {
    const leftPage = Math.min(...left.pageIds.map((pageId) => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
    const rightPage = Math.min(...right.pageIds.map((pageId) => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
    if (leftPage !== rightPage) return leftPage - rightPage;
    const leftSpan = getSpan(left, left.pageIds.find((pageId) => pageIndex.get(pageId) === leftPage) || left.pageIds[0]);
    const rightSpan = getSpan(right, right.pageIds.find((pageId) => pageIndex.get(pageId) === rightPage) || right.pageIds[0]);
    const leftBox = normalizeBox(leftSpan?.box);
    const rightBox = normalizeBox(rightSpan?.box);
    return leftBox.top - rightBox.top || leftBox.left - rightBox.left || left.id.localeCompare(right.id);
  }

  function seamSupportsPair(seam, upperObservation, lowerObservation, upperPage, lowerPage) {
    if (!seam.pageIds.includes(upperPage.pageId) || !seam.pageIds.includes(lowerPage.pageId)) return null;
    if (!isRevisionCurrent(seam, new Map([
      [upperPage.pageId, upperPage],
      [lowerPage.pageId, lowerPage]
    ]))) return null;
    const upperSeamSpan = getSpan(seam, upperPage.pageId);
    const lowerSeamSpan = getSpan(seam, lowerPage.pageId);
    if (!upperSeamSpan || !lowerSeamSpan) return null;
    if (!hasMeaningfulCrossPageContribution(seam, [upperPage.pageId, lowerPage.pageId])) return null;
    const upperBox = boxInNormalizedPage(getSpan(upperObservation, upperPage.pageId), upperPage);
    const lowerBox = boxInNormalizedPage(getSpan(lowerObservation, lowerPage.pageId), lowerPage);
    const upperSupportBox = boxInNormalizedPage(upperSeamSpan, upperPage);
    const lowerSupportBox = boxInNormalizedPage(lowerSeamSpan, lowerPage);
    const upperGeometry = Math.max(overlapOverSmaller(upperBox, upperSupportBox), horizontalRelation(upperBox, upperSupportBox).centerScore);
    const lowerGeometry = Math.max(overlapOverSmaller(lowerBox, lowerSupportBox), horizontalRelation(lowerBox, lowerSupportBox).centerScore);
    const geometry = (upperGeometry + lowerGeometry) / 2;
    if (geometry < 0.32) return null;
    const seamText = normalizeComparableText(seam.originalText);
    const upperText = normalizeComparableText(upperObservation.originalText);
    const lowerText = normalizeComparableText(lowerObservation.originalText);
    const combined = `${upperText}${lowerText}`;
    const upperSimilarity = textSimilarity(seamText, upperText);
    const lowerSimilarity = textSimilarity(seamText, lowerText);
    const combinedSimilarity = textSimilarity(seamText, combined);
    const upperSupported = hasStrongTextRelation(seamText, upperText) || upperSimilarity >= 0.45;
    const lowerSupported = hasStrongTextRelation(seamText, lowerText) || lowerSimilarity >= 0.45;
    const text = Math.max(combinedSimilarity, Math.min(upperSimilarity, lowerSimilarity));
    // 接缝文本必须能解释两侧，而不是只复述其中一页。
    const textSupported = upperSupported && lowerSupported
      && (combinedSimilarity >= 0.35
        || (seamText.includes(upperText) && seamText.includes(lowerText))
        || hasStrongTextRelation(seamText, combined));
    const visualSupported = hasSharedVisualIdentity(seam, upperObservation, lowerObservation);
    if (!textSupported && !visualSupported) return null;
    const trulyCrosses = true;
    return {
      seam,
      score: clamp((trulyCrosses ? 0.58 : 0.40) + geometry * 0.25 + text * 0.17 + (visualSupported ? 0.08 : 0), 0, 1),
      geometry,
      text,
      trulyCrosses
    };
  }

  function geometryScoreForPair(
    upperObservation,
    lowerObservation,
    upperPage,
    lowerPage,
    bandHeight,
    options = {}
  ) {
    const upperSpan = getSpan(upperObservation, upperPage.pageId);
    const lowerSpan = getSpan(lowerObservation, lowerPage.pageId);
    if (!upperSpan || !lowerSpan) return null;
    if (!isSpanAtEdge(upperSpan, upperPage, "bottom", bandHeight)
      || !isSpanAtEdge(lowerSpan, lowerPage, "top", bandHeight)) return null;
    if (
      !regionsCompatible(upperObservation, upperSpan, lowerObservation, lowerSpan) &&
      options.allowRegionMismatch !== true
    ) return null;
    const upperBox = boxInNormalizedPage(upperSpan, upperPage);
    const lowerBox = boxInNormalizedPage(lowerSpan, lowerPage);
    const horizontal = horizontalRelation(upperBox, lowerBox);
    if (horizontal.overlapRatio < 0.12
      && horizontal.centerDistance > Math.max(upperBox.width, lowerBox.width) * 0.8) return null;
    const upperBandRatio = Math.min(1, bandHeight / upperPage.height);
    const lowerBandRatio = Math.min(1, bandHeight / lowerPage.height);
    const upperDistance = clamp((1 - (upperBox.top + upperBox.height)) / Math.max(upperBandRatio, 0.0001), 0, 1);
    const lowerDistance = clamp(lowerBox.top / Math.max(lowerBandRatio, 0.0001), 0, 1);
    const boundary = 1 - (upperDistance + lowerDistance) / 2;
    const widthRatio = Math.min(upperBox.width, lowerBox.width) / Math.max(upperBox.width, lowerBox.width, 0.0001);
    const score = horizontal.overlapRatio * 0.45
      + horizontal.centerScore * 0.25
      + boundary * 0.20
      + widthRatio * 0.10;
    return { score: clamp(score, 0, 1), upperBox, lowerBox, horizontal, boundary };
  }

  function visualScoreForPair(left, right, leftSpan, rightSpan, geometry) {
    const leftVisual = left.visual || {};
    const rightVisual = right.visual || {};
    let score = 0.68 + clamp(geometry?.horizontal?.centerScore, 0, 1) * 0.10;
    const leftRegion = regionTypeOf(left, leftSpan);
    const rightRegion = regionTypeOf(right, rightSpan);
    if (leftRegion && rightRegion && leftRegion === rightRegion) score += 0.12;
    const leftHash = String(leftVisual.regionHash || leftVisual.visualHash || leftVisual.hash || "");
    const rightHash = String(rightVisual.regionHash || rightVisual.visualHash || rightVisual.hash || "");
    if (leftHash && rightHash) score += leftHash === rightHash ? 0.10 : -0.16;
    const leftTone = Number(leftVisual.meanLuma ?? leftVisual.mean_luma);
    const rightTone = Number(rightVisual.meanLuma ?? rightVisual.mean_luma);
    if (Number.isFinite(leftTone) && Number.isFinite(rightTone)) {
      score += 0.08 * (1 - clamp(Math.abs(leftTone - rightTone) / 80, 0, 1));
    }
    return clamp(score, 0, 1);
  }

  function classifyPair(left, right) {
    const similarity = textSimilarity(left.originalText, right.originalText);
    const leftText = normalizeComparableText(left.originalText);
    const rightText = normalizeComparableText(right.originalText);
    const shorter = leftText.length <= rightText.length ? leftText : rightText;
    const longer = leftText.length > rightText.length ? leftText : rightText;
    const contained = Boolean(shorter && longer.includes(shorter) && shorter.length / Math.max(1, longer.length) >= 0.72);
    return { type: similarity >= 0.72 || contained ? "duplicate" : "continuation", similarity };
  }

  function adjacencyToken(leftPageId, rightPageId) {
    return [String(leftPageId || ""), String(rightPageId || "")].sort().join("\u0000");
  }

  function normalizeAdjacencyPairs(values) {
    const output = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const ids = Array.isArray(value) ? value
        : Array.isArray(value?.pageIds) ? value.pageIds
          : [value?.pageAId ?? value?.previousPageId, value?.pageBId ?? value?.nextPageId];
      if (ids.length >= 2 && ids[0] && ids[1]) output.add(adjacencyToken(ids[0], ids[1]));
    }
    return output;
  }

  function isConfirmedAdjacentPair(upperPage, lowerPage, seamObservations, pageById, adjacencyPairs) {
    if (adjacencyPairs.has(adjacencyToken(upperPage.pageId, lowerPage.pageId))) return true;
    if (String(upperPage.nextPageId || "") === lowerPage.pageId
      || String(lowerPage.previousPageId || "") === upperPage.pageId) return true;
    return seamObservations.some((seam) =>
      seam.pageIds.length === 2
      && seam.pageIds.includes(upperPage.pageId)
      && seam.pageIds.includes(lowerPage.pageId)
      && isRevisionCurrent(seam, pageById));
  }

  function sameChapter(leftPage, rightPage) {
    return String(leftPage?.chapterId || "") === String(rightPage?.chapterId || "");
  }

  function buildCandidatePagePairs(pages, seamObservations, pageById, adjacencyPairs) {
    const pairs = new Map();
    function add(leftPage, rightPage) {
      if (!leftPage || !rightPage || leftPage.pageId === rightPage.pageId || !sameChapter(leftPage, rightPage)) return;
      const [upperPage, lowerPage] = [leftPage, rightPage].sort((left, right) =>
        left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
      pairs.set(adjacencyToken(upperPage.pageId, lowerPage.pageId), { upperPage, lowerPage });
    }

    const pagesByChapter = new Map();
    for (const page of pages) {
      const chapterId = String(page.chapterId || "");
      if (!pagesByChapter.has(chapterId)) pagesByChapter.set(chapterId, []);
      pagesByChapter.get(chapterId).push(page);
    }
    for (const chapterPages of pagesByChapter.values()) {
      chapterPages.sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
      for (let index = 0; index < chapterPages.length - 1; index += 1) add(chapterPages[index], chapterPages[index + 1]);
    }
    for (const token of adjacencyPairs) {
      const [leftId, rightId] = token.split("\u0000");
      add(pageById.get(leftId), pageById.get(rightId));
    }
    for (const page of pages) {
      add(page, pageById.get(String(page.nextPageId || "")));
      add(pageById.get(String(page.previousPageId || "")), page);
    }
    for (const seam of seamObservations) {
      if (seam.pageIds.length === 2) add(pageById.get(seam.pageIds[0]), pageById.get(seam.pageIds[1]));
    }
    return Array.from(pairs.values()).sort((left, right) =>
      left.upperPage.readingOrder - right.upperPage.readingOrder
      || left.lowerPage.readingOrder - right.lowerPage.readingOrder
      || left.upperPage.pageId.localeCompare(right.upperPage.pageId)
      || left.lowerPage.pageId.localeCompare(right.lowerPage.pageId));
  }

  function buildCandidateEdges(pageObservations, seamObservations, pages, pageById, adjacencyPairs) {
    const observationsByPage = new Map(pages.map((page) => [page.pageId, []]));
    for (const observation of pageObservations) {
      for (const pageId of observation.pageIds) observationsByPage.get(pageId)?.push(observation);
    }
    const edges = [];
    for (const { upperPage, lowerPage } of buildCandidatePagePairs(pages, seamObservations, pageById, adjacencyPairs)) {
      const adjacencyConfirmed = isConfirmedAdjacentPair(
        upperPage,
        lowerPage,
        seamObservations,
        pageById,
        adjacencyPairs
      );
      const bandHeight = calculateSeamBandHeight(upperPage.width, lowerPage.width);
      for (const upperObservation of observationsByPage.get(upperPage.pageId) || []) {
        if (!isRevisionCurrent(upperObservation, pageById)) continue;
        for (const lowerObservation of observationsByPage.get(lowerPage.pageId) || []) {
          if (!isRevisionCurrent(lowerObservation, pageById)) continue;
          const supports = seamObservations
            .map((seam) => seamSupportsPair(seam, upperObservation, lowerObservation, upperPage, lowerPage))
            .filter(Boolean)
            .sort((left, right) => right.score - left.score || left.seam.id.localeCompare(right.seam.id));
          const seamScore = supports[0]?.score || 0;
          // 单页视觉分类会在页面边界处漂移（例如同一标题上半页被判 effect_text，
          // 下半页被判 caption_panel）。只有同时覆盖两页、且文字与几何都能解释
          // 两侧的强 seam 证据，才允许越过这个分类差异；普通异区文字仍是硬约束。
          const geometry = geometryScoreForPair(
            upperObservation,
            lowerObservation,
            upperPage,
            lowerPage,
            bandHeight,
            { allowRegionMismatch: seamScore >= MERGE_THRESHOLD }
          );
          if (!geometry) continue;
          const pair = classifyPair(upperObservation, lowerObservation);
          const visualScore = visualScoreForPair(
            upperObservation,
            lowerObservation,
            getSpan(upperObservation, upperPage.pageId),
            getSpan(lowerObservation, lowerPage.pageId),
            geometry
          );
          const score = geometry.score * GEOMETRY_WEIGHT
            + visualScore * VISUAL_WEIGHT
            + seamScore * SEAM_WEIGHT
            + pair.similarity * TEXT_WEIGHT;
          edges.push({
            id: `edge_${stableHash([upperObservation.id, lowerObservation.id])}`,
            upperId: upperObservation.id,
            lowerId: lowerObservation.id,
            upperPageId: upperPage.pageId,
            lowerPageId: lowerPage.pageId,
            adjacencyConfirmed,
            type: pair.type,
            score: roundTo(score, 6),
            scores: {
              geometry: roundTo(geometry.score, 6),
              visual: roundTo(visualScore, 6),
              seam: roundTo(seamScore, 6),
              text: roundTo(pair.similarity, 6)
            },
            supportingSeamIds: supports.filter((support) => support.score >= seamScore - 0.08).map((support) => support.seam.id).sort()
          });
        }
      }
    }
    return edges.sort((left, right) =>
      right.score - left.score
      || left.upperPageId.localeCompare(right.upperPageId)
      || left.lowerPageId.localeCompare(right.lowerPageId)
      || left.upperId.localeCompare(right.upperId)
      || left.lowerId.localeCompare(right.lowerId));
  }

  function createUnionFind(observations) {
    const parent = new Map();
    const members = new Map();
    for (const observation of observations) {
      parent.set(observation.id, observation.id);
      members.set(observation.id, new Set([observation.id]));
    }
    function find(id) {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      let cursor = id;
      while (parent.get(cursor) !== cursor) {
        const next = parent.get(cursor);
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    }
    function union(leftId, rightId) {
      const leftRoot = find(leftId);
      const rightRoot = find(rightId);
      if (leftRoot === rightRoot) return leftRoot;
      const root = leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
      const child = root === leftRoot ? rightRoot : leftRoot;
      parent.set(child, root);
      const target = members.get(root);
      for (const id of members.get(child)) target.add(id);
      members.delete(child);
      return root;
    }
    return { find, union, getMembers: (id) => new Set(members.get(find(id))) };
  }

  function spanTouchesBothEdges(observations, page, bandHeight) {
    let top = false;
    let bottom = false;
    for (const observation of observations) {
      const span = getSpan(observation, page.pageId);
      if (!span) continue;
      top ||= isSpanAtEdge(span, page, "top", bandHeight);
      bottom ||= isSpanAtEdge(span, page, "bottom", bandHeight);
    }
    return top && bottom;
  }

  function pageMembersCompatible(observations, page) {
    if (observations.length < 2) return true;
    for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
        const left = observations[leftIndex];
        const right = observations[rightIndex];
        const leftBox = boxInNormalizedPage(getSpan(left, page.pageId), page);
        const rightBox = boxInNormalizedPage(getSpan(right, page.pageId), page);
        // 单页权威证据不能仅因原文相同而被折叠；同页多证据进入一个
        // canonical 必须先证明是同一几何实体。
        if (overlapOverSmaller(leftBox, rightBox) < 0.35) {
          return false;
        }
      }
    }
    return true;
  }

  function canUnionComponents(unionFind, leftId, rightId, observationById, pageById) {
    const ids = new Set([...unionFind.getMembers(leftId), ...unionFind.getMembers(rightId)]);
    const observations = Array.from(ids).map((id) => observationById.get(id));
    const pageIds = Array.from(new Set(observations.flatMap((observation) => observation.pageIds)));
    const componentPages = pageIds.map((pageId) => pageById.get(pageId)).filter(Boolean)
      .sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    if (!componentPages.length || componentPages.length > MAX_COMPONENT_PAGES) return false;
    if (new Set(componentPages.map((page) => page.chapterId)).size > 1) return false;
    for (const pageId of pageIds) {
      const page = pageById.get(pageId);
      const onPage = observations.filter((observation) => observation.pageIds.includes(pageId));
      if (!pageMembersCompatible(onPage, page)) return false;
    }
    if (componentPages.length === 3) {
      const [previous, middle, next] = componentPages;
      const middleObservations = observations.filter((observation) => observation.pageIds.includes(middle.pageId));
      const bandHeight = calculateSeamBandHeight(Math.min(previous.width, middle.width), Math.min(middle.width, next.width));
      if (!middle.shortPage && !spanTouchesBothEdges(middleObservations, middle, bandHeight)) return false;
    }
    return true;
  }

  function relationBetweenSeamAndPage(seam, pageObservation, pageById) {
    if (!hasStrongTextRelation(seam.originalText, pageObservation.originalText)) return 0;
    let total = 0;
    let matches = 0;
    for (const pageId of pageObservation.pageIds) {
      if (!seam.pageIds.includes(pageId)) continue;
      const page = pageById.get(pageId);
      const seamSpan = getSpan(seam, pageId);
      const pageSpan = getSpan(pageObservation, pageId);
      if (!page || !seamSpan || !pageSpan) continue;
      if (!regionsCompatible(seam, seamSpan, pageObservation, pageSpan)) continue;
      const seamBox = boxInNormalizedPage(seamSpan, page);
      const pageBox = boxInNormalizedPage(pageSpan, page);
      const overlap = overlapOverSmaller(seamBox, pageBox);
      const center = horizontalRelation(seamBox, pageBox).centerScore;
      if (overlap < 0.12 && center < 0.88) continue;
      total += Math.max(overlap, center * 0.72);
      matches += 1;
    }
    if (!matches) return 0;
    return clamp((total / matches) * 0.78 + textSimilarity(seam.originalText, pageObservation.originalText) * 0.22, 0, 1);
  }

  function canAttachSeamToComponent(seam, members, pageById) {
    const pageIds = Array.from(new Set([
      ...seam.pageIds,
      ...members.flatMap((observation) => observation.pageIds)
    ]));
    const componentPages = pageIds.map((pageId) => pageById.get(pageId)).filter(Boolean);
    return componentPages.length === pageIds.length
      && componentPages.length > 0
      && componentPages.length <= MAX_COMPONENT_PAGES
      && new Set(componentPages.map((page) => page.chapterId)).size === 1;
  }

  function createCoverageLedger() {
    const resolutions = new Map();
    return {
      resolve(observationId, resolution, details = {}) {
        const id = String(observationId || "");
        if (!id) throw new Error("CoverageLedger requires an observation id");
        if (resolutions.has(id)) throw new Error(`Observation ${id} was resolved more than once`);
        if (!["standalone", "consumed", "filtered"].includes(resolution)) {
          throw new Error(`Invalid observation resolution: ${resolution}`);
        }
        if (resolution === "filtered" && !String(details.filterReason || "")) {
          throw new Error(`Filtered observation ${id} requires filterReason`);
        }
        resolutions.set(id, deepFreeze({ resolution, ...details }));
      },
      has(observationId) {
        return resolutions.has(String(observationId));
      },
      get(observationId) {
        return resolutions.get(String(observationId)) || null;
      },
      toJSON() {
        return deepFreeze(Object.fromEntries(Array.from(resolutions.entries()).sort(([left], [right]) => left.localeCompare(right))));
      }
    };
  }

  function geometryByPageForMembers(memberObservations, pageIndex) {
    const output = {};
    const sorted = [...memberObservations].sort((left, right) => compareObservationsByPage(left, right, pageIndex));
    for (const observation of sorted) {
      for (const span of observation.pageSpans) {
        output[span.pageId] ||= [];
        output[span.pageId].push({
          observationId: observation.id,
          sourceType: observation.sourceType,
          confidence: observation.confidence,
          originalText: observation.originalText,
          visual: observation.visual,
          box: span.box,
          polygon: span.polygon,
          overlapRatio: span.overlapRatio,
          coordinateSpace: span.coordinateSpace,
          regionType: span.regionType || regionTypeOf(observation, span)
        });
      }
    }
    return Object.fromEntries(Object.entries(output)
      .sort(([left], [right]) => (pageIndex.get(left) ?? 0) - (pageIndex.get(right) ?? 0) || left.localeCompare(right))
      .map(([pageId, geometries]) => [pageId, geometries.sort((left, right) =>
        left.box.top - right.box.top || left.box.left - right.box.left || left.observationId.localeCompare(right.observationId))]));
  }

  function chooseDuplicateText(observations) {
    return [...observations]
      .sort((left, right) => observationQuality(right) - observationQuality(left)
        || Array.from(right.originalText).length - Array.from(left.originalText).length
        || left.id.localeCompare(right.id))[0]?.originalText || "";
  }

  function isTrueCrossPageSeam(observation) {
    return hasMeaningfulCrossPageContribution(observation);
  }

  function chooseCanonicalText(memberObservations, componentEdges, pageIndex) {
    const pageObservations = memberObservations.filter((observation) => observation.sourceType === "page")
      .sort((left, right) => compareObservationsByPage(left, right, pageIndex));
    const continuation = componentEdges.some((edge) => edge.type === "continuation");
    if (!continuation || pageObservations.length <= 1) {
      // duplicate 也可能是两个截断 page observation 被完整 seam observation
      // 覆盖；完整接缝证据参与质量竞争，不能只在 continuation 分支使用。
      return chooseDuplicateText(memberObservations);
    }
    const seamCandidates = memberObservations
      .filter(isTrueCrossPageSeam)
      .sort((left, right) => observationQuality(right) - observationQuality(left)
        || Array.from(right.originalText).length - Array.from(left.originalText).length
        || left.id.localeCompare(right.id));
    if (seamCandidates.length) return seamCandidates[0].originalText;
    return pageObservations.reduce((text, observation) => joinContinuationText(text, observation.originalText), "");
  }

  function earliestPageIndexForCanonical(canonical, pageIndex) {
    return Math.min(...Object.keys(canonical.geometryByPage || {}).map((pageId) => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
  }

  function canonicalGeometrySimilarity(left, right, pageById) {
    const sharedPages = Object.keys(left.geometryByPage || {}).filter((pageId) => right.geometryByPage?.[pageId]);
    if (!sharedPages.length) return 0;
    let best = 0;
    for (const pageId of sharedPages) {
      const page = pageById.get(pageId);
      if (!page) continue;
      for (const leftGeometry of left.geometryByPage[pageId]) {
        for (const rightGeometry of right.geometryByPage[pageId]) {
          best = Math.max(best, overlapOverSmaller(
            boxInNormalizedPage(leftGeometry, page),
            boxInNormalizedPage(rightGeometry, page)
          ));
        }
      }
    }
    return best;
  }

  function canonicalSignature(canonical) {
    return stableHash({
      memberObservationIds: canonical.memberObservationIds,
      originalText: canonical.originalText,
      nonTranslate: canonical.nonTranslate === true,
      geometryByPage: canonical.geometryByPage
    });
  }

  function observationCaptureGeneration(observation) {
    const revisions = Object.entries(observation.imageRevisionByPage || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pageId, revision]) => `${pageId}@${revision}`)
      .join("+");
    return String(observation.captureId || "").trim()
      || `${observation.sourceType}:${revisions}:${observation.provider || "unknown"}`;
  }

  function canonicalEvidenceGeneration(observations) {
    return Math.max(1, new Set(observations.map(observationCaptureGeneration)).size);
  }

  function deterministicSupersedesId(pageMembers, pageIndex, canonicalId) {
    const ordered = [...pageMembers].sort((left, right) => compareObservationsByPage(left, right, pageIndex));
    if (ordered.length < 2) return null;
    const anchorPageIndex = Math.min(...ordered[0].pageIds.map((pageId) => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
    const laterAnchor = ordered.find((observation) =>
      Math.min(...observation.pageIds.map((pageId) => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER)) > anchorPageIndex);
    if (!laterAnchor) return null;
    const obsoleteId = `canonical_${stableHash(laterAnchor.id)}`;
    return obsoleteId === canonicalId ? null : obsoleteId;
  }

  function applyCanonicalHistory(drafts, previousCanonicals, pageIndex, pageById) {
    const previous = (Array.isArray(previousCanonicals) ? previousCanonicals : [])
      .filter((canonical) => canonical && canonical.id)
      .map((canonical) => ({ ...canonical }));
    const unusedPrevious = new Set(previous.map((canonical) => canonical.id));
    const retired = [];
    const output = [];
    for (const draft of drafts) {
      let matched = previous.find((canonical) => unusedPrevious.has(canonical.id) && canonical.id === draft.id) || null;
      if (!matched) {
        matched = previous
          .filter((canonical) => unusedPrevious.has(canonical.id))
          .map((canonical) => ({
            canonical,
            memberOverlap: canonical.memberObservationIds?.filter((id) => draft.memberObservationIds.includes(id)).length || 0,
            geometry: canonicalGeometrySimilarity(draft, canonical, pageById)
          }))
          .filter((candidate) => candidate.memberOverlap > 0 || candidate.geometry >= 0.58)
          .sort((left, right) => right.memberOverlap - left.memberOverlap
            || right.geometry - left.geometry
            || left.canonical.id.localeCompare(right.canonical.id))[0]?.canonical || null;
      }
      const evidenceGeneration = Math.max(1, Number(draft.evidenceGeneration) || 1);
      if (!matched) {
        const { evidenceGeneration: _generation, ...publicDraft } = draft;
        output.push(deepFreeze({ ...publicDraft, revision: evidenceGeneration }));
        continue;
      }
      unusedPrevious.delete(matched.id);
      const draftEarliest = earliestPageIndexForCanonical(draft, pageIndex);
      const previousEarliest = earliestPageIndexForCanonical(matched, pageIndex);
      const earlierAnchorArrived = draftEarliest < previousEarliest;
      const stableId = earlierAnchorArrived ? draft.id : matched.id;
      const { evidenceGeneration: _generation, ...publicDraft } = draft;
      const nextDraft = { ...publicDraft, id: stableId };
      const unchanged = !earlierAnchorArrived && canonicalSignature(nextDraft) === canonicalSignature(matched);
      nextDraft.revision = unchanged
        ? Math.max(evidenceGeneration, Math.max(1, Number(matched.revision) || 1))
        : Math.max(evidenceGeneration, Math.max(1, Number(matched.revision) || 1) + 1);
      if (earlierAnchorArrived) {
        retired.push(deepFreeze({ ...matched, retiredById: nextDraft.id, published: true }));
      }
      output.push(deepFreeze(nextDraft));
    }
    for (const canonical of previous) {
      if (unusedPrevious.has(canonical.id)) {
        const successor = output.find((candidate) => candidate.supersedesId === canonical.id) || null;
        retired.push(deepFreeze({ ...canonical, retiredById: successor?.id || null, published: true }));
      }
    }
    return { canonicals: output, retiredCanonicals: retired };
  }

  function assertCoverageInvariants({ observations = [], canonicals = [], ledger = {} } = {}) {
    const errors = [];
    const ids = observations.map((observation) => observation.id);
    for (const id of ids) {
      const resolution = ledger[id];
      if (!resolution) errors.push(`unresolved:${id}`);
      else if (!["standalone", "consumed", "filtered"].includes(resolution.resolution)) errors.push(`invalid:${id}`);
    }
    for (const id of Object.keys(ledger)) {
      if (!ids.includes(id)) errors.push(`unknown:${id}`);
    }
    const memberships = new Map();
    for (const canonical of canonicals) {
      for (const id of canonical.memberObservationIds || []) {
        memberships.set(id, (memberships.get(id) || 0) + 1);
      }
    }
    for (const [id, count] of memberships) {
      if (count > 1) errors.push(`multiple_active_canonicals:${id}`);
      if (ledger[id]?.resolution === "filtered") errors.push(`filtered_is_active:${id}`);
    }
    for (const id of ids) {
      const resolution = ledger[id];
      if (resolution?.resolution !== "filtered" && (memberships.get(id) || 0) !== 1) {
        errors.push(`active_membership:${id}:${memberships.get(id) || 0}`);
      }
      if (resolution?.resolution === "filtered" && !resolution.filterReason) errors.push(`missing_filter_reason:${id}`);
    }
    if (errors.length) {
      const error = new Error(`Coverage invariants failed: ${errors.join(", ")}`);
      error.code = "KAKAO_COVERAGE_INVARIANT";
      error.details = errors;
      throw error;
    }
    return true;
  }

  function reconcileObservations({
    pages: pageInputs = [],
    observations = [],
    filteredObservations = [],
    previousCanonicals = [],
    adjacentPagePairs = [],
    adjacencyPairs = adjacentPagePairs
  } = {}) {
    const pages = sortPages(pageInputs);
    const pageById = new Map(pages.map((page) => [page.pageId, page]));
    const pageIndex = new Map(pages.map((page, index) => [page.pageId, index]));
    const activeInput = observations.map((observation) => observation?.pageSpans ? createObservation(observation) : createObservation(observation));
    const filteredInput = filteredObservations.map((observation) => createObservation(observation));
    const allById = new Map();
    for (const observation of [...activeInput, ...filteredInput]) {
      const existing = allById.get(observation.id);
      if (existing && stableSerialize(existing) !== stableSerialize(observation)) {
        throw new Error(`Conflicting Observation id: ${observation.id}`);
      }
      allById.set(observation.id, observation);
    }
    const ledgerBuilder = createCoverageLedger();
    const explicitlyFilteredIds = new Set(filteredInput.map((observation) => observation.id));
    const staleIds = new Set(activeInput.filter((observation) => !isRevisionCurrent(observation, pageById)).map((observation) => observation.id));
    const crossChapterIds = new Set(activeInput.filter((observation) => {
      const chapters = observation.pageIds.map((pageId) => pageById.get(pageId)?.chapterId).filter((value) => value !== undefined);
      return new Set(chapters).size > 1;
    }).map((observation) => observation.id));
    const seamContextOnlyIds = new Set(activeInput.filter((observation) => {
      return observation.sourceType === "seam" &&
        !hasMeaningfulCrossPageContribution(observation, observation.pageIds);
    }).map((observation) => observation.id));
    for (const observation of filteredInput.sort((left, right) => left.id.localeCompare(right.id))) {
      ledgerBuilder.resolve(observation.id, "filtered", { filterReason: observation.filterReason || "provider_filtered" });
    }
    for (const observation of activeInput.filter((item) => staleIds.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) {
      if (!ledgerBuilder.has(observation.id)) ledgerBuilder.resolve(observation.id, "filtered", { filterReason: "stale_revision" });
    }
    for (const observation of activeInput.filter((item) => crossChapterIds.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) {
      if (!ledgerBuilder.has(observation.id)) ledgerBuilder.resolve(observation.id, "filtered", { filterReason: "cross_chapter_evidence" });
    }
    for (const observation of activeInput.filter((item) => seamContextOnlyIds.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))) {
      if (!ledgerBuilder.has(observation.id)) ledgerBuilder.resolve(observation.id, "filtered", { filterReason: "seam_context_only" });
    }
    const active = activeInput
      .filter((observation) =>
        !explicitlyFilteredIds.has(observation.id) &&
        !staleIds.has(observation.id) &&
        !crossChapterIds.has(observation.id) &&
        !seamContextOnlyIds.has(observation.id)
      )
      .filter((observation, index, array) => array.findIndex((item) => item.id === observation.id) === index)
      .sort((left, right) => left.id.localeCompare(right.id));
    const pageObservations = active.filter((observation) => observation.sourceType === "page");
    const seamObservations = active.filter((observation) => observation.sourceType === "seam");
    const observationById = new Map(active.map((observation) => [observation.id, observation]));
    const unionFind = createUnionFind(pageObservations);
    const confirmedAdjacencyPairs = normalizeAdjacencyPairs(adjacencyPairs);
    const edges = buildCandidateEdges(
      pageObservations,
      seamObservations,
      pages,
      pageById,
      confirmedAdjacencyPairs
    );
    const acceptedEdges = [];
    const reviewEdges = [];
    for (const edge of edges) {
      if (edge.score >= MERGE_THRESHOLD
        && edge.adjacencyConfirmed
        && canUnionComponents(unionFind, edge.upperId, edge.lowerId, observationById, pageById)) {
        unionFind.union(edge.upperId, edge.lowerId);
        acceptedEdges.push(edge);
      } else if (edge.score >= REVIEW_THRESHOLD) {
        reviewEdges.push({
          ...edge,
          reason: !edge.adjacencyConfirmed ? "unconfirmed_adjacency"
            : edge.score >= MERGE_THRESHOLD ? "component_constraint" : "ambiguous_score"
        });
      }
    }

    const componentByRoot = new Map();
    for (const observation of pageObservations) {
      const root = unionFind.find(observation.id);
      componentByRoot.set(root, componentByRoot.get(root) || []);
      componentByRoot.get(root).push(observation);
    }
    const componentSeams = new Map(Array.from(componentByRoot.keys()).map((root) => [root, []]));
    const explicitlySupported = new Map();
    for (const edge of acceptedEdges) {
      const root = unionFind.find(edge.upperId);
      for (const seamId of edge.supportingSeamIds) explicitlySupported.set(seamId, root);
    }
    for (const seam of seamObservations) {
      let root = explicitlySupported.get(seam.id) || null;
      if (!root) {
        const candidates = Array.from(componentByRoot.entries())
          .map(([candidateRoot, members]) => ({
            root: candidateRoot,
            members,
            score: Math.max(0, ...members.map((member) => relationBetweenSeamAndPage(seam, member, pageById)))
          }))
          .filter((candidate) => candidate.score >= 0.50 && canAttachSeamToComponent(seam, candidate.members, pageById))
          .sort((left, right) => right.score - left.score || left.root.localeCompare(right.root));
        root = candidates[0]?.root || null;
      }
      if (root && componentSeams.has(root)) componentSeams.get(root).push(seam);
      else {
        const seamRoot = `seam:${seam.id}`;
        componentByRoot.set(seamRoot, []);
        componentSeams.set(seamRoot, [seam]);
      }
    }

    const reviewObservationIds = new Set(reviewEdges.flatMap((edge) => [edge.upperId, edge.lowerId]));
    const drafts = [];
    for (const [root, pageMembers] of componentByRoot) {
      const seamMembers = componentSeams.get(root) || [];
      const members = [...pageMembers, ...seamMembers].sort((left, right) => compareObservationsByPage(left, right, pageIndex));
      if (!members.length) continue;
      const memberIds = members.map((observation) => observation.id).sort();
      const componentEdges = acceptedEdges.filter((edge) => memberIds.includes(edge.upperId) && memberIds.includes(edge.lowerId));
      const anchor = pageMembers.length
        ? [...pageMembers].sort((left, right) => compareObservationsByPage(left, right, pageIndex))[0]
        : members[0];
      const geometryByPage = geometryByPageForMembers(members, pageIndex);
      const originalText = chooseCanonicalText(members, componentEdges, pageIndex);
      const status = pageMembers.some((member) => reviewObservationIds.has(member.id)) && componentEdges.length === 0
        ? "needs_review"
        : originalText ? "ready" : "filtered";
      const canonicalId = `canonical_${stableHash(anchor.id)}`;
      drafts.push({
        id: canonicalId,
        revision: 1,
        supersedesId: deterministicSupersedesId(pageMembers, pageIndex, canonicalId),
        memberObservationIds: memberIds,
        originalText,
        nonTranslate: members.every((member) => member.visual && member.visual.nonTranslate === true),
        geometryByPage,
        status,
        translationFingerprint: `text_${stableHash(normalizeText(originalText))}`,
        evidenceGeneration: canonicalEvidenceGeneration(members)
      });
    }
    drafts.sort((left, right) => earliestPageIndexForCanonical(left, pageIndex) - earliestPageIndexForCanonical(right, pageIndex)
      || stableSerialize(left.geometryByPage).localeCompare(stableSerialize(right.geometryByPage))
      || left.id.localeCompare(right.id));
    const history = applyCanonicalHistory(drafts, previousCanonicals, pageIndex, pageById);
    const canonicalByMember = new Map();
    for (const canonical of history.canonicals) {
      for (const observationId of canonical.memberObservationIds) canonicalByMember.set(observationId, canonical);
    }
    for (const canonical of history.canonicals) {
      const members = canonical.memberObservationIds
        .map((id) => observationById.get(id))
        .filter(Boolean)
        .sort((left, right) => compareObservationsByPage(left, right, pageIndex));
      const isStandaloneCanonical = members.length === 1;
      for (const member of members) {
        ledgerBuilder.resolve(member.id, isStandaloneCanonical ? "standalone" : "consumed", {
          canonicalId: canonical.id,
          canonicalRevision: canonical.revision
        });
      }
    }
    const ledger = ledgerBuilder.toJSON();
    const allObservations = Array.from(allById.values()).sort((left, right) => left.id.localeCompare(right.id));
    assertCoverageInvariants({ observations: allObservations, canonicals: history.canonicals, ledger });
    return deepFreeze({
      modelVersion: RECONCILE_MODEL_VERSION,
      canonicals: history.canonicals,
      retiredCanonicals: history.retiredCanonicals,
      ledger,
      diagnostics: {
        acceptedEdges: acceptedEdges.map((edge) => ({ ...edge })),
        needsReview: reviewEdges.map((edge) => ({ ...edge })),
        rejectedEdgeCount: Math.max(0, edges.length - acceptedEdges.length - reviewEdges.length)
      }
    });
  }

  function geometryAreaOnPage(geometries, page) {
    const boxes = (geometries || [])
      .map((geometry) => boxInNormalizedPage(geometry, page))
      .filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return 0;
    const xs = Array.from(new Set(boxes.flatMap((box) => [box.left, box.left + box.width]))).sort((left, right) => left - right);
    let area = 0;
    for (let index = 0; index < xs.length - 1; index += 1) {
      const left = xs[index];
      const right = xs[index + 1];
      if (right <= left) continue;
      const intervals = boxes
        .filter((box) => box.left < right && box.left + box.width > left)
        .map((box) => [box.top, box.top + box.height])
        .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
      let coveredY = 0;
      let current = null;
      for (const interval of intervals) {
        if (!current || interval[0] > current[1]) {
          if (current) coveredY += current[1] - current[0];
          current = [...interval];
        } else {
          current[1] = Math.max(current[1], interval[1]);
        }
      }
      if (current) coveredY += current[1] - current[0];
      area += (right - left) * coveredY;
    }
    return area;
  }

  function unionGeometry(geometries) {
    const boxes = (geometries || []).map((geometry) => normalizeBox(geometry.box));
    if (!boxes.length) return normalizeBox({});
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.left + box.width));
    const bottom = Math.max(...boxes.map((box) => box.top + box.height));
    return normalizeBox({ left, top, width: right - left, height: bottom - top });
  }

  function chooseProjectionEvidence(geometries) {
    return [...(geometries || [])].sort((left, right) => {
      const leftVisualConfidence = Number(left.visual?.bgConfidence ?? left.visual?.bg_confidence ?? 0) || 0;
      const rightVisualConfidence = Number(right.visual?.bgConfidence ?? right.visual?.bg_confidence ?? 0) || 0;
      const leftQuality = clamp(left.confidence, 0, 1) * 0.65
        + clamp(leftVisualConfidence, 0, 1) * 0.25
        + (left.sourceType === "page" ? 0.10 : 0);
      const rightQuality = clamp(right.confidence, 0, 1) * 0.65
        + clamp(rightVisualConfidence, 0, 1) * 0.25
        + (right.sourceType === "page" ? 0.10 : 0);
      const pageSourceOrder = (right.sourceType === "page" ? 1 : 0) - (left.sourceType === "page" ? 1 : 0);
      return pageSourceOrder
        || rightQuality - leftQuality
        || Array.from(String(right.originalText || "")).length - Array.from(String(left.originalText || "")).length
        || String(left.observationId || "").localeCompare(String(right.observationId || ""));
    })[0] || null;
  }

  function projectionVisualForEvidence(evidence, fallbackBox) {
    const raw = evidence?.visual && typeof evidence.visual === "object" ? evidence.visual : {};
    if (evidence?.sourceType !== "seam") return raw;
    const mappedBox = evidence?.box ? normalizeBox(evidence.box) : fallbackBox;
    const mappedPolygon = Array.isArray(evidence?.polygon) && evidence.polygon.length
      ? evidence.polygon.map((point) => ({ x: point.x, y: point.y }))
      : null;
    // seam visual 的 fillBox/polygon 属于接缝画布；只继承非几何样式，
    // 几何一律替换为已经映射回页面的 pageSpan。
    return {
      bgType: raw.bgType ?? raw.bg_type,
      bg_type: raw.bg_type ?? raw.bgType,
      bgColor: raw.bgColor ?? raw.bg_color,
      bg_color: raw.bg_color ?? raw.bgColor,
      bgConfidence: raw.bgConfidence ?? raw.bg_confidence,
      bg_confidence: raw.bg_confidence ?? raw.bgConfidence,
      regionId: raw.regionId ?? raw.region_id,
      region_id: raw.region_id ?? raw.regionId,
      regionType: raw.regionType ?? raw.region_type,
      region_type: raw.region_type ?? raw.regionType,
      textColor: raw.textColor ?? raw.text_color,
      text_color: raw.text_color ?? raw.textColor,
      strokeColor: raw.strokeColor ?? raw.stroke_color,
      stroke_color: raw.stroke_color ?? raw.strokeColor,
      alignment: raw.alignment,
      fontWeight: raw.fontWeight ?? raw.font_weight,
      font_weight: raw.font_weight ?? raw.fontWeight,
      translationRole: raw.translationRole ?? raw.translation_role,
      translation_role: raw.translation_role ?? raw.translationRole,
      rotationDeg: raw.rotationDeg ?? raw.rotation_deg,
      rotation_deg: raw.rotation_deg ?? raw.rotationDeg,
      sourceLineCount: raw.sourceLineCount ?? raw.source_line_count,
      source_line_count: raw.source_line_count ?? raw.sourceLineCount,
      fillBox: mappedBox,
      fill_box: mappedBox,
      polygon: mappedPolygon,
      regionPolygon: mappedPolygon,
      region_polygon: mappedPolygon
    };
  }

  function readTranslation(translations, canonical) {
    const key = `${canonical.id}@${canonical.revision}`;
    const value = translations instanceof Map
      ? translations.get(key) ?? translations.get(canonical.id)
      : translations?.[key] ?? translations?.[canonical.id];
    if (typeof value === "string") return value;
    return String(
      value?.translatedText
      ?? value?.translated_text
      ?? canonical.translation?.translatedText
      ?? canonical.translation?.translated_text
      ?? canonical.translatedText
      ?? canonical.translated_text
      ?? ""
    );
  }

  function buildRenderProjections({ pages: pageInputs = [], canonicals = [], availablePageIds, translations = {} } = {}) {
    const pages = sortPages(pageInputs);
    const pageById = new Map(pages.map((page) => [page.pageId, page]));
    const pageIndex = new Map(pages.map((page, index) => [page.pageId, index]));
    const available = availablePageIds == null ? new Set(pages.map((page) => page.pageId)) : new Set(availablePageIds);
    const projections = [];
    for (const canonical of canonicals) {
      const pageIds = Object.keys(canonical.geometryByPage || {})
        .filter((pageId) => pageById.has(pageId))
        .sort((left, right) => pageIndex.get(left) - pageIndex.get(right) || left.localeCompare(right));
      if (!pageIds.length) continue;
      const preferredPrimaryPageId = [...pageIds].sort((left, right) => {
        const areaDifference = geometryAreaOnPage(canonical.geometryByPage[right], pageById.get(right))
          - geometryAreaOnPage(canonical.geometryByPage[left], pageById.get(left));
        return (Math.abs(areaDifference) > 1e-9 ? areaDifference : 0)
          || pageIndex.get(left) - pageIndex.get(right)
          || left.localeCompare(right);
      })[0];
      const activePageId = available.has(preferredPrimaryPageId)
        ? preferredPrimaryPageId
        : pageIds.find((pageId) => available.has(pageId)) || null;
      const translatedText = readTranslation(translations, canonical);
      function addProjection(pageId, role, activeText, active, coverOnly) {
        const geometries = canonical.geometryByPage[pageId];
        const box = unionGeometry(geometries);
        const evidence = chooseProjectionEvidence(geometries);
        const visualBox = evidence?.box ? normalizeBox(evidence.box) : box;
        const visual = projectionVisualForEvidence(evidence, visualBox);
        const projectionId = `projection_${stableHash([canonical.id, canonical.revision, pageId, role])}`;
        projections.push(deepFreeze({
          id: projectionId,
          projectionId,
          canonicalId: canonical.id,
          canonicalRevision: canonical.revision,
          revision: canonical.revision,
          pageId,
          preferredPrimaryPageId,
          role,
          active,
          activeText,
          coverOnly,
          originalText: canonical.originalText,
          original_text: canonical.originalText,
          translatedText: activeText ? translatedText : "",
          translated_text: activeText ? translatedText : "",
          geometry: box,
          box,
          visualBox,
          visual,
          geometries,
          bubble: {
            block_id: `${canonical.id}:${role}`,
            canonical_id: canonical.id,
            canonical_revision: canonical.revision,
            original_text: canonical.originalText,
            translated_text: activeText ? translatedText : "",
            x: box.left,
            y: box.top,
            w: box.width,
            h: box.height,
            visual,
            fill_box: visual.fill_box || visual.fillBox || visualBox,
            bg_type: visual.bg_type || visual.bgType || "none",
            bg_color: visual.bg_color || visual.bgColor || "",
            bg_confidence: Number(visual.bg_confidence || visual.bgConfidence || 0),
            region_id: String(visual.region_id || visual.regionId || ""),
            region_type: String(visual.region_type || visual.regionType || "plain_text"),
            region_polygon: visual.region_polygon || visual.regionPolygon || null,
            polygon: visual.polygon || null,
            font_weight: visual.font_weight || visual.fontWeight || 0,
            translation_role: visual.translation_role || visual.translationRole || "",
            projection_role: role,
            projection_active: active,
            cover_only: coverOnly
          }
        }));
      }
      for (const pageId of pageIds) {
        if (pageId === preferredPrimaryPageId) {
          addProjection(pageId, "primary", pageId === activePageId, pageId === activePageId, false);
          continue;
        }
        // 非主页面始终保留 cover；standby 只在主页面缺席时接管文本。
        addProjection(pageId, "cover", false, available.has(pageId), true);
        addProjection(pageId, "standby", pageId === activePageId, pageId === activePageId, false);
      }
    }
    return deepFreeze(projections.sort((left, right) =>
      (pageIndex.get(left.pageId) ?? 0) - (pageIndex.get(right.pageId) ?? 0)
      || left.geometry.top - right.geometry.top
      || left.geometry.left - right.geometry.left
      || left.canonicalId.localeCompare(right.canonicalId)));
  }

  function createCanonicalStore() {
    const pages = new Map();
    const pageHandles = new Map();
    const pageObservations = new Map();
    const seamObservations = new Map();
    const filteredByCapture = new Map();
    const translations = new Map();
    const completedSeamPairs = new Set();
    const inflight = new Map();
    let snapshot = deepFreeze({ canonicals: [], retiredCanonicals: [], ledger: {}, diagnostics: {} });
    let projections = [];
    let serial = Promise.resolve();

    function orderedPages() {
      return sortPages(Array.from(pages.values()));
    }
    function allObservations() {
      return [...Array.from(pageObservations.values()).flat(), ...Array.from(seamObservations.values()).flat()];
    }
    function allFiltered() {
      return Array.from(filteredByCapture.values()).flat();
    }
    function mergeByObservationId(previous, next) {
      return Array.from(new Map([...previous, ...next].map((observation) => [observation.id, observation])).values())
        .sort((left, right) => left.id.localeCompare(right.id));
    }
    function transact(factory) {
      const run = serial.then(() => factory());
      serial = run.catch(() => undefined);
      return run;
    }
    return {
      upsertPage(page) {
        const normalized = normalizePage(page, pages.size);
        pages.set(normalized.pageId, normalized);
        return normalized;
      },
      getPage(pageId) { return pages.get(String(pageId)) || null; },
      getPages() { return orderedPages(); },
      bindPageHandle(pageId, handle) {
        pageHandles.set(String(pageId), handle);
      },
      unbindPageHandle(pageId, handle) {
        const id = String(pageId);
        if (!pageHandles.has(id) || (handle !== undefined && pageHandles.get(id) !== handle)) return false;
        pageHandles.delete(id);
        return true;
      },
      getPageHandle(pageId) { return pageHandles.get(String(pageId)) || null; },
      setPageObservations(pageId, values, filtered = []) {
        const id = String(pageId);
        pageObservations.set(id, mergeByObservationId(pageObservations.get(id) || [], values.map(createObservation)));
        const filterKey = `page:${id}`;
        filteredByCapture.set(filterKey, mergeByObservationId(filteredByCapture.get(filterKey) || [], filtered.map(createObservation)));
      },
      setSeamObservations(pairKey, values, filtered = []) {
        seamObservations.set(String(pairKey), values.map(createObservation));
        filteredByCapture.set(`seam:${pairKey}`, filtered.map(createObservation));
        completedSeamPairs.add(String(pairKey));
      },
      hasCompletedSeamPair(pairKey) { return completedSeamPairs.has(String(pairKey)); },
      markSeamPairComplete(pairKey) { completedSeamPairs.add(String(pairKey)); },
      getObservations() { return allObservations(); },
      getFilteredObservations() { return allFiltered(); },
      runSerialized(factory) { return transact(() => factory(this)); },
      reconcile() {
        snapshot = reconcileObservations({
          pages: orderedPages(),
          observations: allObservations(),
          filteredObservations: allFiltered(),
          previousCanonicals: snapshot.canonicals
        });
        projections = buildRenderProjections({
          pages: orderedPages(),
          canonicals: snapshot.canonicals,
          availablePageIds: Array.from(pageHandles.keys()),
          translations
        });
        return snapshot;
      },
      getSnapshot() { return snapshot; },
      setTranslation(id, revision, value) {
        translations.set(`${id}@${revision}`, value);
      },
      getTranslation(id, revision) { return translations.get(`${id}@${revision}`) || null; },
      rebuildProjections() {
        projections = buildRenderProjections({
          pages: orderedPages(),
          canonicals: snapshot.canonicals,
          availablePageIds: Array.from(pageHandles.keys()),
          translations
        });
        return projections;
      },
      getProjections(pageId) {
        return projections.filter((projection) => !pageId || projection.pageId === pageId);
      },
      getOrCreateInflight(key, factory) {
        const stableKey = String(key);
        if (inflight.has(stableKey)) return inflight.get(stableKey);
        const promise = Promise.resolve().then(factory).finally(() => {
          if (inflight.get(stableKey) === promise) inflight.delete(stableKey);
        });
        inflight.set(stableKey, promise);
        return promise;
      },
      reset() {
        pages.clear();
        pageHandles.clear();
        pageObservations.clear();
        seamObservations.clear();
        filteredByCapture.clear();
        translations.clear();
        completedSeamPairs.clear();
        inflight.clear();
        snapshot = deepFreeze({ canonicals: [], retiredCanonicals: [], ledger: {}, diagnostics: {} });
        projections = [];
        serial = Promise.resolve();
      }
    };
  }

  const api = Object.freeze({
    RECONCILE_MODEL_VERSION,
    GEOMETRY_WEIGHT,
    VISUAL_WEIGHT,
    SEAM_WEIGHT,
    TEXT_WEIGHT,
    MERGE_THRESHOLD,
    REVIEW_THRESHOLD,
    MAX_COMPONENT_PAGES,
    DEFAULT_EDGE_WAIT_MS,
    MIN_SEAM_PAGE_CONTRIBUTION,
    clamp,
    normalizeText,
    stableHash,
    normalizeStableImageSource,
    buildChapterId,
    buildPageId,
    createObservation,
    calculateSeamBandHeight,
    computeSeamBandHeight: calculateSeamBandHeight,
    buildSeamPairKey,
    buildSeamPlan,
    evaluateSeamEvidence,
    shouldRunSeamOcr: (input) => evaluateSeamEvidence(input).shouldRun,
    textSimilarity,
    joinContinuationText,
    createCoverageLedger,
    assertCoverageInvariants,
    reconcileObservations,
    reconcile: reconcileObservations,
    buildRenderProjections,
    createCanonicalStore
  });

  globalThis.MangaTranslatorKakaoReconciler = api;
})();
