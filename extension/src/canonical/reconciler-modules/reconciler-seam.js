export function installReconcilerSeam(runtime) {
  function boxInNormalizedPage(span, page) {
    const box = runtime.normalizeBox(span?.box || runtime.polygonBox(span?.polygon));
    const coordinateSpace = String(span?.coordinateSpace || "auto").toLowerCase();
    const looksNormalized = coordinateSpace === "normalized" || coordinateSpace === "ratio";
    const looksPercent = coordinateSpace === "percent" || coordinateSpace === "auto" && Math.max(Math.abs(box.left), Math.abs(box.top), box.width, box.height) <= 100.0001;
    const divisorX = looksNormalized ? 1 : looksPercent ? 100 : page.width;
    const divisorY = looksNormalized ? 1 : looksPercent ? 100 : page.height;
    return {
      left: box.left / divisorX,
      top: box.top / divisorY,
      width: box.width / divisorX,
      height: box.height / divisorY
    };
  }
  runtime.boxInNormalizedPage = boxInNormalizedPage;
  function getSpan(observation, pageId) {
    return observation?.pageSpans?.find(span => span.pageId === pageId) || null;
  }
  runtime.getSpan = getSpan;
  function isSpanAtEdge(span, page, edge, bandHeight) {
    if (!span || !page) return false;
    const box = runtime.boxInNormalizedPage(span, page);
    const bandRatio = Math.min(1, bandHeight / page.height);
    if (edge === "bottom") return box.top + box.height >= 1 - bandRatio;
    return box.top <= bandRatio;
  }
  runtime.isSpanAtEdge = isSpanAtEdge;
  function observationTouchesEdge(observation, page, edge, bandHeight) {
    if (!observation?.pageIds?.includes(page.pageId)) return false;
    return runtime.isSpanAtEdge(runtime.getSpan(observation, page.pageId), page, edge, bandHeight);
  }
  runtime.observationTouchesEdge = observationTouchesEdge;
  function hasSignalForPage(edgeSignals, pageId, edge) {
    function detected(value) {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value > 0;
      if (Array.isArray(value)) return value.length > 0 && value.some(item => detected(item));
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
      return edgeSignals.some(signal => {
        if (!signal || typeof signal !== "object") return Boolean(signal);
        return (!signal.pageId || signal.pageId === pageId) && (!signal.edge || signal.edge === edge) && detected(signal);
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
  runtime.hasSignalForPage = hasSignalForPage;
  function evaluateSeamEvidence({
    pageA: pageAInput,
    pageB: pageBInput,
    observations = [],
    filteredObservations = [],
    edgeSignals,
    overlapRisk
  } = {}) {
    const [pageA, pageB] = [runtime.normalizePage(pageAInput, 0), runtime.normalizePage(pageBInput, 1)].sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    const bandHeight = runtime.calculateSeamBandHeight(pageA.width, pageB.width);
    const reasons = [];
    const pageById = new Map([[pageA.pageId, pageA], [pageB.pageId, pageB]]);
    const allObservations = [...observations, ...filteredObservations].map(observation => observation?.pageSpans ? observation : runtime.createObservation(observation)).filter(observation => runtime.isRevisionCurrent(observation, pageById));
    if (allObservations.some(observation => runtime.observationTouchesEdge(observation, pageA, "bottom", bandHeight))) {
      reasons.push("upper_ocr_edge");
    }
    if (allObservations.some(observation => runtime.observationTouchesEdge(observation, pageB, "top", bandHeight))) {
      reasons.push("lower_ocr_edge");
    }
    if (runtime.hasSignalForPage(edgeSignals, pageA.pageId, "bottom")) reasons.push("upper_visual_edge");
    if (runtime.hasSignalForPage(edgeSignals, pageB.pageId, "top")) reasons.push("lower_visual_edge");
    if (pageA.shortPage || pageB.shortPage) reasons.push("short_page");
    if (overlapRisk === true || overlapRisk?.detected || overlapRisk?.accepted || overlapRisk?.risk || overlapRisk?.fragmentRisk || Number(overlapRisk?.overlapPixels) > 0 || Number(overlapRisk?.ratio) > 0 || Number(overlapRisk?.rows) > 0 || Array.isArray(overlapRisk?.rows) && overlapRisk.rows.length > 0) {
      reasons.push(overlapRisk?.fragmentRisk ? "fragment_structure" : "pixel_overlap");
    }
    const uniqueReasons = Array.from(new Set(reasons)).sort();
    return runtime.deepFreeze({
      shouldRun: uniqueReasons.length > 0,
      reasons: uniqueReasons,
      pairKey: runtime.buildSeamPairKey(pageA, pageB),
      bandHeight
    });
  }
  runtime.evaluateSeamEvidence = evaluateSeamEvidence;
  function isRevisionCurrent(observation, pageById) {
    for (const pageId of observation.pageIds) {
      const page = pageById.get(pageId);
      if (!page) return false;
      if (page.imageRevision && observation.imageRevisionByPage?.[pageId] !== page.imageRevision) return false;
    }
    return true;
  }
  runtime.isRevisionCurrent = isRevisionCurrent;
  function intersectionArea(left, right) {
    const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
    return width * height;
  }
  runtime.intersectionArea = intersectionArea;
  function overlapOverSmaller(left, right) {
    const denominator = Math.min(left.width * left.height, right.width * right.height);
    return denominator > 0 ? runtime.intersectionArea(left, right) / denominator : 0;
  }
  runtime.overlapOverSmaller = overlapOverSmaller;
  function horizontalRelation(left, right) {
    const overlap = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
    const overlapRatio = overlap / Math.max(0.0001, Math.min(left.width, right.width));
    const leftCenter = left.left + left.width / 2;
    const rightCenter = right.left + right.width / 2;
    const centerDistance = Math.abs(leftCenter - rightCenter);
    const centerScore = 1 - runtime.clamp(centerDistance / Math.max(0.0001, Math.max(left.width, right.width) * 1.5), 0, 1);
    return {
      overlapRatio: runtime.clamp(overlapRatio, 0, 1),
      centerScore: runtime.clamp(centerScore, 0, 1),
      centerDistance
    };
  }
  runtime.horizontalRelation = horizontalRelation;
  function regionTypeOf(observation, span) {
    return String(span?.regionType || observation?.visual?.regionType || observation?.visual?.region_type || "").trim().toLowerCase();
  }
  runtime.regionTypeOf = regionTypeOf;
  function regionsCompatible(leftObservation, leftSpan, rightObservation, rightSpan) {
    const left = runtime.regionTypeOf(leftObservation, leftSpan);
    const right = runtime.regionTypeOf(rightObservation, rightSpan);
    return !left || !right || left === right;
  }
  runtime.regionsCompatible = regionsCompatible;
  function diceSimilarity(leftText, rightText) {
    const left = Array.from(runtime.normalizeComparableText(leftText));
    const right = Array.from(runtime.normalizeComparableText(rightText));
    if (!left.length || !right.length) return 0;
    if (left.join("") === right.join("")) return 1;
    if (left.length === 1 || right.length === 1) return left.some(char => right.includes(char)) ? 0.5 : 0;
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
    return 2 * matches / (left.length - 1 + (right.length - 1));
  }
  runtime.diceSimilarity = diceSimilarity;
  function textSimilarity(leftText, rightText) {
    const left = runtime.normalizeComparableText(leftText);
    const right = runtime.normalizeComparableText(rightText);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    const containment = longer.includes(shorter) ? shorter.length / longer.length : 0;
    return runtime.clamp(Math.max(containment, runtime.diceSimilarity(left, right)), 0, 1);
  }
  runtime.textSimilarity = textSimilarity;
  function fuzzyFragmentSimilarity(leftText, rightText) {
    const normalizeFragment = value => Array.from(runtime.normalizeComparableText(value).replace(runtime.FUZZY_OCR_QUOTE_RE, "").normalize("NFD"));
    const left = normalizeFragment(leftText);
    const right = normalizeFragment(rightText);
    if (!left.length || !right.length) return 0;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    if (shorter.length < runtime.FUZZY_SEAM_FRAGMENT_MIN_LENGTH) return 0;
    const editDistance = (first, second) => {
      let previous = Array.from({
        length: second.length + 1
      }, (_, index) => index);
      for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
        const current = [firstIndex];
        for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
          const substitution = previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1);
          current[secondIndex] = Math.min(previous[secondIndex] + 1, current[secondIndex - 1] + 1, substitution);
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
    return runtime.clamp(best, 0, 1);
  }
  runtime.fuzzyFragmentSimilarity = fuzzyFragmentSimilarity;
  function fuzzyBoundaryFragmentSimilarity(pageText, seamText, edge) {
    const page = Array.from(runtime.normalizeComparableText(pageText));
    if (page.length < 2) return 0;
    const minimum = Math.min(4, page.length);
    const maximum = Math.min(14, page.length);
    let best = 0;
    for (let length = minimum; length <= maximum; length += 1) {
      const fragment = edge === "prefix" ? page.slice(0, length) : page.slice(page.length - length);
      best = Math.max(best, runtime.fuzzyFragmentSimilarity(fragment.join(""), seamText));
    }
    return best;
  }
  runtime.fuzzyBoundaryFragmentSimilarity = fuzzyBoundaryFragmentSimilarity;
  function suffixPrefixOverlap(leftText, rightText) {
    const left = Array.from(runtime.normalizeText(leftText));
    const right = Array.from(runtime.normalizeText(rightText));
    const max = Math.min(left.length, right.length);
    for (let length = max; length >= 1; length -= 1) {
      if (left.slice(left.length - length).join("") === right.slice(0, length).join("")) return length;
    }
    return 0;
  }
  runtime.suffixPrefixOverlap = suffixPrefixOverlap;
  // 两个组件已分别通过原子约束；续接时仅验证这次合并新增的同页几何冲突。
  function canUnionContinuationBridge(unionFind, leftId, rightId, observationById, pageById) {
    const left = [...unionFind.getMembers(leftId)].map(id => observationById.get(id)).filter(Boolean);
    const right = [...unionFind.getMembers(rightId)].map(id => observationById.get(id)).filter(Boolean);
    const observations = [...left, ...right];
    const pageIds = [...new Set(observations.flatMap(observation => observation.pageIds))];
    const pages = pageIds.map(pageId => pageById.get(pageId)).filter(Boolean).sort(
      (first, second) => first.readingOrder - second.readingOrder || first.pageId.localeCompare(second.pageId)
    );
    if (!left.length || !right.length || !pages.length || pages.length !== pageIds.length ||
        pages.length > runtime.MAX_COMPONENT_PAGES ||
        new Set(pages.map(page => page.chapterId)).size > 1) return false;
    for (const page of pages) {
      const leftOnPage = left.filter(observation => observation.pageIds.includes(page.pageId));
      const rightOnPage = right.filter(observation => observation.pageIds.includes(page.pageId));
      for (const leftObservation of leftOnPage) {
        for (const rightObservation of rightOnPage) {
          const leftBox = runtime.boxInNormalizedPage(runtime.getSpan(leftObservation, page.pageId), page);
          const rightBox = runtime.boxInNormalizedPage(runtime.getSpan(rightObservation, page.pageId), page);
          if (runtime.overlapOverSmaller(leftBox, rightBox) < 0.35) return false;
        }
      }
    }
    if (pages.length === 3) {
      const [previous, middle, next] = pages;
      const middleObservations = observations.filter(item => item.pageIds.includes(middle.pageId));
      const bandHeight = runtime.calculateSeamBandHeight(Math.min(previous.width, middle.width), Math.min(middle.width, next.width));
      if (!middle.shortPage && !runtime.spanTouchesBothEdges(middleObservations, middle, bandHeight)) return false;
    }
    return true;
  }
  runtime.canUnionContinuationBridge = canUnionContinuationBridge;
  // seam 可能只覆盖上一页尾句与下一页长句的公共前缀；必须同时满足页边、文本和几何约束才视为续接。
  function seamPageContinuationRelation(seam, pageObservation, pageById) {
    if (seam?.sourceType !== "seam" || pageObservation?.sourceType !== "page" || !runtime.hasMeaningfulCrossPageContribution(seam, seam.pageIds)) return null;
    const orderedSeamPages = seam.pageIds.map(pageId => pageById.get(pageId)).filter(Boolean).sort((left, right) => left.readingOrder - right.readingOrder || left.pageId.localeCompare(right.pageId));
    if (orderedSeamPages.length < 2) return null;
    const seamText = runtime.normalizeComparableText(seam.originalText);
    const pageText = runtime.normalizeComparableText(pageObservation.originalText);
    if (!seamText || !pageText) return null;
    const minimumTextLength = Math.min(Array.from(seamText).length, Array.from(pageText).length);
    const minimumOverlap = Math.max(2, Math.ceil(minimumTextLength * 0.35));
    const candidates = [];
    for (const pageId of pageObservation.pageIds.filter(value => seam.pageIds.includes(value))) {
      const page = pageById.get(pageId);
      const seamSpan = runtime.getSpan(seam, pageId);
      const pageSpan = runtime.getSpan(pageObservation, pageId);
      if (!page || !seamSpan || !pageSpan) continue;
      const isUpperEdge = pageId === orderedSeamPages[0].pageId;
      const isLowerEdge = pageId === orderedSeamPages[orderedSeamPages.length - 1].pageId;
      if (!isUpperEdge && !isLowerEdge) continue;
      const edge = isLowerEdge ? "top" : "bottom";
      const bandHeight = runtime.calculateSeamBandHeight(page.width, page.width);
      if (!runtime.observationTouchesEdge(pageObservation, page, edge, bandHeight)) continue;
      const direction = isLowerEdge ? "seam_then_page" : "page_then_seam";
      const textOverlap = direction === "seam_then_page" ? runtime.suffixPrefixOverlap(seamText, pageText) : runtime.suffixPrefixOverlap(pageText, seamText);
      if (textOverlap < minimumOverlap) continue;
      const seamBox = runtime.boxInNormalizedPage(seamSpan, page);
      const pageBox = runtime.boxInNormalizedPage(pageSpan, page);
      const geometry = runtime.overlapOverSmaller(seamBox, pageBox);
      if (geometry < 0.35 && !runtime.hasSharedVisualIdentity(seam, pageObservation)) continue;
      const textScore = runtime.clamp(textOverlap / Math.max(1, minimumTextLength), 0, 1);
      const classifierDrift = !runtime.regionsCompatible(seam, seamSpan, pageObservation, pageSpan);
      // 页缝会把同一段标题分别判成 effect_text / caption_panel。只有公共行和几何都足够强时
      // 才允许跨过分类差异，普通的异类相邻文字仍保持硬边界。
      if (classifierDrift && (geometry < 0.55 || textScore < 0.40)) continue;
      candidates.push({
        classifierDrift,
        direction,
        geometry,
        pageId,
        score: runtime.clamp(geometry * 0.75 + textScore * 0.25, 0, 1),
        textOverlap,
        textScore
      });
    }
    return candidates.sort((left, right) => right.score - left.score || right.textOverlap - left.textOverlap || left.pageId.localeCompare(right.pageId))[0] || null;
  }
  runtime.seamPageContinuationRelation = seamPageContinuationRelation;
  function joinContinuationText(leftText, rightText) {
    const left = runtime.normalizeText(leftText);
    const right = runtime.normalizeText(rightText);
    if (!left) return right;
    if (!right) return left;
    if (left.includes(right)) return left;
    if (right.includes(left)) return right;
    const overlap = runtime.suffixPrefixOverlap(left, right);
    return `${left}${right.slice(overlap)}`;
  }
  runtime.joinContinuationText = joinContinuationText;
  function hasStrongTextRelation(leftText, rightText) {
    const left = runtime.normalizeComparableText(leftText);
    const right = runtime.normalizeComparableText(rightText);
    if (!left || !right) return false;
    if (runtime.textSimilarity(left, right) >= 0.55) return true;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    if (shorter.length >= 2 && longer.includes(shorter)) return true;
    const overlap = Math.max(runtime.suffixPrefixOverlap(left, right), runtime.suffixPrefixOverlap(right, left));
    if (overlap >= Math.max(2, Math.ceil(Math.min(left.length, right.length) * 0.45))) return true;
    // OCR 在跨页边缘容易把一个韩文字形识错，或多带一个引号。只对足够长的
    // seam 片段做近似子串比较；保留数学、货币等语义符号，避免误合并。
    return runtime.fuzzyFragmentSimilarity(left, right) >= runtime.FUZZY_SEAM_FRAGMENT_THRESHOLD;
  }
  runtime.hasStrongTextRelation = hasStrongTextRelation;
  function visualIdentity(value) {
    const visual = value?.visual || {};
    // regionId 只在一次 OCR 捕获内有意义，不能当作跨捕获的视觉身份。
    return String(visual.regionHash || visual.region_hash || visual.visualHash || visual.visual_hash || visual.hash || "");
  }
  runtime.visualIdentity = visualIdentity;
  function hasSharedVisualIdentity(...observations) {
    const identities = observations.map(runtime.visualIdentity);
    return identities.length > 1 && identities.every(Boolean) && identities.every(identity => identity === identities[0]);
  }
  runtime.hasSharedVisualIdentity = hasSharedVisualIdentity;
  function seamContributionByPage(observation) {
    const contributions = new Map();
    for (const span of Array.isArray(observation?.pageSpans) ? observation.pageSpans : []) {
      const pageId = String(span?.pageId || "");
      if (!pageId) continue;
      const explicitRatio = Number(span?.overlapRatio);
      const box = runtime.normalizeBox(span?.box);
      const fallbackArea = Math.max(0, box.width) * Math.max(0, box.height);
      // overlapRatio=0 是坐标映射明确给出的“没有贡献”，不能再用 box
      // 面积回退成正权重，否则纯上下文 OCR 会伪装成跨页证据。
      const weight = Number.isFinite(explicitRatio) ? Math.max(0, explicitRatio) : fallbackArea;
      contributions.set(pageId, Math.max(contributions.get(pageId) || 0, weight));
    }
    return contributions;
  }
  runtime.seamContributionByPage = seamContributionByPage;
  function hasMeaningfulCrossPageContribution(observation, requiredPageIds = []) {
    if (observation?.sourceType !== "seam") return false;
    const contributions = runtime.seamContributionByPage(observation);
    const pageIds = (Array.isArray(requiredPageIds) && requiredPageIds.length ? requiredPageIds.map(String) : [...contributions.keys()]).filter((pageId, index, values) => pageId && values.indexOf(pageId) === index);
    if (pageIds.length < 2 || pageIds.some(pageId => !contributions.has(pageId))) return false;
    const weights = pageIds.map(pageId => contributions.get(pageId) || 0);
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) return false;
    return weights.every(value => value / total >= runtime.MIN_SEAM_PAGE_CONTRIBUTION);
  }
  runtime.hasMeaningfulCrossPageContribution = hasMeaningfulCrossPageContribution;
  function observationQuality(observation) {
    const text = runtime.normalizeText(observation.originalText);
    const terminal = /[.!?。！？…]\s*$/u.test(text) ? 0.08 : 0;
    const replacementPenalty = (text.match(/[�□]/gu) || []).length * 0.03;
    return runtime.roundTo(runtime.clamp(observation.confidence, 0, 1) * 0.48 + runtime.clamp(Array.from(text).length / 80, 0, 1) * 0.36 + terminal + (text ? 0.08 : 0) - replacementPenalty, 6);
  }
  runtime.observationQuality = observationQuality;
  function compareObservationsByPage(left, right, pageIndex) {
    const leftPage = Math.min(...left.pageIds.map(pageId => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
    const rightPage = Math.min(...right.pageIds.map(pageId => pageIndex.get(pageId) ?? Number.MAX_SAFE_INTEGER));
    if (leftPage !== rightPage) return leftPage - rightPage;
    const leftSpan = runtime.getSpan(left, left.pageIds.find(pageId => pageIndex.get(pageId) === leftPage) || left.pageIds[0]);
    const rightSpan = runtime.getSpan(right, right.pageIds.find(pageId => pageIndex.get(pageId) === rightPage) || right.pageIds[0]);
    const leftBox = runtime.normalizeBox(leftSpan?.box);
    const rightBox = runtime.normalizeBox(rightSpan?.box);
    return leftBox.top - rightBox.top || leftBox.left - rightBox.left || left.id.localeCompare(right.id);
  }
  runtime.compareObservationsByPage = compareObservationsByPage;
}
