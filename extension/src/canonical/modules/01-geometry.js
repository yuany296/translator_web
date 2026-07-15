export function installPipeline01(runtime) {
  /** 检查 FSM 转换是否合法 */
  function canTransition(from, to) {
    const allowed = runtime.PagePhase.transitions[from];
    return !!allowed && allowed.includes(to);
  }

  /** 是否在活动状态（允许继续推进的中间态） */
  runtime.canTransition = canTransition;
  function isActivePhase(phase) {
    return phase !== runtime.PagePhase.WAITING && phase !== runtime.PagePhase.RETRY_WAIT && phase !== runtime.PagePhase.CANCELLED && phase !== runtime.PagePhase.FAILED && phase !== runtime.PagePhase.RENDERED;
  }

  /** 是否在可重试状态 */
  runtime.isActivePhase = isActivePhase;
  function isRetryablePhase(phase) {
    return phase === runtime.PagePhase.RETRY_WAIT || phase === runtime.PagePhase.WAITING;
  }

  /* =================================================================
   * 文本工具函数（纯）
   * ================================================================= */
  runtime.isRetryablePhase = isRetryablePhase;
  function normalizeOcrSimilarityText(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  }
  runtime.normalizeOcrSimilarityText = normalizeOcrSimilarityText;
  function normalizeTextAlignment(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "left" || text === "right" || text === "center" ? text : "center";
  }
  runtime.normalizeTextAlignment = normalizeTextAlignment;
  function normalizeFontWeight(value) {
    const numeric = Math.round(Number(value) || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return runtime.clamp(Math.round(numeric / 100) * 100, 100, 900);
  }
  runtime.normalizeFontWeight = normalizeFontWeight;
  function getBubbleLineCount(bubble) {
    if (bubble && Number.isFinite(Number(bubble.source_line_count)) && Number(bubble.source_line_count) >= 1) {
      return Math.round(Number(bubble.source_line_count));
    }
    if (bubble && Array.isArray(bubble.items) && bubble.items.length > 0) {
      return bubble.items.length;
    }
    const text = String(bubble && (bubble.original_text || bubble.text || "") || "");
    const lines = String(text).split(/\n+/).filter(Boolean).length;
    return Math.max(1, lines);
  }
  runtime.getBubbleLineCount = getBubbleLineCount;
  function textSimilarity(first, second) {
    if (first === second) {
      return first ? 1 : 0;
    }
    if (!first || !second) {
      return 0;
    }
    const firstChars = Array.from(first);
    const secondChars = Array.from(second);
    // Levenshtein 距离归一化
    let previous = Array.from({
      length: secondChars.length + 1
    }, (_, index) => index);
    for (let fi = 0; fi < firstChars.length; fi += 1) {
      const current = [fi + 1];
      for (let si = 0; si < secondChars.length; si += 1) {
        current.push(Math.min(current[si] + 1, previous[si + 1] + 1, previous[si] + (firstChars[fi] === secondChars[si] ? 0 : 1)));
      }
      previous = current;
    }
    return 1 - previous[previous.length - 1] / Math.max(firstChars.length, secondChars.length);
  }
  runtime.textSimilarity = textSimilarity;
  function areOcrTextsDuplicateOrContained(first, second) {
    if (!first || !second) {
      return false;
    }
    const shorter = first.length <= second.length ? first : second;
    const longer = first.length > second.length ? first : second;
    return runtime.textSimilarity(first, second) >= 0.82 || shorter.length >= 3 && longer.includes(shorter);
  }
  runtime.areOcrTextsDuplicateOrContained = areOcrTextsDuplicateOrContained;
  function hasSubstantialOcrTokenOverlap(first, second) {
    if (!first || !second) {
      return false;
    }
    const firstChars = Array.from(first);
    const secondChars = Array.from(second);
    const shorterLength = Math.min(firstChars.length, secondChars.length);
    if (shorterLength < 5) {
      return false;
    }
    const minimumLength = Math.max(5, Math.ceil(shorterLength * 0.35));
    return runtime.getLongestCommonSubstringLength(firstChars, secondChars, minimumLength) >= minimumLength;
  }
  runtime.hasSubstantialOcrTokenOverlap = hasSubstantialOcrTokenOverlap;
  function getLongestCommonSubstringLength(firstChars, secondChars, stopAt) {
    let previous = Array.from({
      length: secondChars.length + 1
    }, () => 0);
    let best = 0;
    for (const firstChar of firstChars) {
      const current = [0];
      for (let secondIndex = 0; secondIndex < secondChars.length; secondIndex += 1) {
        const next = firstChar === secondChars[secondIndex] ? previous[secondIndex] + 1 : 0;
        current.push(next);
        best = Math.max(best, next);
        if (best >= stopAt) {
          return best;
        }
      }
      previous = current;
    }
    return best;
  }
  runtime.getLongestCommonSubstringLength = getLongestCommonSubstringLength;
  function getSubstantialOcrBoundaryOverlap(first, second) {
    const minimumLength = Math.max(6, Math.ceil(Math.min(first.length, second.length) * 0.55));
    const maximumLength = Math.min(first.length, second.length);
    for (let len = maximumLength; len >= minimumLength; len -= 1) {
      if (first.endsWith(second.slice(0, len))) {
        return {
          length: len,
          trim: "suffix"
        };
      }
      if (second.endsWith(first.slice(0, len))) {
        return {
          length: len,
          trim: "prefix"
        };
      }
    }
    return null;
  }
  runtime.getSubstantialOcrBoundaryOverlap = getSubstantialOcrBoundaryOverlap;
  function sliceTextByNormalizedBoundary(text, overlapLength, keepSuffix) {
    const chars = Array.from(String(text || ""));
    let count = 0;
    if (keepSuffix) {
      let index = 0;
      while (index < chars.length && count < overlapLength) {
        count += runtime.normalizeOcrSimilarityText(chars[index]).length;
        index += 1;
      }
      return chars.slice(index).join("").trim();
    }
    let index = chars.length - 1;
    while (index >= 0 && count < overlapLength) {
      count += runtime.normalizeOcrSimilarityText(chars[index]).length;
      index -= 1;
    }
    return chars.slice(0, index + 1).join("").trim();
  }

  /* =================================================================
   * 几何工具函数（纯）
   * ================================================================= */
  runtime.sliceTextByNormalizedBoundary = sliceTextByNormalizedBoundary;
  function normalizeRectLike(rect) {
    if (!rect || typeof rect !== "object") return null;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const w = Number(rect.w || rect.width);
    const h = Number(rect.h || rect.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      return null;
    }
    return {
      x,
      y,
      w,
      h
    };
  }
  runtime.normalizeRectLike = normalizeRectLike;
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  runtime.clamp = clamp;
  function pageBoxIntersectionRatio(left, right) {
    const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
    return width * height / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  }
  runtime.pageBoxIntersectionRatio = pageBoxIntersectionRatio;
  function areKakaoGlobalBoxesRelated(leftBox, rightBox) {
    if (!leftBox || !rightBox) {
      return false;
    }
    const overlap = runtime.pageBoxIntersectionRatio(leftBox, rightBox);
    const leftCenterX = leftBox.left + leftBox.width / 2;
    const rightCenterX = rightBox.left + rightBox.width / 2;
    const horizontalOverlap = Math.max(0, Math.min(leftBox.left + leftBox.width, rightBox.left + rightBox.width) - Math.max(leftBox.left, rightBox.left));
    const horizontalOverlapRatio = horizontalOverlap / Math.max(1, Math.min(leftBox.width, rightBox.width));
    const verticalGap = Math.max(0, Math.max(leftBox.top, rightBox.top) - Math.min(leftBox.top + leftBox.height, rightBox.top + rightBox.height));
    const closeAcrossBoundary = verticalGap <= Math.max(leftBox.height, rightBox.height) * 0.28 && (horizontalOverlapRatio >= 0.35 || Math.abs(leftCenterX - rightCenterX) <= Math.max(leftBox.width, rightBox.width) * 0.35);
    return overlap >= 0.08 || closeAcrossBoundary;
  }

  /* =================================================================
   * 邻图验证与窗口规划（纯）
   * ================================================================= */
  runtime.areKakaoGlobalBoxesRelated = areKakaoGlobalBoxesRelated;
  function isKakaoPageEdgeSource(source) {
    return /(^|\/\/)page-edge\.kakao\.com\//i.test(String(source || ""));
  }
  runtime.isKakaoPageEdgeSource = isKakaoPageEdgeSource;
  function isVerifiedKakaoStitchNeighbor(owner, candidate, direction) {
    if (!owner || !candidate || !candidate.sourceKey || candidate.sourceKey === owner.sourceKey) {
      return false;
    }
    const ownerSrc = owner.currentSrc || owner.src || "";
    const candidateSrc = candidate.currentSrc || candidate.src || "";
    if (ownerSrc && candidateSrc && ownerSrc === candidateSrc) {
      return false;
    }
    if (!(candidate.height >= runtime.KAKAO_THIN_STRIP_MIN_HEIGHT)) {
      return false;
    }
    const widthRatio = Math.min(owner.width, candidate.width) / Math.max(owner.width, candidate.width);
    if (widthRatio < runtime.KAKAO_STITCH_MIN_WIDTH_RATIO) {
      return false;
    }
    const ownerCenter = owner.left + owner.width / 2;
    const candidateCenter = candidate.left + candidate.width / 2;
    const centerDelta = Math.abs(ownerCenter - candidateCenter);
    if (centerDelta > Math.max(owner.width, candidate.width) * 0.12) {
      return false;
    }

    // direction-specific visual overlap checks
    if (direction === "previous") {
      if (!(candidate.top < owner.top)) return false;
      if (candidate.bottom > owner.top + 24) return false;
    } else {
      if (!(candidate.top > owner.top)) return false;
      if (candidate.top < owner.bottom - 24) return false;
    }
    const seamGap = direction === "previous" ? owner.top - candidate.bottom : candidate.top - owner.bottom;
    if (seamGap < -16) {
      return false;
    }
    return Math.abs(seamGap) <= runtime.KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX;
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
    if (!owner || !(owner.width > 0) || !(ownerHeight > 0) || !(canonicalWidth > 0)) {
      return {
        previousSlice: 0,
        nextSlice: 0,
        previousShortPageAttachment: false,
        nextShortPageAttachment: false
      };
    }
    const bitmapPerCssPixel = canonicalWidth / owner.width;
    const desiredContext = runtime.clamp(Math.round(Math.min(runtime.KAKAO_STITCH_CONTEXT_CSS_PX, owner.height * runtime.KAKAO_STITCH_CONTEXT_HEIGHT_RATIO) * bitmapPerCssPixel), runtime.KAKAO_STITCH_MIN_CONTEXT_PX, runtime.KAKAO_STITCH_MAX_CONTEXT_PX);
    const previousShortPageAttachment = runtime.isAttachableKakaoShortPage(previous, owner, previousHeight, ownerHeight);
    const nextShortPageAttachment = runtime.isAttachableKakaoShortPage(next, owner, nextHeight, ownerHeight);
    return {
      previousSlice: previous && previousHeight > 0 ? Math.min(previousShortPageAttachment ? previousHeight : desiredContext, previousHeight) : 0,
      nextSlice: next && nextHeight > 0 ? Math.min(nextShortPageAttachment ? nextHeight : desiredContext, nextHeight) : 0,
      previousShortPageAttachment,
      nextShortPageAttachment
    };
  }
  runtime.buildKakaoStitchWindowPlan = buildKakaoStitchWindowPlan;
  function isAttachableKakaoShortPage(candidate, owner, candidateHeight, ownerHeight) {
    if (!candidate || !owner || !(candidateHeight > 0) || !(ownerHeight > 0)) {
      return false;
    }
    const cssHeight = Number(candidate.height || 0);
    const scaledRatio = candidateHeight / Math.max(1, ownerHeight);
    const ownerIsClearlyLarger = ownerHeight / Math.max(1, candidateHeight) >= 1.35;
    return cssHeight > 0 && cssHeight <= runtime.KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT && ownerIsClearlyLarger || scaledRatio <= runtime.KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO;
  }
  runtime.isAttachableKakaoShortPage = isAttachableKakaoShortPage;
  function isKakaoPageEdgeFragment({
    owner,
    ownerHeight,
    canonicalWidth
  } = {}) {
    if (!owner || !runtime.isKakaoPageEdgeSource(owner.sourceKey)) {
      return false;
    }
    const width = Math.max(1, Number(canonicalWidth) || Number(owner.width) || 1);
    const height = Math.max(1, Number(ownerHeight) || 0);
    return height < Math.max(760, width * 1.05);
  }
  runtime.isKakaoPageEdgeFragment = isKakaoPageEdgeFragment;
  function shouldRejectKakaoPageEdgeStitch({
    owner,
    ownerHeight,
    canonicalWidth,
    previous,
    next,
    previousHeight,
    nextHeight
  } = {}) {
    if (!runtime.isKakaoPageEdgeFragment({
      owner,
      ownerHeight,
      canonicalWidth
    })) {
      return "";
    }
    const height = Math.max(1, Number(ownerHeight) || 0);
    const neighborHeights = [previous ? Number(previousHeight || 0) : 0, next ? Number(nextHeight || 0) : 0].filter(v => v > 0);
    const hasStableNeighborHeight = neighborHeights.some(neighborHeight => {
      const ratio = Math.min(height, neighborHeight) / Math.max(height, neighborHeight);
      return ratio >= 0.78;
    });
    return hasStableNeighborHeight ? "" : "page-edge fragmented image stitch admission rejected";
  }
  runtime.shouldRejectKakaoPageEdgeStitch = shouldRejectKakaoPageEdgeStitch;
  function buildKakaoStitchCandidateEntries(targets, describeTarget = null) {
    return (Array.isArray(targets) ? targets : []).map(target => ({
      target,
      descriptor: typeof describeTarget === "function" ? describeTarget(target) : target && target.descriptor ? target.descriptor : target
    }));
  }
  runtime.buildKakaoStitchCandidateEntries = buildKakaoStitchCandidateEntries;
}
