/* ===================================================================
 * kakao-pipeline.js — KakaoPage 拼接/去重/翻译管线
 *
 * 纯函数 + Store + FSM + Pipeline orchestrator。
 * 由 manifest.json 在 content.js 之前加载，通过冻结的
 * globalThis.MangaTranslatorKakaoPipeline 导出。
 *
 * 不依赖 DOM / chrome.* 的纯函数可直接测试；
 * 需要 DOM / 消息通信的部分通过 adapters 注入到 createPipeline()。
 *
 * 常量、阈值与 content.js 保持一致——本模块只重构不调算法。
 * =================================================================== */
(function () {
  "use strict";

  if (globalThis.MangaTranslatorKakaoPipeline) {
    return; // 防止重复加载
  }

  /* =================================================================
   * 常量 — 全部从 content.js 原值迁移，本轮不调整
   * ================================================================= */
  const KAKAO_STITCH_MAX_CONTEXT_PX = 480;
  const KAKAO_STITCH_MIN_CONTEXT_PX = 96;
  const KAKAO_STITCH_CONTEXT_CSS_PX = 360;
  const KAKAO_STITCH_CONTEXT_HEIGHT_RATIO = 0.35;
  const KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX = 32;
  const KAKAO_STITCH_MIN_WIDTH_RATIO = 0.82;
  const KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT = 420;
  const KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO = 0.45;
  const KAKAO_OVERLAP_SAMPLE_WIDTH = 96;
  const KAKAO_OVERLAP_MIN_RATIO = 0.28;
  const KAKAO_OVERLAP_MAX_RATIO = 0.88;
  const KAKAO_OVERLAP_MAX_MAE = 12;
  const KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO = 0.002;
  const KAKAO_OVERLAP_MAX_INFORMATIVE_MAE = 32;
  const KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO = 0.25;
  const KAKAO_OVERLAP_INFORMATIVE_LUMA = 245;
  const KAKAO_OVERLAP_INFORMATIVE_DIFF = 10;
  const KAKAO_OVERLAP_MIN_UNIQUE_PX = 220;
  const KAKAO_OVERLAP_MIN_UNIQUE_RATIO = 0.22;
  const KAKAO_THIN_STRIP_MAX_NATURAL_HEIGHT = 100;
  const KAKAO_THIN_STRIP_MIN_HEIGHT = 8;
  const KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS = 8000;
  const KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION = 0.72;
  const KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO = 0.35;
  const KAKAO_STITCH_MIN_CROSS_PX = 16;
  const KAKAO_STITCH_MIN_CROSS_RATIO = 0.008;

  /**
   * Canonical 链路只描述真实处理阶段。旧 PagePhase 继续供非目标链路兼容，
   * Kakao direct-overlay 不再进入 stitch / destructive-dedupe 阶段。
   */
  const CanonicalPhase = Object.freeze({
    WAITING: "waiting",
    FETCHING: "fetching",
    PAGE_OCR: "page_ocr",
    OBSERVING: "observing",
    SEAM_OCR: "seam_ocr",
    RECONCILING: "reconciling",
    TRANSLATING: "translating",
    PROJECTING: "projecting",
    RENDERING: "rendering",
    RENDERED: "rendered",
    RETRY_WAIT: "retry_wait",
    CANCELLED: "cancelled",
    FAILED: "failed"
  });

  const KAKAO_EDGE_WAIT_TIMEOUT_MS = 8000;
  const KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS = 5000;
  const KAKAO_CLEANED_ARTIFACT_AUTO_RETRY_LIMIT = 1;
  const KAKAO_SEAM_HEIGHT_WIDTH_RATIO = 0.15;
  const KAKAO_SEAM_HEIGHT_MIN_PX = 64;
  const KAKAO_SEAM_HEIGHT_MAX_PX = 96;
  const KAKAO_CANONICAL_TARGET_LANGUAGE = "zh-CN";

  /* =================================================================
   * PagePhase — 有限状态机状态定义
   * ================================================================= */
  const PagePhase = Object.freeze({
    /** 初始等待 */
    WAITING: "waiting",
    /** 正在获取图片数据 */
    FETCHING: "fetching",
    /** 图片数据就绪 */
    FETCHED: "fetched",
    /** 正在拼接相邻页 */
    STITCHING: "stitching",
    /** 拼接完成 */
    STITCHED: "stitched",
    /** 正在 OCR / 翻译（与 background.js 通信） */
    RECOGNIZING: "recognizing",
    /** OCR / 翻译完成 */
    RECOGNIZED: "recognized",
    /** 正在全局去重 */
    DEDUPING: "deduping",
    /** 去重完成 */
    DEDUPED: "deduped",
    /** 正在渲染 */
    RENDERING: "rendering",
    /** 渲染完成 */
    RENDERED: "rendered",
    /** 已取消（DOM 复用/源变化/扩展卸载） */
    CANCELLED: "cancelled",
    /** 等待重试 */
    RETRY_WAIT: "retry_wait",
    /** 最终失败（重试耗尽） */
    FAILED: "failed",

    /** 合法正向转换表 */
    transitions: Object.freeze({
      waiting:      ["fetching", "deduping", "cancelled", "failed"],
      fetching:     ["fetched", "retry_wait", "cancelled", "failed"],
      fetched:      ["stitching", "recognizing", "cancelled", "failed"],
      stitching:    ["stitched", "retry_wait", "cancelled", "failed"],
      stitched:     ["recognizing", "cancelled", "failed"],
      recognizing:  ["recognized", "retry_wait", "cancelled", "failed"],
      recognized:   ["deduping", "cancelled", "failed"],
      deduping:     ["deduped", "cancelled", "failed"],
      deduped:      ["rendering", "cancelled", "failed"],
      rendering:    ["rendered", "cancelled", "failed"],
      rendered:     ["cancelled"],
      cancelled:    [],
      retry_wait:   ["waiting", "cancelled", "failed"],
      failed:       ["cancelled"]
    })
  });

  /** 检查 FSM 转换是否合法 */
  function canTransition(from, to) {
    const allowed = PagePhase.transitions[from];
    return !!allowed && allowed.includes(to);
  }

  /** 是否在活动状态（允许继续推进的中间态） */
  function isActivePhase(phase) {
    return phase !== PagePhase.WAITING &&
           phase !== PagePhase.RETRY_WAIT &&
           phase !== PagePhase.CANCELLED &&
           phase !== PagePhase.FAILED &&
           phase !== PagePhase.RENDERED;
  }

  /** 是否在可重试状态 */
  function isRetryablePhase(phase) {
    return phase === PagePhase.RETRY_WAIT ||
           phase === PagePhase.WAITING;
  }

  /* =================================================================
   * 文本工具函数（纯）
   * ================================================================= */
  function normalizeOcrSimilarityText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function getBubbleLineCount(bubble) {
    if (bubble && Number.isFinite(Number(bubble.source_line_count)) && Number(bubble.source_line_count) >= 1) {
      return Math.round(Number(bubble.source_line_count));
    }
    if (bubble && Array.isArray(bubble.items) && bubble.items.length > 0) {
      return bubble.items.length;
    }
    const text = String((bubble && (bubble.original_text || bubble.text || "")) || "");
    const lines = String(text).split(/\n+/).filter(Boolean).length;
    return Math.max(1, lines);
  }

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
    let previous = Array.from({ length: secondChars.length + 1 }, (_, index) => index);
    for (let fi = 0; fi < firstChars.length; fi += 1) {
      const current = [fi + 1];
      for (let si = 0; si < secondChars.length; si += 1) {
        current.push(Math.min(
          current[si] + 1,
          previous[si + 1] + 1,
          previous[si] + (firstChars[fi] === secondChars[si] ? 0 : 1)
        ));
      }
      previous = current;
    }
    return 1 - previous[previous.length - 1] / Math.max(firstChars.length, secondChars.length);
  }

  function areOcrTextsDuplicateOrContained(first, second) {
    if (!first || !second) {
      return false;
    }
    const shorter = first.length <= second.length ? first : second;
    const longer = first.length > second.length ? first : second;
    return textSimilarity(first, second) >= 0.82 ||
      (shorter.length >= 3 && longer.includes(shorter));
  }

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
    return getLongestCommonSubstringLength(firstChars, secondChars, minimumLength) >= minimumLength;
  }

  function getLongestCommonSubstringLength(firstChars, secondChars, stopAt) {
    let previous = Array.from({ length: secondChars.length + 1 }, () => 0);
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

  function getSubstantialOcrBoundaryOverlap(first, second) {
    const minimumLength = Math.max(6, Math.ceil(Math.min(first.length, second.length) * 0.55));
    const maximumLength = Math.min(first.length, second.length);
    for (let len = maximumLength; len >= minimumLength; len -= 1) {
      if (first.endsWith(second.slice(0, len))) {
        return { length: len, trim: "suffix" };
      }
      if (second.endsWith(first.slice(0, len))) {
        return { length: len, trim: "prefix" };
      }
    }
    return null;
  }

  function sliceTextByNormalizedBoundary(text, overlapLength, keepSuffix) {
    const chars = Array.from(String(text || ""));
    let count = 0;
    if (keepSuffix) {
      let index = 0;
      while (index < chars.length && count < overlapLength) {
        count += normalizeOcrSimilarityText(chars[index]).length;
        index += 1;
      }
      return chars.slice(index).join("").trim();
    }
    let index = chars.length - 1;
    while (index >= 0 && count < overlapLength) {
      count += normalizeOcrSimilarityText(chars[index]).length;
      index -= 1;
    }
    return chars.slice(0, index + 1).join("").trim();
  }

  /* =================================================================
   * 几何工具函数（纯）
   * ================================================================= */
  function normalizeRectLike(rect) {
    if (!rect || typeof rect !== "object") return null;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const w = Number(rect.w || rect.width);
    const h = Number(rect.h || rect.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      return null;
    }
    return { x, y, w, h };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pageBoxIntersectionRatio(left, right) {
    const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
    return (width * height) / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  }

  function areKakaoGlobalBoxesRelated(leftBox, rightBox) {
    if (!leftBox || !rightBox) {
      return false;
    }
    const overlap = pageBoxIntersectionRatio(leftBox, rightBox);
    const leftCenterX = leftBox.left + leftBox.width / 2;
    const rightCenterX = rightBox.left + rightBox.width / 2;
    const horizontalOverlap = Math.max(
      0,
      Math.min(leftBox.left + leftBox.width, rightBox.left + rightBox.width) -
        Math.max(leftBox.left, rightBox.left)
    );
    const horizontalOverlapRatio = horizontalOverlap / Math.max(1, Math.min(leftBox.width, rightBox.width));
    const verticalGap = Math.max(
      0,
      Math.max(leftBox.top, rightBox.top) -
        Math.min(leftBox.top + leftBox.height, rightBox.top + rightBox.height)
    );
    const closeAcrossBoundary = verticalGap <= Math.max(leftBox.height, rightBox.height) * 0.28 &&
      (horizontalOverlapRatio >= 0.35 ||
        Math.abs(leftCenterX - rightCenterX) <= Math.max(leftBox.width, rightBox.width) * 0.35);
    return overlap >= 0.08 || closeAcrossBoundary;
  }

  /* =================================================================
   * 邻图验证与窗口规划（纯）
   * ================================================================= */
  function isKakaoPageEdgeSource(source) {
    return /(^|\/\/)page-edge\.kakao\.com\//i.test(String(source || ""));
  }

  function isVerifiedKakaoStitchNeighbor(owner, candidate, direction) {
    if (!owner || !candidate || !candidate.sourceKey || candidate.sourceKey === owner.sourceKey) {
      return false;
    }
    const ownerSrc = owner.currentSrc || owner.src || "";
    const candidateSrc = candidate.currentSrc || candidate.src || "";
    if (ownerSrc && candidateSrc && ownerSrc === candidateSrc) {
      return false;
    }
    if (!(candidate.height >= KAKAO_THIN_STRIP_MIN_HEIGHT)) {
      return false;
    }
    const widthRatio = Math.min(owner.width, candidate.width) / Math.max(owner.width, candidate.width);
    if (widthRatio < KAKAO_STITCH_MIN_WIDTH_RATIO) {
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

    const seamGap = direction === "previous"
      ? owner.top - candidate.bottom
      : candidate.top - owner.bottom;
    if (seamGap < -16) {
      return false;
    }
    return Math.abs(seamGap) <= KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX;
  }

  function buildKakaoStitchWindowPlan({ owner, previous, next, canonicalWidth, ownerHeight, previousHeight, nextHeight }) {
    if (!owner || !(owner.width > 0) || !(ownerHeight > 0) || !(canonicalWidth > 0)) {
      return { previousSlice: 0, nextSlice: 0, previousShortPageAttachment: false, nextShortPageAttachment: false };
    }
    const bitmapPerCssPixel = canonicalWidth / owner.width;
    const desiredContext = clamp(
      Math.round(Math.min(KAKAO_STITCH_CONTEXT_CSS_PX, owner.height * KAKAO_STITCH_CONTEXT_HEIGHT_RATIO) * bitmapPerCssPixel),
      KAKAO_STITCH_MIN_CONTEXT_PX,
      KAKAO_STITCH_MAX_CONTEXT_PX
    );
    const previousShortPageAttachment = isAttachableKakaoShortPage(previous, owner, previousHeight, ownerHeight);
    const nextShortPageAttachment = isAttachableKakaoShortPage(next, owner, nextHeight, ownerHeight);
    return {
      previousSlice: previous && previousHeight > 0
        ? Math.min(previousShortPageAttachment ? previousHeight : desiredContext, previousHeight)
        : 0,
      nextSlice: next && nextHeight > 0
        ? Math.min(nextShortPageAttachment ? nextHeight : desiredContext, nextHeight)
        : 0,
      previousShortPageAttachment,
      nextShortPageAttachment
    };
  }

  function isAttachableKakaoShortPage(candidate, owner, candidateHeight, ownerHeight) {
    if (!candidate || !owner || !(candidateHeight > 0) || !(ownerHeight > 0)) {
      return false;
    }
    const cssHeight = Number(candidate.height || 0);
    const scaledRatio = candidateHeight / Math.max(1, ownerHeight);
    const ownerIsClearlyLarger = ownerHeight / Math.max(1, candidateHeight) >= 1.35;
    return ((cssHeight > 0 && cssHeight <= KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT) && ownerIsClearlyLarger) ||
      scaledRatio <= KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO;
  }

  function isKakaoPageEdgeFragment({ owner, ownerHeight, canonicalWidth } = {}) {
    if (!owner || !isKakaoPageEdgeSource(owner.sourceKey)) {
      return false;
    }
    const width = Math.max(1, Number(canonicalWidth) || Number(owner.width) || 1);
    const height = Math.max(1, Number(ownerHeight) || 0);
    return height < Math.max(760, width * 1.05);
  }

  function shouldRejectKakaoPageEdgeStitch({ owner, ownerHeight, canonicalWidth, previous, next, previousHeight, nextHeight } = {}) {
    if (!isKakaoPageEdgeFragment({ owner, ownerHeight, canonicalWidth })) {
      return "";
    }
    const height = Math.max(1, Number(ownerHeight) || 0);
    const neighborHeights = [
      previous ? Number(previousHeight || 0) : 0,
      next ? Number(nextHeight || 0) : 0
    ].filter((v) => v > 0);
    const hasStableNeighborHeight = neighborHeights.some((neighborHeight) => {
      const ratio = Math.min(height, neighborHeight) / Math.max(height, neighborHeight);
      return ratio >= 0.78;
    });
    return hasStableNeighborHeight
      ? ""
      : "page-edge fragmented image stitch admission rejected";
  }

  function buildKakaoStitchCandidateEntries(targets, describeTarget = null) {
    return (Array.isArray(targets) ? targets : []).map((target) => ({
      target,
      descriptor: typeof describeTarget === "function"
        ? describeTarget(target)
        : target && target.descriptor
          ? target.descriptor
          : target
    }));
  }

  function isKakaoStitchCandidatePastNeighborWindow(owner, candidate, direction) {
    if (!owner || !candidate) {
      return false;
    }
    const ownerTop = Number(owner.top || 0);
    const ownerBottom = Number(owner.bottom || (Number(owner.top || 0) + Number(owner.height || 0)));
    const candidateTop = Number(candidate.top || 0);
    const candidateBottom = Number(candidate.bottom || (Number(candidate.top || 0) + Number(candidate.height || 0)));
    return direction === "previous"
      ? candidateBottom < ownerTop - KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX
      : candidateTop > ownerBottom + KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX;
  }

  /** 在已建索引的候选列表中查找邻图目标 */
  function findKakaoStitchNeighborTarget(entries, fromIndex, direction) {
    if (!Array.isArray(entries) || entries.length === 0 || fromIndex < 0 || fromIndex >= entries.length) {
      return null;
    }
    const owner = entries[fromIndex];
    if (!owner || !owner.descriptor) return null;
    const step = direction === "previous" ? -1 : 1;
    const limit = direction === "previous" ? 0 : entries.length - 1;
    for (let i = fromIndex + step; direction === "previous" ? i >= limit : i <= limit; i += step) {
      const candidate = entries[i];
      if (!candidate || !candidate.descriptor) continue;
      if (isKakaoStitchCandidatePastNeighborWindow(owner.descriptor, candidate.descriptor, direction)) {
        break;
      }
      if (isVerifiedKakaoStitchNeighbor(owner.descriptor, candidate.descriptor, direction)) {
        return candidate.target;
      }
    }
    return null;
  }

  /** 在已建索引的候选列表中查找短页附着目标 */
  function findKakaoShortPageAttachmentOwnerTarget(entries, fromIndex, direction) {
    if (!Array.isArray(entries) || entries.length === 0 || fromIndex < 0 || fromIndex >= entries.length) {
      return null;
    }
    const target = entries[fromIndex];
    if (!target || !target.descriptor) return null;
    const step = direction === "previous" ? -1 : 1;
    const limit = direction === "previous" ? 0 : entries.length - 1;
    for (let i = fromIndex + step; direction === "previous" ? i >= limit : i <= limit; i += step) {
      const candidate = entries[i];
      if (!candidate || !candidate.descriptor) continue;
      const owner = candidate.descriptor;
      const candidateDesc = target.descriptor;
      const ownerDirection = direction === "previous" ? "next" : "previous";
      if (isKakaoStitchCandidatePastNeighborWindow(candidateDesc, owner, direction)) {
        break;
      }
      if (
        isVerifiedKakaoStitchNeighbor(owner, candidateDesc, ownerDirection) &&
        isAttachableKakaoShortPage(candidateDesc, owner, candidateDesc.height, owner.height)
      ) {
        return candidate.target;
      }
    }
    return null;
  }

  function findKakaoShortPageAttachmentOwner(target, candidates, describeTarget) {
    const ordered = Array.isArray(candidates) ? candidates : [];
    const index = ordered.indexOf(target);
    if (index < 0) {
      return null;
    }
    const entries = buildKakaoStitchCandidateEntries(ordered, describeTarget);
    if (!entries[index] || !entries[index].descriptor) {
      return null;
    }
    const previous = findKakaoShortPageAttachmentOwnerTarget(entries, index, "previous");
    if (previous) {
      return { owner: previous, direction: "next" };
    }
    const next = findKakaoShortPageAttachmentOwnerTarget(entries, index, "next");
    return next ? { owner: next, direction: "previous" } : null;
  }

  /* =================================================================
   * 重叠检测（纯像素运算）
   * ================================================================= */
  /** 创建灰度采样（纯函数——不操作 DOM canvas；接收 imageData 级别的数据） */
  function computeGraySample({ data, width, height }) {
    if (!data || !width || !height) return null;
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
    }
    return { width, height, gray };
  }

  function findKakaoVerticalOverlap(previousSample, currentSample) {
    if (
      !previousSample || !currentSample ||
      previousSample.width !== currentSample.width ||
      !(previousSample.height > 0 && currentSample.height > 0) ||
      !previousSample.gray || !currentSample.gray
    ) {
      return null;
    }
    const width = previousSample.width;
    const maxRows = Math.floor(Math.min(
      previousSample.height,
      currentSample.height * KAKAO_OVERLAP_MAX_RATIO
    ));
    const minRows = Math.ceil(currentSample.height * KAKAO_OVERLAP_MIN_RATIO);
    if (maxRows < minRows) return null;

    let bestRows = 0;
    let bestMae = Infinity;
    let bestInformativeMae = Infinity;
    let bestInformativeRatio = 0;
    let bestInformativeSpanRatio = 0;
    let bestScore = Infinity;
    let bestQualified = false;
    const step = Math.max(1, Math.round(currentSample.height / 180));

    for (let rows = minRows; rows <= maxRows; rows += step) {
      const previousOffset = (previousSample.height - rows) * width;
      let total = 0;
      let informativeTotal = 0;
      let informativeCount = 0;
      let firstInformativeRow = rows;
      let lastInformativeRow = -1;
      const count = rows * width;
      for (let offset = 0; offset < count; offset += 1) {
        const previousLuma = previousSample.gray[previousOffset + offset];
        const currentLuma = currentSample.gray[offset];
        const difference = Math.abs(previousLuma - currentLuma);
        total += difference;
        if (
          previousLuma <= KAKAO_OVERLAP_INFORMATIVE_LUMA ||
          currentLuma <= KAKAO_OVERLAP_INFORMATIVE_LUMA ||
          difference >= KAKAO_OVERLAP_INFORMATIVE_DIFF
        ) {
          informativeTotal += difference;
          informativeCount += 1;
          const row = Math.floor(offset / width);
          firstInformativeRow = Math.min(firstInformativeRow, row);
          lastInformativeRow = Math.max(lastInformativeRow, row);
        }
      }
      const mae = total / Math.max(1, count);
      const informativeMae = informativeCount > 0
        ? informativeTotal / informativeCount
        : 255;
      const informativeRatio = informativeCount / Math.max(1, count);
      const informativeSpanRatio = lastInformativeRow >= firstInformativeRow
        ? (lastInformativeRow - firstInformativeRow + 1) / Math.max(1, rows)
        : 0;
      const score = mae + informativeMae * 0.25;
      const qualified = mae <= KAKAO_OVERLAP_MAX_MAE &&
        informativeRatio >= KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO &&
        informativeMae <= KAKAO_OVERLAP_MAX_INFORMATIVE_MAE &&
        informativeSpanRatio >= KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO;
      if ((qualified && !bestQualified) || (qualified === bestQualified && score < bestScore)) {
        bestQualified = qualified;
        bestScore = score;
        bestMae = mae;
        bestInformativeMae = informativeMae;
        bestInformativeRatio = informativeRatio;
        bestInformativeSpanRatio = informativeSpanRatio;
        bestRows = rows;
      }
    }

    const uniqueRows = currentSample.height - bestRows;
    const accepted = bestMae <= KAKAO_OVERLAP_MAX_MAE &&
      bestInformativeRatio >= KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO &&
      bestInformativeMae <= KAKAO_OVERLAP_MAX_INFORMATIVE_MAE &&
      bestInformativeSpanRatio >= KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO &&
      bestRows >= minRows &&
      bestRows <= maxRows &&
      uniqueRows / Math.max(1, currentSample.height) >= 1 - KAKAO_OVERLAP_MAX_RATIO;
    return {
      accepted,
      rows: bestRows,
      previousRows: previousSample.height,
      currentRows: currentSample.height,
      mae: bestMae,
      informativeMae: bestInformativeMae,
      informativeRatio: bestInformativeRatio,
      informativeSpanRatio: bestInformativeSpanRatio,
      overlapRatio: bestRows / Math.max(1, currentSample.height)
    };
  }

  function hasUsableKakaoStripCaptureRect(captureRect) {
    return !!captureRect && captureRect.height >= 180 && captureRect.width >= 180;
  }

  function markSingleKakaoPayload(payload, target, rejectionReason, adapters) {
    const reason = String(rejectionReason || "").trim();
    return {
      ...payload,
      ocrMode: "single",
      sourceToken: adapters.getQuickSourceToken(target),
      ...(reason ? { stitchAdmission: "rejected", stitchRejectionReason: reason } : {})
    };
  }

  /** 构建 Kakao 邻页拼接画布；DOM 与图像解码能力全部由适配器提供。 */
  async function buildKakaoStitchedPayload(target, ownerPayload, adapters) {
    const singlePayload = markSingleKakaoPayload(ownerPayload, target, "", adapters);
    const ordered = adapters.collectCandidates(target).filter(adapters.isReadyImageTarget);
    const ownerIndex = ordered.indexOf(target);
    if (ownerIndex < 0) {
      return markSingleKakaoPayload(ownerPayload, target, "owner not found", adapters);
    }

    const orderedEntries = buildKakaoStitchCandidateEntries(ordered, adapters.describeTarget);
    const ownerDescriptor = orderedEntries[ownerIndex] && orderedEntries[ownerIndex].descriptor;
    const previousTarget = findKakaoStitchNeighborTarget(orderedEntries, ownerIndex, "previous");
    const nextTarget = findKakaoStitchNeighborTarget(orderedEntries, ownerIndex, "next");
    if (!previousTarget && !nextTarget) {
      return markSingleKakaoPayload(ownerPayload, target, "no verified neighbor", adapters);
    }

    const previousPayload = previousTarget ? await adapters.extractAdjacentPayload(previousTarget) : null;
    const nextPayload = nextTarget ? await adapters.extractAdjacentPayload(nextTarget) : null;
    const decoded = await Promise.all(
      [previousPayload, ownerPayload, nextPayload]
        .filter(Boolean)
        .map((payload) => adapters.loadImage(payload.dataUrl))
    );
    let decodedIndex = 0;
    const previousImage = previousPayload ? decoded[decodedIndex++] : null;
    const ownerImage = decoded[decodedIndex++];
    const nextImage = nextPayload ? decoded[decodedIndex] : null;
    const canonicalWidth = Math.max(1, Math.min(
      Number(adapters.imageMaxSide || 1536),
      Number(ownerPayload.width) || ownerImage.naturalWidth || ownerImage.width
    ));
    const scaledHeight = (image) => Math.max(1, Math.round(
      ((image.naturalHeight || image.height) / Math.max(1, image.naturalWidth || image.width)) * canonicalWidth
    ));
    const ownerHeight = scaledHeight(ownerImage);
    const previousHeight = previousImage ? scaledHeight(previousImage) : 0;
    const nextHeight = nextImage ? scaledHeight(nextImage) : 0;
    const previousDescriptor = previousTarget ? adapters.describeTarget(previousTarget) : null;
    const nextDescriptor = nextTarget ? adapters.describeTarget(nextTarget) : null;
    const rejection = shouldRejectKakaoPageEdgeStitch({
      owner: ownerDescriptor,
      ownerHeight,
      canonicalWidth,
      previous: previousDescriptor,
      next: nextDescriptor,
      previousHeight,
      nextHeight
    });
    if (rejection) {
      return markSingleKakaoPayload(singlePayload, target, rejection, adapters);
    }

    const plan = buildKakaoStitchWindowPlan({
      owner: ownerDescriptor,
      previous: previousDescriptor,
      next: nextDescriptor,
      canonicalWidth,
      ownerHeight,
      previousHeight,
      nextHeight
    });
    const previousSlice = previousImage ? plan.previousSlice : 0;
    const nextSlice = nextImage ? plan.nextSlice : 0;
    if (previousSlice <= 0 && nextSlice <= 0) {
      return markSingleKakaoPayload(ownerPayload, target, "empty stitch slices", adapters);
    }

    const compositeHeight = previousSlice + ownerHeight + nextSlice;
    const ownerEntry = {
      source: "owner",
      targetKey: adapters.computeTargetKey(target),
      src: adapters.getQuickSourceToken(target),
      drawRect: { x: 0, y: previousSlice, w: canonicalWidth, h: ownerHeight },
      sourceCrop: {
        x: 0,
        y: 0,
        w: ownerImage.naturalWidth || ownerImage.width,
        h: ownerImage.naturalHeight || ownerImage.height
      },
      naturalWidth: ownerImage.naturalWidth || ownerImage.width,
      naturalHeight: ownerImage.naturalHeight || ownerImage.height
    };
    const buildNeighborEntry = (source, neighborTarget, image, slice, fullHeight, drawY, shortPage) => {
      if (!neighborTarget || !image || !(slice > 0)) return null;
      const naturalWidth = image.naturalWidth || image.width;
      const naturalHeight = image.naturalHeight || image.height;
      const sourceCropHeight = naturalHeight * (slice / Math.max(1, fullHeight));
      return {
        source,
        shortPageAttachment: shortPage === true && slice >= fullHeight - 1,
        targetKey: adapters.computeTargetKey(neighborTarget),
        src: adapters.getQuickSourceToken(neighborTarget),
        drawRect: { x: 0, y: drawY, w: canonicalWidth, h: slice },
        sourceCrop: {
          x: 0,
          y: source === "previous" ? naturalHeight - sourceCropHeight : 0,
          w: naturalWidth,
          h: sourceCropHeight
        },
        naturalWidth,
        naturalHeight
      };
    };
    const previousEntry = buildNeighborEntry(
      "previous", previousTarget, previousImage, previousSlice, previousHeight, 0, plan.previousShortPageAttachment
    );
    const nextEntry = buildNeighborEntry(
      "next", nextTarget, nextImage, nextSlice, nextHeight,
      previousSlice + ownerHeight, plan.nextShortPageAttachment
    );
    const segments = [previousEntry, ownerEntry, nextEntry].filter(Boolean);

    const canvas = adapters.createCanvas(canonicalWidth, compositeHeight);
    const context = canvas && canvas.getContext("2d");
    if (!context) return singlePayload;
    if (previousImage && previousSlice > 0) {
      const height = previousImage.naturalHeight || previousImage.height;
      const width = previousImage.naturalWidth || previousImage.width;
      const sourceHeight = height * (previousSlice / previousHeight);
      context.drawImage(previousImage, 0, height - sourceHeight, width, sourceHeight, 0, 0, canonicalWidth, previousSlice);
    }
    context.drawImage(ownerImage, 0, 0, canonicalWidth, ownerHeight, 0, previousSlice, canonicalWidth, ownerHeight);
    if (nextImage && nextSlice > 0) {
      const height = nextImage.naturalHeight || nextImage.height;
      const width = nextImage.naturalWidth || nextImage.width;
      const sourceHeight = height * (nextSlice / nextHeight);
      context.drawImage(nextImage, 0, 0, width, sourceHeight, 0, previousSlice + ownerHeight, canonicalWidth, nextSlice);
    }

    const sourceKeys = [previousTarget, target, nextTarget]
      .map((item) => item ? adapters.getQuickSourceToken(item) : "edge");
    return {
      ...ownerPayload,
      ocrMode: "stitch",
      stitchAdmission: "accepted",
      sourceToken: adapters.getQuickSourceToken(target),
      dataUrl: canvas.toDataURL("image/jpeg", Number(adapters.imageJpegQuality || 0.82)),
      imageUrl: `kakao-stitch:${sourceKeys.join("|")}`,
      width: canonicalWidth,
      height: compositeHeight,
      stitchKey: `${adapters.computeTargetKey(target)}|stitch:${previousSlice}:${nextSlice}|${sourceKeys.join("|")}`,
      singleImagePayload: ownerPayload,
      attachedShortPageKeys: [previousEntry, nextEntry]
        .filter((entry) => entry && entry.shortPageAttachment)
        .map((entry) => adapters.buildTargetSourceCacheKey(entry.targetKey, entry.src)),
      stitch: {
        canvasWidth: canonicalWidth,
        canvasHeight: compositeHeight,
        sourceKeys,
        verified: true,
        ocrMode: "stitch",
        owner: ownerEntry,
        previous: previousEntry,
        next: nextEntry,
        segments
      }
    };
  }

  function isKakaoStripPayload(payload, targetRect) {
    const payloadHeight = Number(payload && payload.height || 0);
    const payloadWidth = Number(payload && payload.width || 0);
    const cssHeight = Number(payload && payload.cssHeight || targetRect && targetRect.height || 0);
    const cssWidth = Number(payload && payload.cssWidth || targetRect && targetRect.width || 0);
    return payloadHeight < 220 ||
      cssHeight < 180 ||
      payloadWidth / Math.max(1, payloadHeight) > 5.2 ||
      cssWidth / Math.max(1, cssHeight) > 5.2;
  }

  function hasUsefulKakaoOverlapCrop(cropTop, cropHeight, currentHeight) {
    const sourceHeight = Math.max(1, Number(currentHeight) || 1);
    const uniqueHeight = Number(cropHeight) || 0;
    return (
      Number(cropTop) > 0 &&
      uniqueHeight >= KAKAO_OVERLAP_MIN_UNIQUE_PX &&
      uniqueHeight / sourceHeight >= KAKAO_OVERLAP_MIN_UNIQUE_RATIO
    );
  }

  /** 检测相邻图片的重复像素并裁掉当前页顶部重叠区域。 */
  async function maybeCropKakaoOverlappedPayload(target, payload, adapters) {
    if (
      !adapters.isReadyImageTarget(target) ||
      !payload ||
      payload.kakaoOverlapCrop === true ||
      !adapters.isDataUrl(payload.dataUrl) ||
      adapters.directCapture !== true
    ) {
      return null;
    }
    const ordered = adapters.collectCandidates(target).filter(adapters.isReadyImageTarget);
    const index = ordered.indexOf(target);
    const entries = buildKakaoStitchCandidateEntries(ordered, adapters.describeTarget);
    const currentDescriptor = entries[index] && entries[index].descriptor;
    const previous = findKakaoStitchNeighborTarget(entries, index, "previous");
    const previousDescriptor = adapters.describeTarget(previous);
    if (
      !previous ||
      !isVerifiedKakaoStitchNeighbor(previousDescriptor, currentDescriptor, "next") ||
      isAttachableKakaoShortPage(
        currentDescriptor,
        previousDescriptor,
        currentDescriptor && currentDescriptor.height,
        previousDescriptor && previousDescriptor.height
      )
    ) {
      return null;
    }

    const previousPayload = await adapters.getNeighborPayload(previous);
    if (!previousPayload || !adapters.isDataUrl(previousPayload.dataUrl)) {
      return null;
    }
    const [previousImage, currentImage] = await Promise.all([
      adapters.loadImage(previousPayload.dataUrl),
      adapters.loadImage(payload.dataUrl)
    ]);
    const currentWidth = currentImage.naturalWidth || currentImage.width || Number(payload.width || 0);
    const currentHeight = currentImage.naturalHeight || currentImage.height || Number(payload.height || 0);
    const previousWidth = previousImage.naturalWidth || previousImage.width || Number(previousPayload.width || 0);
    const previousHeight = previousImage.naturalHeight || previousImage.height || Number(previousPayload.height || 0);
    if (
      !(currentWidth > 0 && currentHeight > 0 && previousWidth > 0 && previousHeight > 0) ||
      Math.min(currentWidth, previousWidth) / Math.max(currentWidth, previousWidth) < KAKAO_STITCH_MIN_WIDTH_RATIO
    ) {
      return null;
    }

    const overlap = findKakaoVerticalOverlap(
      adapters.sampleImage(previousImage),
      adapters.sampleImage(currentImage)
    );
    if (!overlap || !overlap.accepted) {
      return null;
    }
    const cropTop = Math.round((overlap.rows / Math.max(1, overlap.currentRows)) * currentHeight);
    const cropHeight = currentHeight - cropTop;
    if (!hasUsefulKakaoOverlapCrop(cropTop, cropHeight, currentHeight)) {
      return null;
    }

    const canvas = adapters.createCanvas(currentWidth, cropHeight);
    const context = canvas && canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(currentImage, 0, cropTop, currentWidth, cropHeight, 0, 0, currentWidth, cropHeight);
    const rect = adapters.getTargetRect(target);
    const cssWidth = Number(payload.cssWidth || rect.width || 0);
    const cssHeight = Number(payload.cssHeight || rect.height || 0);
    const cropCssY = cssHeight * (cropTop / Math.max(1, currentHeight));
    const cropCssHeight = cssHeight * (cropHeight / Math.max(1, currentHeight));
    return {
      ...payload,
      dataUrl: canvas.toDataURL("image/jpeg", Number(adapters.imageJpegQuality || 0.82)),
      width: currentWidth,
      height: cropHeight,
      source: "kakao-overlap-crop",
      coordinateSpace: "source-image-v1",
      kakaoOverlapCrop: true,
      overlapCropTop: cropTop,
      imageUrl: `${payload.imageUrl || adapters.getQuickSourceToken(target)}#overlap-crop-${cropTop}`,
      displayRect: {
        offsetX: 0,
        offsetY: cropCssY,
        width: cssWidth,
        height: cropCssHeight
      }
    };
  }

  /* =================================================================
   * 拼接结果映射（纯）
   * ================================================================= */
  function normalizeKakaoStitchSegments(stitch, compositeWidth, compositeHeight, ownerDraw) {
    const rawSegments = Array.isArray(stitch && stitch.segments) ? stitch.segments : [];
    const segments = rawSegments
      .filter((seg) => seg && seg.drawRect)
      .map((seg) => ({ ...seg, drawRect: normalizeRectLike(seg.drawRect) }))
      .filter((seg) => seg.drawRect && seg.drawRect.w > 0 && seg.drawRect.h > 0);
    if (segments.length > 0) return segments;

    // Fallback: derive from canvas dimensions and ownerDraw
    const cw = Number(stitch && stitch.canvasWidth) || compositeWidth;
    const ch = Number(stitch && stitch.canvasHeight) || compositeHeight;
    const prevSlice = Math.max(0, Number(
      stitch && (stitch.previousSlice || (stitch.previous && stitch.previous.drawRect && stitch.previous.drawRect.h))
    ) || 0);
    const nextSlice = Math.max(0, Number(
      stitch && (stitch.nextSlice || (stitch.next && stitch.next.drawRect && stitch.next.drawRect.h))
    ) || 0);
    const owner = normalizeRectLike(ownerDraw) || {
      x: 0, y: prevSlice, w: cw,
      h: Math.max(1, ch - prevSlice - nextSlice)
    };
    const fallback = [];
    if (prevSlice > 0) {
      fallback.push({ source: "previous", drawRect: { x: 0, y: 0, w: cw, h: prevSlice } });
    }
    fallback.push({ source: "owner", drawRect: owner });
    if (nextSlice > 0) {
      fallback.push({ source: "next", drawRect: { x: 0, y: owner.y + owner.h, w: cw, h: nextSlice } });
    }
    return fallback;
  }

  function getKakaoStitchBestOverlap(bubbleRect, segments) {
    if (!bubbleRect || !Array.isArray(segments) || segments.length === 0) return null;
    const area = Math.max(1, bubbleRect.w * bubbleRect.h);
    const ranked = segments
      .map((seg) => {
        const rect = seg && seg.drawRect;
        if (!rect) return { segment: seg, ratio: 0 };
        const left = Math.max(bubbleRect.x, rect.x);
        const top = Math.max(bubbleRect.y, rect.y);
        const right = Math.min(bubbleRect.x + bubbleRect.w, rect.x + rect.w);
        const bottom = Math.min(bubbleRect.y + bubbleRect.h, rect.y + rect.h);
        const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
        return { segment: seg, ratio: overlap / area };
      })
      .sort((a, b) => b.ratio - a.ratio);
    return ranked[0] || null;
  }

  function getKakaoStitchOwnerOverlap(bubbleRect, segments) {
    const best = getKakaoStitchBestOverlap(bubbleRect, segments);
    return best && best.segment && best.segment.source === "owner" && best.ratio >= 0.6 ? best : null;
  }

  function mapKakaoStitchedFillBox(box, ownerY, ownerH, compositeH) {
    if (!box || typeof box !== "object") return null;
    const x = Number(box.x);
    const y = Number(box.y);
    const w = Number(box.w);
    const h = Number(box.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const topPx = (y / 100) * compositeH;
    const heightPx = (h / 100) * compositeH;
    const mappedH = (heightPx / ownerH) * 100;
    if (mappedH > 300) return null;
    return { x, y: ((topPx - ownerY) / ownerH) * 100, w, h: mappedH };
  }

  function mapKakaoStitchedPolygon(points, ownerY, ownerH, compositeH) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const mapped = points.map((point) => {
      const x = Number(point && point.x);
      const rawY = Number(point && point.y);
      if (!Number.isFinite(x) || !Number.isFinite(rawY)) return null;
      const pixY = (rawY / 100) * compositeH;
      return { x, y: ((pixY - ownerY) / ownerH) * 100 };
    });
    return mapped.every(Boolean) ? mapped : null;
  }

  /**
   * Sutherland-Hodgman polygon clipping against owner top/bottom boundaries.
   * Clips polygon points to the horizontal strip [ownerTop, ownerBottom].
   * Returns the clipped polygon, or null if entirely outside.
   */
  function clipKakaoPolygonToOwnerBounds(points, ownerTop, ownerBottom) {
    if (!Array.isArray(points) || points.length < 3) return null;

    const clipEdge = (input, edgeY, isTop) => {
      if (input.length === 0) return [];
      const result = [];
      for (let i = 0; i < input.length; i++) {
        const current = input[i];
        const previous = input[(i + input.length - 1) % input.length];
        const currentInside = isTop ? current.y >= edgeY : current.y <= edgeY;
        const previousInside = isTop ? previous.y >= edgeY : previous.y <= edgeY;

        if (currentInside) {
          if (!previousInside) {
            const t = (edgeY - previous.y) / (current.y - previous.y);
            if (Number.isFinite(t)) {
              result.push({ x: previous.x + t * (current.x - previous.x), y: edgeY });
            }
          }
          result.push(current);
        } else if (previousInside) {
          const t = (edgeY - previous.y) / (current.y - previous.y);
          if (Number.isFinite(t)) {
            result.push({ x: previous.x + t * (current.x - previous.x), y: edgeY });
          }
        }
      }
      return result;
    };

    let output = clipEdge(points, ownerTop, true);   // clip top
    output = clipEdge(output, ownerBottom, false);     // clip bottom

    return output.length >= 3 ? output : null;
  }

  function computeKakaoGlobalBox(bubblePercent, scrollX, scrollY, targetRect) {
    if (!targetRect || !(targetRect.width > 0) || !(targetRect.height > 0)) return null;
    const bx = Number(bubblePercent.x);
    const by = Number(bubblePercent.y);
    const bw = Number(bubblePercent.w);
    const bh = Number(bubblePercent.h);
    if (![bx, by, bw, bh].every(Number.isFinite)) return null;
    return {
      left: targetRect.left + (scrollX || 0) + (bx / 100) * targetRect.width,
      top: targetRect.top + (scrollY || 0) + (by / 100) * targetRect.height,
      width: (bw / 100) * targetRect.width,
      height: (bh / 100) * targetRect.height
    };
  }

  /**
   * mapKakaoStitchedResult — 将拼接画布上的 OCR 气泡映射回 owner 图像坐标系。
   * 纯函数：不依赖 DOM / scroll 状态，scrollX/Y 显式传入。
   */
  function mapKakaoStitchedResult(result, payloadStitch, targetRect, scrollX, scrollY) {
    if (!payloadStitch || !result || !Array.isArray(result.bubbles)) {
      return result;
    }
    const canvasWidth = Math.max(1, Number(payloadStitch.canvasWidth || 1));
    const canvasHeight = Math.max(1, Number(payloadStitch.canvasHeight || 1));
    const ownerDraw = payloadStitch.owner && payloadStitch.owner.drawRect
      ? payloadStitch.owner.drawRect
      : { x: 0, y: 0, w: canvasWidth, h: canvasHeight };
    const segments = normalizeKakaoStitchSegments(payloadStitch, canvasWidth, canvasHeight, ownerDraw);

    // Compute seam boundaries between owner and neighbor segments
    const seamBoundaries = [];
    for (const seg of segments) {
      if (seg && seg.drawRect) {
        if (seg.source === "previous") {
          seamBoundaries.push(seg.drawRect.y + seg.drawRect.h);
        } else if (seg.source === "next") {
          seamBoundaries.push(seg.drawRect.y);
        }
      }
    }

    const minCrossPx = Math.max(KAKAO_STITCH_MIN_CROSS_PX, canvasHeight * KAKAO_STITCH_MIN_CROSS_RATIO);

    const mapped = result.bubbles.map((bubble) => {
      const bx = Number(bubble.x);
      const by = Number(bubble.y);
      const bw = Number(bubble.w);
      const bh = Number(bubble.h);
      if (![bx, by, bw, bh].every(Number.isFinite) || bw <= 0 || bh <= 0) {
        return null;
      }

      const bubblePx = {
        x: (bx / 100) * canvasWidth,
        y: (by / 100) * canvasHeight,
        w: (bw / 100) * canvasWidth,
        h: (bh / 100) * canvasHeight
      };

      const crossesSeam = seamBoundaries.some((seamY) =>
        bubblePx.y < seamY - minCrossPx &&
        (bubblePx.y + bubblePx.h) > seamY + minCrossPx
      );
      const crossesSeamWithClip = crossesSeam
        ? clipKakaoPolygonToOwnerBounds(bubble.polygon, ownerDraw.y, ownerDraw.y + ownerDraw.h)
        : null;

      const bubbleArea = Math.max(1, bubblePx.w * bubblePx.h);
      const ranked = segments.map((seg) => {
        const rect = seg && seg.drawRect;
        if (!rect) return { segment: seg, ratio: 0 };
        const left = Math.max(bubblePx.x, rect.x);
        const top = Math.max(bubblePx.y, rect.y);
        const right = Math.min(bubblePx.x + bubblePx.w, rect.x + rect.w);
        const bottom = Math.min(bubblePx.y + bubblePx.h, rect.y + rect.h);
        const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
        return { segment: seg, ratio: overlap / bubbleArea };
      }).sort((a, b) => b.ratio - a.ratio);

      const best = ranked[0];
      const ownerRank = ranked.find((r) => r.segment && r.segment.source === "owner");
      const ownerRatio = ownerRank ? ownerRank.ratio : 0;

      const isShortPageAttachment = best && best.segment &&
        best.segment.shortPageAttachment === true &&
        (best.segment.source === "previous" || best.segment.source === "next") &&
        best.ratio >= 0.6;

      if (!isShortPageAttachment && (!best || !best.segment || best.segment.source !== "owner" || best.ratio < 0.6)) {
        const boundaryNeighbor = mapKakaoAdjacentBoundaryRect(
          bubblePx, best, ownerDraw, canvasHeight
        );
        if (boundaryNeighbor) {
          return {
            ...bubble,
            ...boundaryNeighbor,
            stitch_overflow: true,
            stitch_boundary_neighbor: true,
            crossesSeam: false,
            sourceType: "seam",
            clippedPolygon: null,
            fill_box: mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
            polygon: mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
            region_polygon: mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
          };
        }
        return null;
      }

      if (isShortPageAttachment) {
        const mappedY = ((bubblePx.y - ownerDraw.y) / ownerDraw.h) * 100;
        const mappedH = (bubblePx.h / ownerDraw.h) * 100;
        if (mappedY + mappedH < -80 || mappedY > 180 || mappedH > 70) return null;
        return {
          ...bubble,
          x: ((bubblePx.x - ownerDraw.x) / ownerDraw.w) * 100,
          y: mappedY,
          w: (bubblePx.w / ownerDraw.w) * 100,
          h: mappedH,
          stitch_overflow: true,
          stitch_attached_short_page: true,
          crossesSeam,
          sourceType: crossesSeam ? "seam" : "single",
          clippedPolygon: crossesSeamWithClip,
          fill_box: mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
          polygon: mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
          region_polygon: mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
        };
      }

      // Overflow handling
      const crossesBoundary = bubblePx.y < ownerDraw.y ||
        (bubblePx.y + bubblePx.h) > (ownerDraw.y + ownerDraw.h);
      const overflow = crossesBoundary && ownerRatio >= 0.25;

      if (overflow) {
        const mappedY = ((bubblePx.y - ownerDraw.y) / ownerDraw.h) * 100;
        const mappedH = (bubblePx.h / ownerDraw.h) * 100;
        if (mappedY + mappedH < -35 || mappedY > 135 || mappedH > 60) return null;
        return {
          ...bubble,
          x: ((bubblePx.x - ownerDraw.x) / ownerDraw.w) * 100,
          y: mappedY,
          w: (bubblePx.w / ownerDraw.w) * 100,
          h: mappedH,
          stitch_overflow: true,
          crossesSeam,
          sourceType: crossesSeam ? "seam" : "single",
          clippedPolygon: crossesSeamWithClip,
          fill_box: mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
          polygon: mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
          region_polygon: mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
        };
      }

      // Normal bubble: clip to owner drawRect
      const clippedLeft = Math.max(bubblePx.x, ownerDraw.x);
      const clippedTop = Math.max(bubblePx.y, ownerDraw.y);
      const clippedRight = Math.min(bubblePx.x + bubblePx.w, ownerDraw.x + ownerDraw.w);
      const clippedBottom = Math.min(bubblePx.y + bubblePx.h, ownerDraw.y + ownerDraw.h);
      const clippedW = Math.max(0, clippedRight - clippedLeft);
      const clippedH = Math.max(0, clippedBottom - clippedTop);
      if (clippedW <= 0 || clippedH <= 0) return null;

      const mappedX = ((clippedLeft - ownerDraw.x) / ownerDraw.w) * 100;
      const mappedY = ((clippedTop - ownerDraw.y) / ownerDraw.h) * 100;
      const mappedW = (clippedW / ownerDraw.w) * 100;
      const mappedH = (clippedH / ownerDraw.h) * 100;

      const lineCount = getBubbleLineCount(bubble);
      const maxH = lineCount > 1 ? 60 : 35;
      if (mappedX < -5 || mappedX + mappedW > 105 ||
          mappedY < -5 || mappedY + mappedH > 105) {
        return null;
      }

      const clampedHfinal = mappedH > maxH ? maxH : mappedH;
      const clampAdjusted = mappedH !== clampedHfinal;

      return {
        ...bubble,
        x: mappedX,
        y: mappedY,
        w: mappedW,
        h: clampedHfinal,
        stitch_overflow: false,
        crossesSeam,
        sourceType: crossesSeam ? "seam" : "single",
        clippedPolygon: clampAdjusted ? null : crossesSeamWithClip,
        fill_box: clampAdjusted ? null : mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
        polygon: clampAdjusted ? null : mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
        region_polygon: clampAdjusted ? null : mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
      };
    }).filter(Boolean);

    // Drop stitched bubbles that don't cross the seam — they duplicate single-page OCR.
    // Only applies when there are actual neighbor seam boundaries to cross
    // and no short-page attachments are involved (short pages need full mapping).
    const hasShortPageAttachments = segments.some((seg) => seg && seg.shortPageAttachment === true);
    const filtered = (seamBoundaries.length === 0 || hasShortPageAttachments)
      ? mapped
      : mapped.filter((bubble) =>
          bubble.stitch_boundary_neighbor === true ||
          bubble.stitch_attached_short_page === true ||
          bubble.crossesSeam === true ||
          bubble.stitch_overflow === true
        );

    return {
      ...result,
      bubbles: filtered,
      debug: normalizeKakaoStitchDebugCoordinates(result.debug, payloadStitch)
    };
  }

  function mapKakaoAdjacentBoundaryRect(rect, rankedEntry, ownerRect, canvasHeight) {
    const segment = rankedEntry && rankedEntry.segment;
    const segmentRect = segment && segment.drawRect;
    if (
      !rect || !segmentRect ||
      (segment.source !== "previous" && segment.source !== "next") ||
      segment.shortPageAttachment === true
    ) {
      return null;
    }

    const contextSlice = segmentRect.h <= ownerRect.h * 0.45;
    if (!contextSlice) return null;

    const expectedEdge = segment.source === "previous"
      ? ownerRect.y : ownerRect.y + ownerRect.h;
    const actualEdge = segment.source === "previous"
      ? segmentRect.y + segmentRect.h : segmentRect.y;
    if (Math.abs(actualEdge - expectedEdge) > Math.max(2, ownerRect.h * 0.02)) {
      return null;
    }

    const rectTop = rect.y;
    const rectBottom = rect.y + rect.h;
    const crossesOwnerEdge = segment.source === "previous"
      ? rectTop < ownerRect.y && rectBottom > ownerRect.y
      : rectTop < ownerRect.y + ownerRect.h && rectBottom > ownerRect.y + ownerRect.h;
    const requiredRatio = crossesOwnerEdge ? 0.45 : 0.6;
    if (rankedEntry.ratio < requiredRatio) return null;

    const mappedY = ((rect.y - ownerRect.y) / ownerRect.h) * 100;
    const mappedH = (rect.h / ownerRect.h) * 100;
    const segmentStart = ((segmentRect.y - ownerRect.y) / ownerRect.h) * 100;
    const segmentEnd = ((segmentRect.y + segmentRect.h - ownerRect.y) / ownerRect.h) * 100;
    const tolerance = 5;
    const inPreviousSlice = segment.source === "previous" &&
      mappedY <= tolerance &&
      mappedY + mappedH >= segmentStart - tolerance;
    const inNextSlice = segment.source === "next" &&
      mappedY + mappedH >= 100 - tolerance &&
      mappedY <= segmentEnd + tolerance;

    if ((!inPreviousSlice && !inNextSlice) || mappedH <= 0 || mappedH > 60) return null;

    return {
      x: ((rect.x - ownerRect.x) / ownerRect.w) * 100,
      y: mappedY,
      w: (rect.w / ownerRect.w) * 100,
      h: mappedH
    };
  }

  /* =================================================================
   * 回退检测（纯）
   * ================================================================= */
  function shouldFallbackFromKakaoStitch(stitchPayload, rawResult, mappedResult) {
    if (!stitchPayload || !stitchPayload.stitch || !stitchPayload.singleImagePayload) {
      return "";
    }
    const rawBubbles = rawResult && Array.isArray(rawResult.bubbles) ? rawResult.bubbles : [];
    const mappedBubbles = mappedResult && Array.isArray(mappedResult.bubbles) ? mappedResult.bubbles : [];
    if (rawBubbles.length === 0) return "stitched OCR produced no owner text";
    if (mappedBubbles.length === 0 && rawBubbles.length > 0) return "stitched OCR dropped all bubbles";

    const dropRatio = rawBubbles.length > 0 ? (rawBubbles.length - mappedBubbles.length) / rawBubbles.length : 0;
    if (dropRatio > 0.7) return "stitched OCR drop ratio exceeded 70%";

    const invalid = mappedBubbles.some((bubble) => {
      const values = [bubble.x, bubble.y, bubble.w, bubble.h].map((v) => Number(v));
      if (values.some((v) => !Number.isFinite(v))) return true;
      const bw = values[2];
      const bh = values[3];
      if (bw <= 0 || bh <= 0) return true;
      const bx = values[0];
      const by = values[1];
      if (bubble.stitch_overflow) {
        if (by + bh < -35 || by > 135) return true;
        if (bh > 60) return true;
      } else {
        if (bx < -5 || bx + bw > 105) return true;
        if (by < -5 || by + bh > 105) return true;
        const lineCount = getBubbleLineCount(bubble);
        if (bh > (lineCount > 1 ? 60 : 35)) return true;
      }
      return false;
    });
    return invalid ? "stitched OCR produced implausible owner coordinates" : "";
  }

  /* =================================================================
   * 调试坐标映射（纯）
   * ================================================================= */
  function normalizeKakaoStitchDebugCoordinates(debug, stitch) {
    if (!debug || !stitch) return debug;
    const cw = Math.max(1, Number(stitch.canvasWidth || stitch.compositeWidth) || Number(debug.imageWidth) || 1);
    const ch = Math.max(1, Number(stitch.canvasHeight || stitch.compositeHeight) || Number(debug.imageHeight) || 1);
    const ownerDraw = stitch.owner && stitch.owner.drawRect
      ? stitch.owner.drawRect
      : { x: 0, y: 0, w: cw, h: ch };
    const ownerRect = normalizeRectLike(ownerDraw) || { x: 0, y: 0, w: cw, h: ch };
    const ctx = {
      stitch,
      compositeWidth: cw,
      compositeHeight: ch,
      ownerDraw: ownerRect,
      segments: normalizeKakaoStitchSegments(stitch, cw, ch, ownerRect)
    };
    return {
      ...debug,
      imageWidth: ownerRect.w,
      imageHeight: ownerRect.h,
      rawItems: normalizeDebugCoordinateItems(debug.rawItems, debug, ctx),
      duplicateItems: normalizeDebugCoordinateItems(debug.duplicateItems, debug, ctx),
      dedupedItems: normalizeDebugCoordinateItems(debug.dedupedItems, debug, ctx)
    };
  }

  function normalizeDebugCoordinateItems(items, debug, context) {
    if (!Array.isArray(items)) return [];
    if (!context || !context.stitch) return items;
    const imageWidth = Math.max(1, Number(debug && debug.imageWidth) || Number(context.compositeWidth) || 1);
    const imageHeight = Math.max(1, Number(debug && debug.imageHeight) || Number(context.compositeHeight) || 1);
    const compositeWidth = Math.max(1, Number(context.compositeWidth) || imageWidth);
    const compositeHeight = Math.max(1, Number(context.compositeHeight) || imageHeight);
    const ownerDraw = context.ownerDraw || { x: 0, y: 0, w: compositeWidth, h: compositeHeight };
    const segments = Array.isArray(context.segments) ? context.segments : [];
    return items.map((item) => {
      const percent = getDebugItemPercent(item, imageWidth, imageHeight);
      if (!percent) return null;
      const rect = {
        x: (Number(percent.x) / 100) * compositeWidth,
        y: (Number(percent.y) / 100) * compositeHeight,
        w: (Number(percent.w) / 100) * compositeWidth,
        h: (Number(percent.h) / 100) * compositeHeight
      };
      const ownerOverlap = getKakaoStitchOwnerOverlap(rect, segments);
      const mapped = ownerOverlap
        ? mapKakaoOwnerDebugRect(rect, ownerDraw)
        : mapKakaoAdjacentBoundaryRect(rect, getKakaoStitchBestOverlap(rect, segments), ownerDraw, compositeHeight);
      return mapped && mapped.w > 0 && mapped.h > 0 ? { ...item, percent: mapped } : null;
    }).filter(Boolean);
  }

  function getDebugItemPercent(item, imageWidth, imageHeight) {
    if (item && item.percent &&
        [item.percent.x, item.percent.y, item.percent.w, item.percent.h].every((v) => Number.isFinite(Number(v)))) {
      return item.percent;
    }
    const box = item && (item.rawBox || item.box);
    if (!box || ![box.left, box.top, box.width, box.height].every((v) => Number.isFinite(Number(v)))) return null;
    return {
      x: (Number(box.left) / imageWidth) * 100,
      y: (Number(box.top) / imageHeight) * 100,
      w: (Number(box.width) / imageWidth) * 100,
      h: (Number(box.height) / imageHeight) * 100
    };
  }

  function mapKakaoOwnerDebugRect(rect, ownerDraw) {
    const left = Math.max(rect.x, ownerDraw.x);
    const top = Math.max(rect.y, ownerDraw.y);
    const right = Math.min(rect.x + rect.w, ownerDraw.x + ownerDraw.w);
    const bottom = Math.min(rect.y + rect.h, ownerDraw.y + ownerDraw.h);
    return {
      x: ((left - ownerDraw.x) / ownerDraw.w) * 100,
      y: ((top - ownerDraw.y) / ownerDraw.h) * 100,
      w: (Math.max(0, right - left) / ownerDraw.w) * 100,
      h: (Math.max(0, bottom - top) / ownerDraw.h) * 100
    };
  }

  /* =================================================================
   * 调试气泡过滤（纯）
   * ================================================================= */
  function filterOcrDebugFinalBubbles(debug, bubbles) {
    if (!debug || typeof debug !== "object") return debug;
    const keptBlockIds = new Set(
      (Array.isArray(bubbles) ? bubbles : [])
        .map((b) => String(b && (b.block_id || b.id) || ""))
        .filter(Boolean)
    );
    const finalBubbles = (Array.isArray(debug.finalBubbles) ? debug.finalBubbles : [])
      .filter((item) => keptBlockIds.has(String(item && (item.blockId || item.block_id || item.id) || "")));
    return { ...debug, finalBubbles, items: finalBubbles };
  }

  function syncOcrDebugFinalBubbles(debug, bubbles) {
    const filtered = filterOcrDebugFinalBubbles(debug, bubbles);
    if (!filtered) return filtered;
    const byId = new Map(
      (Array.isArray(bubbles) ? bubbles : []).map((b) => [
        String(b && (b.block_id || b.id) || ""),
        b
      ])
    );
    const finalBubbles = filtered.finalBubbles.map((item) => {
      const bubble = byId.get(String(item && (item.blockId || item.block_id || item.id) || ""));
      return bubble ? {
        ...item,
        text: bubble.original_text,
        translatedText: bubble.translated_text,
        percent: { x: bubble.x, y: bubble.y, w: bubble.w, h: bubble.h }
      } : item;
    });
    return { ...filtered, finalBubbles, items: finalBubbles };
  }

  /* =================================================================
   * 去重函数（纯——状态由 Store 管理）
   * ================================================================= */
  function trimKakaoBubbleBoundary(bubble, overlap) {
    if (!bubble || !overlap || !(overlap.length > 0)) return null;
    const originalText = String(bubble.original_text || "");
    const normalizedLength = Math.max(1, normalizeOcrSimilarityText(originalText).length);
    const uniqueLength = normalizedLength - overlap.length;
    if (uniqueLength < 2) return null;
    const keepRatio = Math.max(0.12, Math.min(1, uniqueLength / normalizedLength));
    const keepSuffix = overlap.trim === "prefix";
    const uniqueText = sliceTextByNormalizedBoundary(originalText, overlap.length, keepSuffix);
    if (normalizeOcrSimilarityText(uniqueText).length < 2) return null;
    const originalY = Number(bubble.y);
    const originalH = Number(bubble.h);
    const nextY = keepSuffix ? originalY + originalH * (1 - keepRatio) : originalY;
    const nextH = originalH * keepRatio;
    const globalBox = bubble.global_box ? {
      ...bubble.global_box,
      top: keepSuffix
        ? Number(bubble.global_box.top) + Number(bubble.global_box.height) * (1 - keepRatio)
        : Number(bubble.global_box.top),
      height: Number(bubble.global_box.height) * keepRatio
    } : null;
    return {
      ...bubble,
      original_text: uniqueText,
      translated_text: "",
      y: nextY,
      h: nextH,
      fill_box: null,
      polygon: null,
      region_polygon: null,
      global_box: globalBox,
      source_line_count: Math.max(1, Math.round(Number(bubble.source_line_count || 1) * keepRatio)),
      boundary_trimmed: true
    };
  }

  function isKakaoBoundaryNeighborBubble(bubble) {
    return !!(bubble && bubble.stitch_boundary_neighbor);
  }

  function isKakaoBoundaryOwnPair(candidate, entry) {
    return isKakaoBoundaryNeighborBubble(candidate && candidate.bubble) !==
      isKakaoBoundaryNeighborBubble(entry && entry.bubble);
  }

  function isKakaoBoundaryOwnDuplicateCandidate(candidate, entry) {
    return areOcrTextsDuplicateOrContained(candidate.text, entry.text) ||
      hasSubstantialOcrTokenOverlap(candidate.text, entry.text);
  }

  function selectKakaoVisualDuplicateLoser(left, right) {
    const leftKey = String(left && left.scopeKey || "");
    const rightKey = String(right && right.scopeKey || "");
    if (!leftKey || !rightKey || leftKey === rightKey) return null;

    const leftRegion = String(left && left.regionType || "").trim();
    const rightRegion = String(right && right.regionType || "").trim();
    if (!leftRegion || leftRegion !== rightRegion) return null;

    const leftOverflow = left && left.stitchOverflow === true;
    const rightOverflow = right && right.stitchOverflow === true;
    if (!leftOverflow && !rightOverflow) return null;

    const leftBox = left && left.box;
    const rightBox = right && right.box;
    if (!leftBox || !rightBox) return null;
    const leftArea = Number(leftBox.width) * Number(leftBox.height);
    const rightArea = Number(rightBox.width) * Number(rightBox.height);
    if (!(leftArea > 0) || !(rightArea > 0)) return null;

    const areaRatio = Math.min(leftArea, rightArea) / Math.max(leftArea, rightArea);
    if (areaRatio < KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO ||
        pageBoxIntersectionRatio(leftBox, rightBox) < KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION) {
      return null;
    }

    // owner/overflow 成对时始终保留 owner；两个 overflow 副本则必须有文本证据，
    // 避免仅凭相邻页边界处的几何重叠误删不同对白。
    if (leftOverflow && rightOverflow) {
      const leftOriginal = normalizeOcrSimilarityText(left && left.originalText);
      const rightOriginal = normalizeOcrSimilarityText(right && right.originalText);
      const leftTranslated = normalizeOcrSimilarityText(left && left.translatedText);
      const rightTranslated = normalizeOcrSimilarityText(right && right.translatedText);
      const textRelated = areOcrTextsDuplicateOrContained(leftOriginal, rightOriginal) ||
        areOcrTextsDuplicateOrContained(leftTranslated, rightTranslated);
      if (!textRelated) return null;

      const leftCompleteness = Math.max(leftOriginal.length, leftTranslated.length);
      const rightCompleteness = Math.max(rightOriginal.length, rightTranslated.length);
      if (leftCompleteness !== rightCompleteness) {
        return leftCompleteness < rightCompleteness ? "left" : "right";
      }
      if (leftArea !== rightArea) {
        return leftArea < rightArea ? "left" : "right";
      }
      return "right";
    }
    return leftOverflow ? "left" : "right";
  }

  function isKakaoCrossPageOverflowGeometryDuplicate(candidate, entry) {
    const candidateKey = String(candidate && candidate.targetKey || "");
    const entryKey = String(entry && entry.targetKey || "");
    const candidateBubble = candidate && candidate.bubble;
    const entryBubble = entry && entry.bubble;
    return !!selectKakaoVisualDuplicateLoser(
      {
        scopeKey: candidateKey,
        regionType: candidateBubble && candidateBubble.region_type,
        stitchOverflow: candidateBubble && candidateBubble.stitch_overflow === true,
        originalText: candidate && candidate.text,
        translatedText: candidate && candidate.translatedText,
        box: candidate.box
      },
      {
        scopeKey: entryKey,
        regionType: entryBubble && entryBubble.region_type,
        stitchOverflow: entryBubble && entryBubble.stitch_overflow === true,
        originalText: entry && entry.text,
        translatedText: entry && entry.translatedText,
        box: entry.box
      }
    );
  }

  function isKakaoGlobalDuplicateCandidate(candidate, entry) {
    if (!candidate || !entry || !candidate.box || !entry.box) return false;
    if (!areKakaoGlobalBoxesRelated(candidate.box, entry.box)) return false;
    if (isKakaoCrossPageOverflowGeometryDuplicate(candidate, entry)) return true;
    if (isKakaoBoundaryOwnPair(candidate, entry)) {
      return isKakaoBoundaryOwnDuplicateCandidate(candidate, entry);
    }
    const sourceRelated = areOcrTextsDuplicateOrContained(candidate.text, entry.text);
    const translationRelated = areOcrTextsDuplicateOrContained(candidate.translatedText, entry.translatedText);
    return sourceRelated || translationRelated;
  }

  /* =================================================================
   * Store — 封装 Kakao 全局去重与页面状态
   * ================================================================= */
  function createStore() {
    /** @type {Map<string, Array<{box, text, translatedText, completeness, targetKey}>>} */
    const globalOcrEntries = new Map();

    /** @type {Map<string, string>}  pageJobPhase: targetKey → phase */
    const pageJobPhase = new Map();

    /** @type {Map<string, Promise>} 合并中的重复请求 */
    const inflightJobs = new Map();

    /** 当前页面作业身份，避免依赖 DOM dataset 充当并发锁。 */
    const currentJobs = new Map();

    /** 短页附着关系仅由 Store 管理。 */
    let shortPageAttachments = new WeakMap();

    /** 页面重试计时器及计数。 */
    const retryStates = new Map();

    /** @type {number} 去重事务序列号，用于调试 */
    let dedupeTxnSeq = 0;

    /** 串行化去重锁 */
    let dedupeLock = Promise.resolve();

    /* Canonical pipeline semantic state. DOM handles are only bindings. */
    const pageHandles = new Map();
    let pageHandleByTarget = new WeakMap();
    const canonicalPagePhases = new Map();
    const pageTerminalStates = new Map();
    const observations = new Map();
    const observationIdsByPage = new Map();
    const filteredObservations = new Map();
    const seamStates = new Map();
    const canonicalSnapshots = new Map();
    const retiredCanonicalSnapshots = new Map();
    let reconcileDiagnostics = Object.freeze({});
    const coverageLedger = new Map();
    const projectionsByPage = new Map();
    const translationsByCanonicalRevision = new Map();
    const translationErrorsByCanonicalRevision = new Map();
    const pendingTranslationKeys = new Set();
    const pendingTranslationWaiters = new Map();
    const attemptedTranslationKeys = new Set();
    const edgeWaitStates = new Map();
    let reconcileTxnSeq = 0;
    let reconcileLock = Promise.resolve();

    const entrySource = Symbol("kakaoStoreEntrySource");
    const snapshotEntry = (entry) => {
      const snapshot = {
        ...entry,
        box: entry && entry.box ? Object.freeze({ ...entry.box }) : entry && entry.box
      };
      Object.defineProperty(snapshot, entrySource, {
        value: entry && entry[entrySource] || entry,
        enumerable: false
      });
      return Object.freeze(snapshot);
    };

    return {
      /* ---- 全局去重条目 ---- */

      /** 获取当前全部去重条目快照（不可变副本） */
      getGlobalEntries() {
        const all = [];
        for (const entries of globalOcrEntries.values()) {
          for (const entry of entries) {
            all.push(snapshotEntry(entry));
          }
        }
        return all;
      },

      /** 取指定 targetKey 的条目 */
      getEntriesForKey(targetKey) {
        const entries = globalOcrEntries.get(targetKey);
        return entries ? entries.map(snapshotEntry) : [];
      },

      /** 设置指定 targetKey 的条目（替换） */
      setEntriesForKey(targetKey, entries) {
        globalOcrEntries.set(
          targetKey,
          Array.isArray(entries) ? entries.map(snapshotEntry) : []
        );
      },

      /** 删除指定 targetKey 的所有条目 */
      deleteEntriesForKey(targetKey) {
        globalOcrEntries.delete(targetKey);
      },

      /** 从指定 targetKey 的条目列表中移除特定条目引用 */
      removeEntryFromKey(targetKey, entryToRemove) {
        const entries = globalOcrEntries.get(targetKey);
        if (!entries) return;
        const filtered = entries.filter((entry) =>
          entry !== entryToRemove &&
          entry[entrySource] !== entryToRemove &&
          entry[entrySource] !== (entryToRemove && entryToRemove[entrySource]) &&
          !(entryToRemove && entry.bubble && entry.bubble === entryToRemove.bubble)
        );
        if (filtered.length === 0) {
          globalOcrEntries.delete(targetKey);
        } else {
          globalOcrEntries.set(targetKey, filtered);
        }
      },

      /** 串行去重：所有去重操作排成一个队列，避免并发页面的竞态 */
      async runSerializedDedupe(fn) {
        dedupeTxnSeq += 1;
        const seq = dedupeTxnSeq;
        const operation = dedupeLock
          .catch(() => undefined)
          .then(() => fn({ seq, store: this, globalOcrEntries }));
        dedupeLock = operation.then(() => undefined, () => undefined);
        return operation;
      },

      /* ---- 页面 FSM 状态 ---- */

      getPagePhase(targetKey) {
        return pageJobPhase.get(targetKey) || PagePhase.WAITING;
      },

      /**
       * 推进 FSM 状态，返回 true 表示转换成功，false 表示非法转换
       * @param {string} targetKey
       * @param {string} toPhase
       * @returns {boolean}
       */
      transitionPagePhase(targetKey, toPhase) {
        const from = this.getPagePhase(targetKey);
        if (!canTransition(from, toPhase)) {
          console.warn(`[KakaoPipeline] Illegal FSM transition: ${from} → ${toPhase} for ${targetKey.slice(0, 80)}`);
          return false;
        }
        pageJobPhase.set(targetKey, toPhase);
        return true;
      },

      /** 只有当前 phase 匹配时才推进，防止迟到操作覆盖后续状态 */
      transitionIfCurrentPhase(targetKey, expectedFrom, toPhase) {
        const current = this.getPagePhase(targetKey);
        if (current !== expectedFrom) {
          return false;
        }
        return this.transitionPagePhase(targetKey, toPhase);
      },

      resetPagePhase(targetKey) {
        pageJobPhase.set(targetKey, PagePhase.WAITING);
      },

      deletePagePhase(targetKey) {
        pageJobPhase.delete(targetKey);
      },

      /** 检查页面是否在活动状态 */
      isPageActive(targetKey) {
        return isActivePhase(this.getPagePhase(targetKey));
      },

      beginPageJob(targetKey, identity) {
        currentJobs.set(targetKey, Object.freeze({
          runId: String(identity && identity.runId || ""),
          sourceToken: String(identity && identity.sourceToken || "")
        }));
      },

      isCurrentPageJob(targetKey, identity) {
        const current = currentJobs.get(targetKey);
        return !!current &&
          current.runId === String(identity && identity.runId || "") &&
          current.sourceToken === String(identity && identity.sourceToken || "");
      },

      finishPageJob(targetKey, identity) {
        if (!this.isCurrentPageJob(targetKey, identity)) {
          return false;
        }
        currentJobs.delete(targetKey);
        return true;
      },

      cancelPageJob(targetKey, identity = null) {
        if (identity && !this.isCurrentPageJob(targetKey, identity)) {
          return false;
        }
        currentJobs.delete(targetKey);
        const phase = this.getPagePhase(targetKey);
        if (canTransition(phase, PagePhase.CANCELLED)) {
          pageJobPhase.set(targetKey, PagePhase.CANCELLED);
        }
        return true;
      },

      getShortPageAttachment(target) {
        const value = shortPageAttachments.get(target);
        return value ? { ...value } : null;
      },

      attachShortPage(target, ownerKey, attachedAt = Date.now()) {
        const previous = shortPageAttachments.get(target) || {};
        shortPageAttachments.set(target, {
          ownerKey: String(ownerKey || ""),
          attachedAt: Number(attachedAt || 0),
          detachedOwnerKey: String(previous.detachedOwnerKey || ""),
          detachedAt: Number(previous.detachedAt || 0)
        });
      },

      releaseShortPage(target, ownerKey = "", detachedAt = Date.now()) {
        const previous = shortPageAttachments.get(target) || {};
        shortPageAttachments.set(target, {
          ownerKey: "",
          attachedAt: 0,
          detachedOwnerKey: String(ownerKey || previous.ownerKey || ""),
          detachedAt: Number(detachedAt || 0)
        });
      },

      clearShortPage(target) {
        shortPageAttachments.delete(target);
      },

      getRetryState(target) {
        const value = retryStates.get(target);
        return value ? { ...value } : null;
      },

      setRetryState(target, value) {
        retryStates.set(target, {
          timer: value && value.timer,
          attempts: Number(value && value.attempts || 0),
          retries: Number(value && value.retries || 0)
        });
      },

      clearRetryState(target) {
        const value = retryStates.get(target) || null;
        retryStates.delete(target);
        return value ? { ...value } : null;
      },

      clearRetryStates(clearTimer) {
        for (const value of retryStates.values()) {
          if (value.timer && typeof clearTimer === "function") {
            clearTimer(value.timer);
          }
        }
        retryStates.clear();
      },

      /* ---- 请求合并 ---- */

      /** 合并重复的 inflight 请求 */
      registerPageHandle(record) {
        if (!record || !record.pageId) throw new Error("KakaoPipeline: page handle requires pageId");
        const pageId = String(record.pageId);
        const previous = pageHandles.get(pageId) || null;
        const next = Object.freeze({ ...(previous || {}), ...record, pageId, imageRevision: String(record.imageRevision || "") });
        pageHandles.set(pageId, next);
        if (record.target && (typeof record.target === "object" || typeof record.target === "function")) {
          pageHandleByTarget.set(record.target, Object.freeze({
            pageId,
            imageRevision: String(record.imageRevision || "")
          }));
        }
        return next;
      },

      getPageHandle(pageId) {
        return pageHandles.get(String(pageId || "")) || null;
      },

      getPageRecord(pageId) {
        return pageHandles.get(String(pageId || "")) || null;
      },

      getPageHandleForTarget(target) {
        const binding = target && pageHandleByTarget.get(target);
        if (!binding) return null;
        const current = pageHandles.get(binding.pageId) || null;
        if (!current || String(current.imageRevision || "") !== String(binding.imageRevision || "")) return null;
        return current;
      },

      getPageBindingForTarget(target) {
        const binding = target && pageHandleByTarget.get(target);
        return binding ? { ...binding } : null;
      },

      getPageHandles() {
        return [...pageHandles.values()].sort(comparePageRecords);
      },

      unbindPageTarget(target) {
        if (!target) return false;
        const binding = pageHandleByTarget.get(target);
        pageHandleByTarget.delete(target);
        if (!binding) return false;
        const current = pageHandles.get(binding.pageId);
        if (current && current.target === target) pageHandles.set(binding.pageId, Object.freeze({ ...current, target: null }));
        return true;
      },

      setCanonicalPagePhase(pageId, phase, options = {}) {
        const key = String(pageId || "");
        const next = String(phase || CanonicalPhase.WAITING);
        const current = canonicalPagePhases.get(key) || CanonicalPhase.WAITING;
        // 已完成的同 revision clone 不得把共享页面状态倒退到中间阶段。
        if (current === CanonicalPhase.RENDERED && next !== CanonicalPhase.RENDERED && options.force !== true) {
          return false;
        }
        canonicalPagePhases.set(key, next);
        return true;
      },

      getCanonicalPagePhase(pageId) {
        return canonicalPagePhases.get(String(pageId || "")) || CanonicalPhase.WAITING;
      },

      markPageTerminal(pageId, state, details = null) {
        pageTerminalStates.set(String(pageId || ""), Object.freeze({ state: String(state || "ready"), details: details || null }));
      },

      getPageTerminal(pageId) {
        return pageTerminalStates.get(String(pageId || "")) || null;
      },

      upsertObservations(items, options = {}) {
        const ids = [];
        for (const item of Array.isArray(items) ? items : []) {
          if (!item || !item.id) continue;
          const frozen = freezeObservation(item);
          observations.set(frozen.id, frozen);
          ids.push(frozen.id);
          for (const pageId of frozen.pageIds) {
            if (!observationIdsByPage.has(pageId)) observationIdsByPage.set(pageId, new Set());
            observationIdsByPage.get(pageId).add(frozen.id);
          }
          if (options.filtered === true) filteredObservations.set(frozen.id, frozen);
          else filteredObservations.delete(frozen.id);
        }
        return ids;
      },

      replacePageRevisionObservations(pageId, imageRevision, items, filteredItems = []) {
        const stablePageId = String(pageId || "");
        const stableRevision = String(imageRevision || "");
        const indexedIds = [...(observationIdsByPage.get(stablePageId) || [])];
        for (const observationId of indexedIds) {
          const existing = observations.get(observationId);
          if (
            !existing ||
            existing.sourceType !== "page" ||
            existing.pageIds.length !== 1 ||
            existing.pageIds[0] !== stablePageId ||
            String(existing.imageRevisionByPage[stablePageId] || "") !== stableRevision
          ) {
            continue;
          }
          observations.delete(observationId);
          filteredObservations.delete(observationId);
          observationIdsByPage.get(stablePageId)?.delete(observationId);
        }
        if (observationIdsByPage.get(stablePageId)?.size === 0) {
          observationIdsByPage.delete(stablePageId);
        }
        const activeIds = this.upsertObservations(items);
        const filteredIds = this.upsertObservations(filteredItems, { filtered: true });
        return { activeIds, filteredIds };
      },

      getObservations() {
        return [...observations.values()].sort(compareStableIds);
      },

      getObservationsForPage(pageId, options = {}) {
        const ids = observationIdsByPage.get(String(pageId || ""));
        if (!ids) return [];
        const includeFiltered = options.includeFiltered !== false;
        return [...ids].map((id) => observations.get(id))
          .filter((item) => item && (includeFiltered || !filteredObservations.has(item.id)))
          .sort(compareStableIds);
      },

      getFilteredObservations() {
        return [...filteredObservations.values()].sort(compareStableIds);
      },

      markSeamState(pairKey, state) {
        const key = String(pairKey || "");
        const frozen = freezeCanonicalValue({ ...(state || {}), pairKey: key });
        seamStates.set(key, frozen);
        return frozen;
      },

      getSeamState(pairKey) {
        return seamStates.get(String(pairKey || "")) || null;
      },

      getSeamStates() {
        return [...seamStates.values()].sort((a, b) => String(a.pairKey).localeCompare(String(b.pairKey)));
      },

      async runSerializedReconcile(fn) {
        reconcileTxnSeq += 1;
        const seq = reconcileTxnSeq;
        const operation = reconcileLock.catch(() => undefined).then(() => fn({ seq, store: this }));
        reconcileLock = operation.then(() => undefined, () => undefined);
        return operation;
      },

      setCanonicalSnapshot(snapshot) {
        canonicalSnapshots.clear();
        retiredCanonicalSnapshots.clear();
        const canonicals = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot && snapshot.canonicals) ? snapshot.canonicals : [];
        for (const canonical of canonicals) {
          if (canonical && canonical.id) canonicalSnapshots.set(String(canonical.id), freezeCanonical(canonical));
        }
        const retired = Array.isArray(snapshot && snapshot.retiredCanonicals) ? snapshot.retiredCanonicals : [];
        for (const canonical of retired) {
          if (canonical && canonical.id) retiredCanonicalSnapshots.set(String(canonical.id), freezeCanonical(canonical));
        }
      },

      getCanonicalSnapshot() {
        return [...canonicalSnapshots.values()].sort(compareCanonicalRecords);
      },

      getRetiredCanonicals() {
        return [...retiredCanonicalSnapshots.values()].sort(compareCanonicalRecords);
      },

      setReconcileDiagnostics(value) {
        reconcileDiagnostics = freezeCanonicalValue(value || {});
      },

      getReconcileDiagnostics() {
        return reconcileDiagnostics;
      },

      setCoverageLedger(ledger) {
        coverageLedger.clear();
        const entries = ledger instanceof Map ? [...ledger.entries()]
          : Array.isArray(ledger) ? ledger.map((item) => [item && (item.observationId || item.id), item])
            : Object.entries(ledger || {});
        for (const [observationId, value] of entries) {
          if (observationId && value) coverageLedger.set(String(observationId), Object.freeze({ ...value, observationId: String(observationId) }));
        }
      },

      getCoverageLedger() {
        return new Map([...coverageLedger.entries()].sort(([a], [b]) => a.localeCompare(b)));
      },

      setProjections(projections) {
        projectionsByPage.clear();
        const entries = projections instanceof Map ? [...projections.entries()] : Object.entries(projections || {});
        for (const [pageId, items] of entries) {
          projectionsByPage.set(String(pageId), Object.freeze((Array.isArray(items) ? items : []).map((item) => Object.freeze({ ...item }))));
        }
      },

      getProjections(pageId) {
        return [...(projectionsByPage.get(String(pageId || "")) || [])];
      },

      getAllProjections() {
        return new Map([...projectionsByPage.entries()].map(([pageId, items]) => [pageId, [...items]]));
      },

      getTranslation(canonicalId, revision) {
        return translationsByCanonicalRevision.get(canonicalRevisionKey(canonicalId, revision)) || null;
      },

      getTranslationFailures(items) {
        const failures = [];
        for (const item of Array.isArray(items) ? items : []) {
          const failure = translationErrorsByCanonicalRevision.get(
            canonicalRevisionKey(item && item.id, item && item.revision)
          );
          if (failure) failures.push(failure);
        }
        return failures;
      },

      claimTranslations(items) {
        const claimed = [];
        for (const item of Array.isArray(items) ? items : []) {
          const key = canonicalRevisionKey(item && item.id, item && item.revision);
          if (!item || !item.id || translationsByCanonicalRevision.has(key) || pendingTranslationKeys.has(key) || attemptedTranslationKeys.has(key)) continue;
          pendingTranslationKeys.add(key);
          attemptedTranslationKeys.add(key);
          if (!pendingTranslationWaiters.has(key)) {
            let resolveWaiter;
            const promise = new Promise((resolve) => { resolveWaiter = resolve; });
            pendingTranslationWaiters.set(key, { promise, resolve: resolveWaiter });
          }
          claimed.push(item);
        }
        return claimed;
      },

      async waitForPendingTranslations(items) {
        const waits = [];
        for (const item of Array.isArray(items) ? items : []) {
          const waiter = pendingTranslationWaiters.get(canonicalRevisionKey(item && item.id, item && item.revision));
          if (waiter) waits.push(waiter.promise);
        }
        if (waits.length > 0) await Promise.all(waits);
      },

      settleTranslation(item, translation) {
        const key = canonicalRevisionKey(item && item.id, item && item.revision);
        pendingTranslationKeys.delete(key);
        const waiter = pendingTranslationWaiters.get(key);
        pendingTranslationWaiters.delete(key);
        if (!item || !item.id || !translation) {
          if (waiter) waiter.resolve(false);
          return false;
        }
        const current = canonicalSnapshots.get(String(item.id));
        if (!current || Number(current.revision) !== Number(item.revision)) {
          if (waiter) waiter.resolve(false);
          return false;
        }
        translationsByCanonicalRevision.set(key, Object.freeze({ ...translation, id: String(item.id), revision: Number(item.revision) || 1 }));
        translationErrorsByCanonicalRevision.delete(key);
        if (waiter) waiter.resolve(true);
        return true;
      },

      failTranslationClaims(items, error) {
        const message = getErrorMessage(error) || "Canonical translation failed";
        for (const item of Array.isArray(items) ? items : []) {
          const key = canonicalRevisionKey(item && item.id, item && item.revision);
          pendingTranslationKeys.delete(key);
          attemptedTranslationKeys.delete(key);
          const waiter = pendingTranslationWaiters.get(key);
          pendingTranslationWaiters.delete(key);
          translationErrorsByCanonicalRevision.set(key, Object.freeze({
            id: String(item && item.id || ""),
            revision: Math.max(1, Number(item && item.revision) || 1),
            error: message
          }));
          if (waiter) waiter.resolve(false);
        }
      },

      releaseTranslationClaims(items) {
        for (const item of Array.isArray(items) ? items : []) {
          const key = canonicalRevisionKey(item && item.id, item && item.revision);
          pendingTranslationKeys.delete(key);
          attemptedTranslationKeys.delete(key);
          const waiter = pendingTranslationWaiters.get(key);
          pendingTranslationWaiters.delete(key);
          if (waiter) waiter.resolve(false);
        }
      },

      setEdgeWait(pageId, value) {
        edgeWaitStates.set(String(pageId || ""), { ...(value || {}) });
      },

      getEdgeWait(pageId) {
        const value = edgeWaitStates.get(String(pageId || ""));
        return value ? { ...value } : null;
      },

      clearEdgeWait(pageId, clearTimer) {
        const key = String(pageId || "");
        const value = edgeWaitStates.get(key) || null;
        edgeWaitStates.delete(key);
        if (value && value.timer && typeof clearTimer === "function") clearTimer(value.timer);
        return value ? { ...value } : null;
      },

      getOrCreateInflightJob(jobKey, factory) {
        const existing = inflightJobs.get(jobKey);
        if (existing) return existing;
        const promise = factory().finally(() => {
          if (inflightJobs.get(jobKey) === promise) {
            inflightJobs.delete(jobKey);
          }
        });
        inflightJobs.set(jobKey, promise);
        return promise;
      },

      /* ---- 工具 ---- */

      /** 重置所有状态（用于测试或扩展热重载） */
      reset() {
        globalOcrEntries.clear();
        pageJobPhase.clear();
        inflightJobs.clear();
        currentJobs.clear();
        shortPageAttachments = new WeakMap();
        retryStates.clear();
        dedupeLock = Promise.resolve();
        pageHandles.clear();
        pageHandleByTarget = new WeakMap();
        canonicalPagePhases.clear();
        pageTerminalStates.clear();
        observations.clear();
        observationIdsByPage.clear();
        filteredObservations.clear();
        seamStates.clear();
        canonicalSnapshots.clear();
        retiredCanonicalSnapshots.clear();
        reconcileDiagnostics = Object.freeze({});
        coverageLedger.clear();
        projectionsByPage.clear();
        translationsByCanonicalRevision.clear();
        translationErrorsByCanonicalRevision.clear();
        pendingTranslationKeys.clear();
        for (const waiter of pendingTranslationWaiters.values()) waiter.resolve(false);
        pendingTranslationWaiters.clear();
        attemptedTranslationKeys.clear();
        edgeWaitStates.clear();
        reconcileTxnSeq = 0;
        reconcileLock = Promise.resolve();
      }
    };
  }

  /* =================================================================
   * PageContext — 阶段间传递的不可变数据载体
   * ================================================================= */
  function createPageContext({ targetKey, scopedTargetKey, sourceToken, runId }) {
    return Object.freeze({
      targetKey,
      scopedTargetKey,
      sourceToken,
      runId,
      /** 进入下一阶段的快照数据，由各阶段设置 */
      snapshot: null,
      payload: null,
      stitchPayload: null,
      rawResult: null,
      mappedResult: null,
      dedupedResult: null,
      renderPayload: null,
      error: null,
      diagnostics: Object.freeze({})
    });
  }

  /** 每个阶段都返回新的冻结上下文，禁止通过共享对象传递中间状态。 */
  function updatePageContext(context, patch) {
    return Object.freeze({ ...context, ...patch });
  }

  /** 封装 Kakao 自动重试计时器，调用方只提供页面相关判断。 */
  function createRetryScheduler({
    store,
    setTimer,
    clearTimer,
    isPlaceholder,
    isTargetUsable,
    isTargetReady,
    onReady,
    delayMs = 1200,
    maxDelayMs = 20000,
    maxAttempts = 5
  }) {
    function schedule(target) {
      const current = store.getRetryState(target);
      if ((current && current.timer) || isPlaceholder(target)) {
        return false;
      }
      const attempts = Number(current && current.attempts || 0);
      if (attempts >= maxAttempts) {
        return false;
      }
      store.setRetryState(target, {
        timer: null,
        attempts: attempts + 1,
        retries: Number(current && current.retries || 0)
      });
      scheduleNext(target, delayMs);
      return true;
    }

    function scheduleNext(target, waitMs) {
      const current = store.getRetryState(target);
      if (current && current.timer) {
        return;
      }
      const timer = setTimer(() => {
        const fired = store.clearRetryState(target) || current || { attempts: 0, retries: 0 };
        if (!isTargetUsable(target) || isPlaceholder(target)) {
          return;
        }
        if (isTargetReady(target)) {
          onReady(target);
          return;
        }
        const retries = Number(fired.retries || 0) + 1;
        store.setRetryState(target, {
          timer: null,
          attempts: Number(fired.attempts || 0),
          retries
        });
        scheduleNext(target, Math.min(delayMs * Math.pow(2, retries - 1), maxDelayMs));
      }, waitMs);
      store.setRetryState(target, {
        timer,
        attempts: Number(current && current.attempts || 0),
        retries: Number(current && current.retries || 0)
      });
    }

    function cancel(target) {
      const current = store.clearRetryState(target);
      if (current && current.timer) {
        clearTimer(current.timer);
      }
    }

    function clear() {
      store.clearRetryStates(clearTimer);
    }

    return Object.freeze({ schedule, cancel, clear });
  }

  function getShortPageAttachmentGate(store, target, now = Date.now()) {
    const attachment = store.getShortPageAttachment(target);
    if (!attachment || !attachment.ownerKey) {
      return Object.freeze({ blocked: false, timedOut: false, ownerKey: "" });
    }
    if (now - attachment.attachedAt > KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS) {
      store.releaseShortPage(target, attachment.ownerKey, now);
      return Object.freeze({ blocked: false, timedOut: true, ownerKey: attachment.ownerKey });
    }
    return Object.freeze({ blocked: true, timedOut: false, ownerKey: attachment.ownerKey });
  }

  function attachShortPageIfAllowed(store, target, ownerKey, now = Date.now()) {
    const previous = store.getShortPageAttachment(target);
    if (
      previous &&
      previous.detachedOwnerKey === ownerKey &&
      now - previous.detachedAt <= KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS
    ) {
      return false;
    }
    store.attachShortPage(target, ownerKey, now);
    return true;
  }

  function releaseShortPagesForOwner(store, candidates, ownerKey, now = Date.now()) {
    const released = [];
    for (const target of Array.isArray(candidates) ? candidates : []) {
      const attachment = store.getShortPageAttachment(target);
      if (!attachment || attachment.ownerKey !== ownerKey) {
        continue;
      }
      store.releaseShortPage(target, ownerKey, now);
      released.push(target);
    }
    return released;
  }

  /* =================================================================
   * Pipeline — 五阶段编排器
   * ================================================================= */
  /**
   * @param {object} adapters — content.js 注入的 DOM/通信/渲染能力
   *
   * 必须的 adapter 接口：
   *   extractTargetPayload(target, scopedKey) → payload
   *   requestTranslationForPayload(payload, requestKey) → response
   *   renderTranslationResult(target, targetKey, result, payload, opts)
   *   clearRenderedTarget(target)
   *   renderOverlay(target, targetKey, result)
   *   buildTargetSourceCacheKey(targetKey, sourceToken) → string
   *   computeTargetKey(target) → string
   *   getQuickSourceToken(target) → string
   *   collectKakaopageManualTargetCandidates(all, target) → Element[]
   *   extractAdjacentKakaoPayload(target) → payload
   *   loadImageFromDataUrl(dataUrl) → Image
   *   buildKakaoStitchedPayload(target, basePayload) → stitchedPayload | null
   *   findTargetByScopedKey(scopedKey) → Element | null
   *   queueTranslate(target, opts)
   *   queuePageAutoTranslate(target)
   *   scheduleAutoTranslateRetry(target)
   *   tracePipeline(stage, target, data)
   *   getVisibleViewportRect(target) → rect | null
   *   captureTargetSnapshot(target) → snapshot
   *   isTargetSnapshotStillValid(target, snapshot) → boolean
   *   shouldUseEmbeddedRender(target) → boolean
   *   getPayloadCache(key) → payload | null
   *   state.localResultCache (Map, 用于 rememberLocalResult 等)
   *   state.inflightByTarget (WeakMap, 用于并发控制)
   */
  function createPipeline(adapters) {
    if (!adapters) throw new Error("KakaoPipeline: adapters required");

    // 校验必须的 adapter 方法
    const required = [
      "extractTargetPayload", "requestTranslationForPayload",
      "renderTranslationResult", "clearRenderedTarget", "renderOverlay",
      "computeTargetKey", "getQuickSourceToken", "buildTargetSourceCacheKey",
      "captureTargetSnapshot", "renderLoadingOverlay",
      "shouldUseKakaoStitchedOcr", "buildKakaoStitchedPayload",
      "tracePipeline", "scheduleAutoTranslateRetry"
    ];
    for (const name of required) {
      if (typeof adapters[name] !== "function") {
        throw new Error(`KakaoPipeline: missing adapter "${name}"`);
      }
    }

    const store = adapters.store || createStore();

    /** 生成唯一 runId */
    let runSeq = 0;
    function nextRunId() {
      runSeq += 1;
      return `run-${runSeq}-${Date.now()}`;
    }

    /** 检查作业身份是否仍然有效 */
    function isCurrentJob(target, identity) {
      if (!target || !target.isConnected) return false;
      if (!store.isCurrentPageJob(identity.scopedTargetKey, identity)) return false;
      const currentSource = adapters.getQuickSourceToken(target);
      if (currentSource !== identity.sourceToken) return false;
      const currentKey = adapters.buildTargetSourceCacheKey(
        adapters.computeTargetKey(target),
        currentSource
      );
      return currentKey === identity.scopedTargetKey;
    }

    function cancelJob(target, identity, reason) {
      if (target) {
        adapters.tracePipeline("cancelled", target, { runId: identity.runId, reason });
      }
      if (store.isCurrentPageJob(identity.scopedTargetKey, identity)) {
        store.cancelPageJob(identity.scopedTargetKey);
      }
      return { ok: false, skipped: true, reason: `cancelled:${reason}` };
    }

    /**
     * 运行一个页面的翻译管线
     * @param {Element} target
     * @param {object} options
     * @param {string} options.reason
     * @param {boolean} [options.force]
     */
    function run(target, options = {}) {
      const targetKey = adapters.computeTargetKey(target);
      const sourceToken = adapters.getQuickSourceToken(target);
      const scopedTargetKey = adapters.buildTargetSourceCacheKey(targetKey, sourceToken);
      return store.getOrCreateInflightJob(scopedTargetKey, () => {
        if (store.getPagePhase(scopedTargetKey) !== PagePhase.WAITING) {
          store.resetPagePhase(scopedTargetKey);
        }
        const identity = {
          scopedTargetKey,
          sourceToken,
          runId: nextRunId()
        };
        store.beginPageJob(scopedTargetKey, identity);
        return executePipeline(target, identity, options);
      });
    }

    function runCached(target, cachedResult, options = {}) {
      const targetKey = adapters.computeTargetKey(target);
      const sourceToken = adapters.getQuickSourceToken(target);
      const scopedTargetKey = adapters.buildTargetSourceCacheKey(targetKey, sourceToken);
      return store.getOrCreateInflightJob(scopedTargetKey, async () => {
        if (store.getPagePhase(scopedTargetKey) !== PagePhase.WAITING) {
          store.resetPagePhase(scopedTargetKey);
        }
        const identity = { scopedTargetKey, sourceToken, runId: nextRunId() };
        store.beginPageJob(scopedTargetKey, identity);
        try {
          store.transitionPagePhase(scopedTargetKey, PagePhase.DEDUPING);
          const result = typeof adapters.dedupeResult === "function"
            ? await adapters.dedupeResult(cachedResult, target, targetKey, scopedTargetKey)
            : cachedResult;
          if (!isCurrentJob(target, identity)) {
            return cancelJob(target, identity, "sourceChanged during cached dedupe");
          }
          store.transitionPagePhase(scopedTargetKey, PagePhase.DEDUPED);
          store.transitionPagePhase(scopedTargetKey, PagePhase.RENDERING);
          if (typeof adapters.renderCachedPipelineResult === "function") {
            await adapters.renderCachedPipelineResult({
              target,
              targetKey,
              scopedTargetKey,
              result,
              options
            });
          } else if (result && Array.isArray(result.bubbles) && result.bubbles.length > 0) {
            await adapters.renderTranslationResult(target, targetKey, result, null);
          } else {
            adapters.clearRenderedTarget(target);
          }
          store.transitionPagePhase(scopedTargetKey, PagePhase.RENDERED);
          return {
            ok: true,
            reused: true,
            bubbles: result && Array.isArray(result.bubbles) ? result.bubbles.length : 0
          };
        } catch (error) {
          store.transitionPagePhase(scopedTargetKey, PagePhase.FAILED);
          if (typeof adapters.reportPipelineError === "function") {
            await adapters.reportPipelineError(error, target, options);
          }
          return { ok: false, error: getErrorMessage(error) };
        } finally {
          store.finishPageJob(scopedTargetKey, identity);
        }
      });
    }

    /**
     * 内部管线执行体（可被 inflight 合并）
     */
    async function executePipeline(target, identity, options) {
      const { scopedTargetKey, sourceToken, runId } = identity;
      const targetKey = adapters.computeTargetKey(target);
      let ctx = createPageContext({ targetKey, scopedTargetKey, sourceToken, runId });
      let renderPayload = null;

      adapters.tracePipeline("pipeline-start", target, { runId, reason: options.reason });

      try {
        // =============================================
        // Phase 1: FETCH —— 提取图片数据
        // =============================================
        store.transitionPagePhase(scopedTargetKey, PagePhase.FETCHING);

        // 校验作业身份（防止 DOM 复用后迟到任务覆盖新任务）
        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, "sourceChanged before fetch");
        }

        const preTranslateSnapshot = adapters.captureTargetSnapshot(target);
        ctx = updatePageContext(ctx, { snapshot: preTranslateSnapshot });
        adapters.renderLoadingOverlay(target, targetKey, "提取图片...");
        const payload = await adapters.extractTargetPayload(target, scopedTargetKey);

        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, "sourceChanged after fetch");
        }

        ctx = updatePageContext(ctx, { payload });
        store.transitionPagePhase(scopedTargetKey, PagePhase.FETCHED);

        // =============================================
        // Phase 2: STITCH —— 判断是否拼接并构建拼接 payload
        // =============================================
        renderPayload = payload;
        let stitchPayload = null;

        if (adapters.shouldUseKakaoStitchedOcr(target, payload)) {
          store.transitionPagePhase(scopedTargetKey, PagePhase.STITCHING);
          adapters.renderLoadingOverlay(target, targetKey, "拼接相邻页...");

          stitchPayload = await adapters.buildKakaoStitchedPayload(target, payload);

          if (!isCurrentJob(target, identity)) {
            return cancelJob(target, identity, "sourceChanged during stitching");
          }

          if (stitchPayload && stitchPayload.stitch) {
            renderPayload = stitchPayload;
          }
          ctx = updatePageContext(ctx, { stitchPayload });
          store.transitionPagePhase(scopedTargetKey, PagePhase.STITCHED);
        }

        // =============================================
        // Phase 3: RECOGNIZE —— 调用 OCR/翻译
        // =============================================
        store.transitionPagePhase(scopedTargetKey, PagePhase.RECOGNIZING);
        adapters.renderLoadingOverlay(target, targetKey, "模型翻译中...");

        let response = null;
        try {
          response = await adapters.requestTranslationForPayload(
            renderPayload,
            buildOcrRequestKey(targetKey, renderPayload)
          );
        } catch (error) {
          // 拼接失败时回退单图
          if (renderPayload && renderPayload.stitch && renderPayload.singleImagePayload) {
            adapters.tracePipeline("stitch-fallback", target, { reason: "exception" });
            renderPayload = buildSingleFallbackPayload(
              renderPayload.singleImagePayload,
              renderPayload,
              "stitched request threw"
            );
            response = await adapters.requestTranslationForPayload(
              renderPayload,
              buildOcrRequestKey(targetKey, renderPayload)
            );
          } else {
            throw error;
          }
        }

        // 请求失败时也回退
        if ((!response || !response.ok) && renderPayload && renderPayload.stitch && renderPayload.singleImagePayload) {
          adapters.tracePipeline("stitch-fallback", target, { reason: "request failed" });
          renderPayload = buildSingleFallbackPayload(
            renderPayload.singleImagePayload,
            renderPayload,
            response && response.error ? response.error : "stitched request failed"
          );
          response = await adapters.requestTranslationForPayload(
            renderPayload,
            buildOcrRequestKey(targetKey, renderPayload)
          );
        }

        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "Translate request failed");
        }

        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, "sourceChanged during recognition");
        }

        let result = normalizeResult(response.result);
        ctx = updatePageContext(ctx, { rawResult: result });

        // 拼接结果映射
        if (renderPayload && renderPayload.stitch) {
          if (typeof adapters.mapStitchedResult === "function") {
            result = adapters.mapStitchedResult(result, renderPayload, target, targetKey);
          } else {
            const targetRect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
            const sx = window.scrollX || 0;
            const sy = window.scrollY || 0;
            result = mapKakaoStitchedResult(result, renderPayload.stitch, targetRect, sx, sy);
          }
          ctx = updatePageContext(ctx, { mappedResult: result });

          // 回退检测
          const fallbackReason = shouldFallbackFromKakaoStitch(renderPayload, response.result, result);
          if (fallbackReason && renderPayload.singleImagePayload) {
            adapters.tracePipeline("stitch-fallback", target, { reason: fallbackReason });
            renderPayload = buildSingleFallbackPayload(
              renderPayload.singleImagePayload,
              renderPayload,
              fallbackReason
            );
            response = await adapters.requestTranslationForPayload(
              renderPayload,
              buildOcrRequestKey(targetKey, renderPayload)
            );
            if (!response || !response.ok) {
              throw new Error("Single-image OCR fallback failed");
            }
            result = normalizeResult(response.result);
            ctx = updatePageContext(ctx, { rawResult: result, mappedResult: null });
          }
        }

        store.transitionPagePhase(scopedTargetKey, PagePhase.RECOGNIZED);

        // =============================================
        // Phase 4: DEDUPE —— 跨页去重
        // =============================================
        store.transitionPagePhase(scopedTargetKey, PagePhase.DEDUPING);

        // 用串行化去重确保并发页面不会基于过期快照互相删除
        if (typeof adapters.dedupeResult === "function") {
          result = await adapters.dedupeResult(result, target, targetKey, scopedTargetKey);
        } else {
          const scrollX = window.scrollX || 0;
          const scrollY = window.scrollY || 0;
          result = await store.runSerializedDedupe(() =>
            executeDedupe(target, targetKey, scopedTargetKey, result, scrollX, scrollY, store, adapters)
          );
        }

        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, "sourceChanged during dedupe");
        }
        if (
          ctx.snapshot &&
          typeof adapters.isTargetSnapshotStillValid === "function" &&
          !adapters.isTargetSnapshotStillValid(target, ctx.snapshot)
        ) {
          return cancelJob(target, identity, "target changed during pipeline");
        }

        ctx = updatePageContext(ctx, { dedupedResult: result, renderPayload });
        store.transitionPagePhase(scopedTargetKey, PagePhase.DEDUPED);

        // =============================================
        // Phase 5: RENDER —— 渲染结果
        // =============================================
        store.transitionPagePhase(scopedTargetKey, PagePhase.RENDERING);
        adapters.renderLoadingOverlay(target, targetKey, "排版中...");

        if (typeof adapters.renderPipelineResult === "function") {
          await adapters.renderPipelineResult({
            target,
            targetKey,
            scopedTargetKey,
            result,
            payload: renderPayload,
            response,
            options,
            context: ctx
          });
        } else {
          releaseUncoveredShortPages(renderPayload, result, target, store, adapters);
          rememberLocalResult(adapters, scopedTargetKey, result);
          if (result.bubbles.length > 0) {
            await adapters.renderTranslationResult(target, targetKey, result, renderPayload, { stream: true });
            target.dataset.mtNoTextKey = "";
          } else {
            adapters.clearRenderedTarget(target);
            target.dataset.mtNoTextKey = targetKey;
          }
          target.dataset.mtLastTranslatedKey = targetKey;
        }
        store.transitionPagePhase(scopedTargetKey, PagePhase.RENDERED);

        adapters.tracePipeline("pipeline-end", target, {
          runId,
          bubbleCount: result.bubbles.length,
          ok: true
        });

        return { ok: true, bubbles: result.bubbles.length, cached: !!response.cached };

      } catch (error) {
        const reason = getErrorMessage(error);

        if (typeof adapters.releaseAttachedShortPagesOnError === "function") {
          adapters.releaseAttachedShortPagesOnError(
            ctx.stitchPayload || renderPayload,
            target,
            scopedTargetKey,
            ctx
          );
        }

        adapters.clearRenderedTarget(target);

        if (isScreenshotTargetNotVisibleError(reason)) {
          adapters.scheduleAutoTranslateRetry(target);
          store.transitionPagePhase(scopedTargetKey, PagePhase.RETRY_WAIT);
          return { ok: false, skipped: true, reason };
        }

        if (typeof adapters.reportPipelineError === "function") {
          await adapters.reportPipelineError(error, target, options);
        }
        store.transitionPagePhase(scopedTargetKey, PagePhase.FAILED);
        adapters.tracePipeline("pipeline-error", target, { runId, error: reason });
        return { ok: false, error: reason };
      } finally {
        store.finishPageJob(scopedTargetKey, identity);
        adapters.tracePipeline("pipeline-finally", target, { runId });
      }
    }

    return {
      store,
      run,
      runCached,
      PagePhase,
      // 暴露纯函数供测试
      isVerifiedKakaoStitchNeighbor,
      buildKakaoStitchWindowPlan,
      isAttachableKakaoShortPage,
      isKakaoPageEdgeFragment,
      shouldRejectKakaoPageEdgeStitch,
      shouldFallbackFromKakaoStitch,
      mapKakaoStitchedResult,
      mapKakaoAdjacentBoundaryRect,
      mapKakaoStitchedFillBox,
      mapKakaoStitchedPolygon,
      computeKakaoGlobalBox,
      normalizeKakaoStitchSegments,
      normalizeKakaoStitchDebugCoordinates,
      normalizeDebugCoordinateItems,
      getKakaoStitchBestOverlap,
      getKakaoStitchOwnerOverlap,
      dedupeKakaoGlobalBubbles: runDedupeGlobalBubbles,
      trimKakaoBubbleBoundary,
      sliceTextByNormalizedBoundary,
      isKakaoGlobalDuplicateCandidate,
      isKakaoBoundaryNeighborBubble,
      isKakaoBoundaryOwnPair,
      areKakaoGlobalBoxesRelated,
      areOcrTextsDuplicateOrContained,
      hasSubstantialOcrTokenOverlap,
      getSubstantialOcrBoundaryOverlap,
      getLongestCommonSubstringLength,
      getBubbleLineCount,
      textSimilarity,
      normalizeOcrSimilarityText,
      findKakaoVerticalOverlap,
      hasUsableKakaoStripCaptureRect,
      hasAttachedShortPageBubble,
      filterOcrDebugFinalBubbles,
      syncOcrDebugFinalBubbles,
      createStore,
      canTransition,
      isActivePhase
    };
  }

  /* =================================================================
   * Kakao authoritative-page canonical pipeline
   * ================================================================= */

  function createCanonicalPipeline(adapters) {
    if (!adapters) throw new Error("KakaoCanonicalPipeline: adapters required");

    const extractTargetPayload = requireCanonicalAdapter(adapters, "extractTargetPayload");
    const buildPageIdentity = requireCanonicalAdapter(adapters, "buildPageIdentity", "buildKakaoPageIdentity");
    const commitPageIdentity = typeof adapters.commitPageIdentity === "function"
      ? adapters.commitPageIdentity
      : null;
    const requestOcrForPayload = requireCanonicalAdapter(adapters, "requestOcrForPayload");
    const requestCanonicalTranslations = requireCanonicalAdapter(adapters, "requestCanonicalTranslations");
    const renderCanonicalProjections = requireCanonicalAdapter(adapters, "renderCanonicalProjections");
    const findAdjacentTargets = adapters.findAdjacentPageTargets || adapters.findAdjacentKakaoPageTargets || (() => ({}));
    const buildSeamPayload = adapters.buildSeamPayload || adapters.buildKakaoSeamPayload || null;
    const detectPixelRisk = adapters.detectAdjacentPixelRisk || adapters.detectAdjacentKakaoPixelRisk || null;
    const getTargetForPageId = adapters.getTargetForPageId || adapters.getTargetForKakaoPageId || null;
    const isAuthoritativePagePayload = typeof adapters.isAuthoritativePagePayload === "function"
      ? adapters.isAuthoritativePagePayload
      : defaultIsAuthoritativePagePayload;
    const setTimer = adapters.setTimer || globalThis.setTimeout;
    const clearTimer = adapters.clearTimer || globalThis.clearTimeout;
    const now = typeof adapters.now === "function" ? adapters.now : () => Date.now();
    const getTargetGeneration = typeof adapters.getTargetGeneration === "function"
      ? adapters.getTargetGeneration
      : () => 0;
    const edgeWaitTimeoutMs = Math.max(0, Number(adapters.edgeWaitTimeoutMs ?? KAKAO_EDGE_WAIT_TIMEOUT_MS));
    const extractTimeoutMs = Math.max(0, Number(adapters.extractTimeoutMs ?? 30000));
    const identityTimeoutMs = Math.max(0, Number(adapters.identityTimeoutMs ?? 30000));
    const pageOcrTimeoutMs = Math.max(0, Number(adapters.pageOcrTimeoutMs ?? 30000));
    const seamTimeoutMs = Math.max(0, Number(adapters.seamTimeoutMs ?? 30000));
    const store = adapters.store || createStore();
    let runSeq = 0;
    let targetHandleSeq = 0;
    const targetHandleIds = new WeakMap();
    const activeRunByTarget = new WeakMap();

    function getTargetHandleId(target) {
      if (!target || (typeof target !== "object" && typeof target !== "function")) return "no-target";
      let id = targetHandleIds.get(target);
      if (!id) {
        id = `handle-${++targetHandleSeq}`;
        targetHandleIds.set(target, id);
      }
      return id;
    }

    function trace(event, target, details = {}) {
      if (typeof adapters.tracePipeline === "function") {
        adapters.tracePipeline(`canonical:${event}`, target, details);
      }
    }

    function loading(target, targetKey, label) {
      if (typeof adapters.renderLoadingOverlay === "function") {
        adapters.renderLoadingOverlay(target, targetKey, label);
      }
    }

    function targetIsUsable(target) {
      return !!target && target.isConnected !== false;
    }

    function withCanonicalTimeout(promise, timeoutMs, message) {
      if (!(timeoutMs > 0)) return Promise.resolve(promise);
      const deadlineSetTimer = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout : setTimer;
      const deadlineClearTimer = typeof globalThis.clearTimeout === "function" ? globalThis.clearTimeout : clearTimer;
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = deadlineSetTimer(() => {
          if (settled) return;
          settled = true;
          reject(new Error(message));
        }, timeoutMs);
        Promise.resolve(promise).then((value) => {
          if (settled) return;
          settled = true;
          deadlineClearTimer(timer);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          deadlineClearTimer(timer);
          reject(error);
        });
      });
    }

    function buildJobIdentity(target) {
      const targetKey = adapters.computeTargetKey(target);
      const sourceToken = adapters.getQuickSourceToken(target);
      const sourceGeneration = String(getTargetGeneration(target));
      const targetHandleId = getTargetHandleId(target);
      const scopedTargetKey = adapters.buildTargetSourceCacheKey(targetKey, sourceToken);
      const runSequence = ++runSeq;
      return {
        targetKey,
        sourceToken,
        sourceGeneration,
        targetHandleId,
        scopedTargetKey,
        jobKey: `canonical-job:${scopedTargetKey}:${targetHandleId}`,
        runSequence,
        runId: `canonical-run-${runSequence}`
      };
    }

    function isCurrentJob(target, identity) {
      if (!targetIsUsable(target) || !store.isCurrentPageJob(identity.jobKey, identity)) return false;
      const sourceToken = adapters.getQuickSourceToken(target);
      if (String(sourceToken) !== String(identity.sourceToken)) return false;
      if (String(getTargetGeneration(target)) !== String(identity.sourceGeneration)) return false;
      const targetKey = adapters.computeTargetKey(target);
      return adapters.buildTargetSourceCacheKey(targetKey, sourceToken) === identity.scopedTargetKey;
    }

    function isReadyPageRecord(record) {
      if (!record || record.pageOcrState !== "ready") return false;
      const terminal = store.getPageTerminal(record.pageId);
      if (!terminal || terminal.state !== "ready") return false;
      const terminalRevision = String(terminal.details?.imageRevision || "");
      return !terminalRevision || terminalRevision === String(record.imageRevision || "");
    }

    function isCurrentPageRevision(record) {
      if (!record || !record.pageId) return false;
      const current = store.getPageHandle(record.pageId);
      return !!current && String(current.imageRevision || "") === String(record.imageRevision || "");
    }

    function canCommitPageRevision(target, identity, pageIdentity) {
      const current = store.getPageHandle(pageIdentity.pageId);
      if (!current || String(current.imageRevision || "") === String(pageIdentity.imageRevision || "")) return true;
      const binding = typeof store.getPageBindingForTarget === "function"
        ? store.getPageBindingForTarget(target)
        : null;
      if (
        binding && binding.pageId === pageIdentity.pageId &&
        String(binding.imageRevision || "") === String(pageIdentity.imageRevision || "") &&
        String(binding.imageRevision || "") !== String(current.imageRevision || "")
      ) {
        return false;
      }
      return Number(current.runSequence || 0) <= Number(identity.runSequence || 0);
    }

    function cancelJob(target, identity, pageId, reason) {
      const ownsCurrentJob = store.isCurrentPageJob(identity.jobKey, identity);
      if (ownsCurrentJob) {
        const currentHandle = pageId ? store.getPageHandle(pageId) : null;
        if (
          pageId && currentHandle && currentHandle.target === target &&
          !isReadyPageRecord(currentHandle)
        ) {
          store.setCanonicalPagePhase(pageId, CanonicalPhase.CANCELLED);
        }
        store.cancelPageJob(identity.jobKey, identity);
      }
      if (ownsCurrentJob && activeRunByTarget.get(target) === identity &&
          typeof adapters.clearLoadingOverlay === "function") {
        try { adapters.clearLoadingOverlay(target); } catch { /* 清理只是 UI 恢复 */ }
      }
      trace("cancelled", target, { runId: identity.runId, pageId, reason });
      return { ok: false, skipped: true, reason: `cancelled:${reason}` };
    }

    function run(target, options = {}) {
      const identity = buildJobIdentity(target);
      return store.getOrCreateInflightJob(
        `canonical-target:${identity.scopedTargetKey}:${identity.sourceGeneration}:${identity.targetHandleId}`,
        async () => {
          const previousRun = activeRunByTarget.get(target);
          identity.suppressLoadingClear = !!previousRun && previousRun !== identity;
          activeRunByTarget.set(target, identity);
          store.beginPageJob(identity.jobKey, identity);
          return execute(target, identity, options);
        }
      );
    }

    async function execute(target, identity, options) {
      let pageRecord = null;
      let preserveReadyPhase = false;
      let pageOcrReady = false;
      trace("pipeline-start", target, { runId: identity.runId, reason: options.reason || "" });
      try {
        trace("fetch", target, { runId: identity.runId });
        loading(target, identity.targetKey, "提取单页图片...");
        if (!isCurrentJob(target, identity)) return cancelJob(target, identity, "", "sourceChanged before fetch");

        const snapshot = typeof adapters.captureTargetSnapshot === "function"
          ? adapters.captureTargetSnapshot(target)
          : null;
        const payload = await withCanonicalTimeout(
          extractTargetPayload(target, identity.scopedTargetKey),
          extractTimeoutMs,
          "Page fetch timed out"
        );
        if (!isCurrentJob(target, identity)) return cancelJob(target, identity, "", "sourceChanged after fetch");
        const authoritativePayload = await isAuthoritativePagePayload(payload, target);
        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, "", "sourceChanged during payload admission");
        }
        if (!authoritativePayload) {
          trace("legacy-fallback", target, { runId: identity.runId, source: String(payload && payload.source || "") });
          return {
            ok: false,
            skipped: true,
            fallbackLegacy: true,
            reason: "non-authoritative-page-payload",
            payload
          };
        }

        const pageIdentity = await withCanonicalTimeout(
          buildPageIdentity(target, payload, { ...identity, deferBind: true }),
          identityTimeoutMs,
          "Page identity timed out"
        );
        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, "", "sourceChanged while hashing page bytes");
        }
        validatePageIdentity(pageIdentity);
        if (!canCommitPageRevision(target, identity, pageIdentity)) {
          return cancelJob(target, identity, pageIdentity.pageId, "page revision superseded before commit");
        }
        if (commitPageIdentity && commitPageIdentity(target, pageIdentity) === false) {
          return cancelJob(target, identity, pageIdentity.pageId, "page identity commit rejected");
        }
        const previousPageHandle = store.getPageHandle(pageIdentity.pageId);
        const previousPageTerminal = store.getPageTerminal(pageIdentity.pageId);
        preserveReadyPhase = !!previousPageHandle &&
          previousPageHandle.imageRevision === pageIdentity.imageRevision &&
          previousPageTerminal && previousPageTerminal.state === "ready" &&
          isReadyPageRecord(previousPageHandle);
        pageOcrReady = preserveReadyPhase;
        pageRecord = store.registerPageHandle({
          ...(preserveReadyPhase ? previousPageHandle : {}),
          ...pageIdentity,
          identity: Object.freeze({ ...pageIdentity }),
          target,
          targetKey: identity.targetKey,
          scopedTargetKey: identity.scopedTargetKey,
          sourceToken: identity.sourceToken,
          runSequence: identity.runSequence,
          payload,
          snapshot,
          edgeSignals: preserveReadyPhase ? previousPageHandle.edgeSignals : null,
          edgeSides: preserveReadyPhase ? previousPageHandle.edgeSides : Object.freeze([]),
          adjacentTargets: preserveReadyPhase ? previousPageHandle.adjacentTargets : Object.freeze([]),
          pageOcrState: preserveReadyPhase ? "ready" : "running"
        });
        if (!preserveReadyPhase) store.setCanonicalPagePhase(pageRecord.pageId, CanonicalPhase.PAGE_OCR, { force: true });
        trace("page-ocr", target, { pageId: pageRecord.pageId });
        loading(target, identity.targetKey, "识别当前页...");

        const response = await store.getOrCreateInflightJob(
          `canonical-page-ocr:${pageRecord.pageId}:${pageRecord.imageRevision}`,
          () => withCanonicalTimeout(
            requestOcrForPayload(payload, buildOcrMeta("page", [pageRecord])),
            pageOcrTimeoutMs,
            "Page OCR timed out"
          )
        );
        if (!response || !response.ok) {
          throw new CanonicalPageOcrError(response && response.error ? response.error : "Page OCR failed");
        }
        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, pageRecord.pageId, "sourceChanged during page OCR");
        }
        if (!isCurrentPageRevision(pageRecord)) {
          return cancelJob(target, identity, pageRecord.pageId, "page revision superseded during page OCR");
        }

        loading(target, identity.targetKey, "解析识别结果...");
        const evidence = normalizeOcrEvidence(response.result, [pageRecord], "page");
        if (!preserveReadyPhase) store.setCanonicalPagePhase(pageRecord.pageId, CanonicalPhase.OBSERVING);
        trace("observe", target, { pageId: pageRecord.pageId });
        // 同一页面 revision 的一次重新捕获是原子替换，而不是追加。这样 OCR
        // provider/参数变化或非确定性重识别不会把同一几何实体永久翻译两遍；
        // 不同 imageRevision 的旧证据仍保留并由 ledger 标记 stale_revision。
        store.replacePageRevisionObservations(
          pageRecord.pageId,
          pageRecord.imageRevision,
          evidence.observations,
          evidence.filteredObservations
        );

        const edgeSides = collectPageEdgeSides(pageRecord, evidence.observations, evidence.filteredObservations, evidence.edgeSignals);
        let adjacentTargets = normalizeAdjacentTargets(
          preserveReadyPhase ? pageRecord.adjacentTargets : []
        );
        try {
          adjacentTargets = normalizeAdjacentTargets(await findAdjacentTargets(target, pageRecord));
        } catch (error) {
          // 邻页发现只决定可选 seam，不得让成功的单页 OCR 失败。
          trace("neighbor-discovery-error", target, {
            pageId: pageRecord.pageId,
            error: getErrorMessage(error)
          });
        }
        if (!isCurrentJob(target, identity) || !isCurrentPageRevision(pageRecord)) {
          return cancelJob(target, identity, pageRecord.pageId, "sourceChanged during neighbor discovery");
        }
        const retainedCleanedImage = evidence.cleanedImage || (
          pageRecord.cleanedImageRevision === pageRecord.imageRevision ? pageRecord.cleanedImage : null
        );
        pageRecord = store.registerPageHandle({
          ...pageRecord,
          target,
          payload,
          edgeSignals: evidence.edgeSignals,
          edgeSides: Object.freeze(edgeSides),
          adjacentTargets: Object.freeze(adjacentTargets),
          pageOcrState: "ready",
          ocrDebug: evidence.debug || null,
          cleanedImage: retainedCleanedImage || null,
          cleanedImageRevision: retainedCleanedImage ? pageRecord.imageRevision : "",
          artifactRefreshAttemptedRevision: retainedCleanedImage ? pageRecord.imageRevision : (
            pageRecord.artifactRefreshAttemptedRevision === pageRecord.imageRevision
              ? pageRecord.artifactRefreshAttemptedRevision
              : ""
          )
        });
        pageRecord = bindReadyAdjacentPageIds(pageRecord);
        store.markPageTerminal(pageRecord.pageId, "ready", {
          observationCount: evidence.observations.length,
          imageRevision: pageRecord.imageRevision
        });
        pageOcrReady = true;

        // Interior canonical bubbles are translated before any seam work completes.
        ensureEdgeWait(pageRecord);
        loading(target, identity.targetKey, "翻译文字中...");
        const pageRefresh = await refreshCanonicalState({
          reason: "page-ocr",
          focusPageIds: [pageRecord.pageId],
          guard: () => isCurrentJob(target, identity) && isCurrentPageRevision(pageRecord)
        });
        if (pageRefresh && pageRefresh.aborted || !isCurrentJob(target, identity) || !isCurrentPageRevision(pageRecord)) {
          return cancelJob(target, identity, pageRecord.pageId, "sourceChanged during page refresh");
        }

        // A seam is an optional evidence request. It can never replace or clear page OCR.
        loading(target, identity.targetKey, "处理跨页...");
        const pairResult = await processAdjacentPairs(
          pageRecord,
          () => isCurrentJob(target, identity) && isCurrentPageRevision(pageRecord)
        );
        if (pairResult.aborted || !isCurrentJob(target, identity) || !isCurrentPageRevision(pageRecord)) {
          return cancelJob(target, identity, pageRecord.pageId, "sourceChanged during seam processing");
        }
        const pairPageIds = pairResult.pageIds;
        releaseCompletedEdgeWaits();
        loading(target, identity.targetKey, "渲染结果...");
        const pairRefresh = await refreshCanonicalState({
          reason: "pair-terminal",
          focusPageIds: Array.from(new Set([pageRecord.pageId, ...pairPageIds])),
          guard: () => isCurrentJob(target, identity) && isCurrentPageRevision(pageRecord)
        });
        if (pairRefresh && pairRefresh.aborted || !isCurrentJob(target, identity) || !isCurrentPageRevision(pageRecord)) {
          return cancelJob(target, identity, pageRecord.pageId, "sourceChanged during pair refresh");
        }

        // Direct seam cross-page render: 对已就绪的相邻页，无论是否有边缘证据，
        // 都做合并图 OCR 渲染跨页 overlay。绕过 evaluateSeamEvidence 判断。
        // 拼接结果统一由 canonical renderOverlay 投影，禁用旧的独立跨页渲染。
        if (false) for (const _rel of pageRecord.adjacentTargets || []) {
            const _n = store.getPageHandleForTarget(_rel.target);
            if (!_n || !isReadyPageRecord(_n)) continue;
            const [_a, _b] = _rel.side === "previous" ? [_n, pageRecord] : [pageRecord, _n];
            loading(target, identity.targetKey, "渲染跨页...");
            runSeamCrossPageRender(_a, _b).catch(function () {});
          }

        if (
          snapshot &&
          typeof adapters.isTargetSnapshotStillValid === "function" &&
          !adapters.isTargetSnapshotStillValid(target, snapshot)
        ) {
          return cancelJob(target, identity, pageRecord.pageId, "target changed before render commit");
        }

        store.setCanonicalPagePhase(pageRecord.pageId, CanonicalPhase.RENDERED);
        const pageProjections = store.getProjections(pageRecord.pageId);
        trace("pipeline-end", target, {
          runId: identity.runId,
          pageId: pageRecord.pageId,
          observationCount: evidence.observations.length,
          projectionCount: pageProjections.length
        });
        return {
          ok: true,
          pageId: pageRecord.pageId,
          observations: evidence.observations.length,
          bubbles: pageProjections.filter((item) => item.activeText).length,
          pendingEdge: !!store.getEdgeWait(pageRecord.pageId),
          cached: !!response.cached
        };
      } catch (error) {
        const reason = getErrorMessage(error);
        if (!isCurrentJob(target, identity)) {
          return cancelJob(target, identity, pageRecord && pageRecord.pageId || "", `stale error: ${reason}`);
        }
        if (pageRecord && !isCurrentPageRevision(pageRecord)) {
          return cancelJob(target, identity, pageRecord.pageId, `superseded page revision error: ${reason}`);
        }
        const currentPageReady = pageRecord ? isReadyPageRecord(store.getPageHandle(pageRecord.pageId)) : false;
        if (pageRecord && !pageOcrReady && !currentPageReady) {
          store.markPageTerminal(pageRecord.pageId, "failed", {
            reason,
            imageRevision: pageRecord.imageRevision
          });
        }
        if (pageRecord) {
          store.setCanonicalPagePhase(pageRecord.pageId, CanonicalPhase.RETRY_WAIT);
        }
        // A page failure is local. Existing canonical facts/projections remain intact.
        if (typeof adapters.scheduleAutoTranslateRetry === "function") {
          adapters.scheduleAutoTranslateRetry(target);
        }
        if (typeof adapters.reportPipelineError === "function") {
          await adapters.reportPipelineError(error, target, options);
        }
        trace("page-error", target, { runId: identity.runId, pageId: pageRecord && pageRecord.pageId, error: reason });
        return { ok: false, error: reason, pageId: pageRecord && pageRecord.pageId || "" };
      } finally {
        store.finishPageJob(identity.jobKey, identity);
        // 安全网：确保任何 exit 路径都清理 loading overlay。正常路径中
        // refreshCanonicalState → renderCanonicalProjections → renderOverlay
        // 已经替换了 loading overlay，此处再次清理是幂等的。
        if (!identity.suppressLoadingClear && activeRunByTarget.get(target) === identity &&
            typeof adapters.clearLoadingOverlay === "function") {
          try { adapters.clearLoadingOverlay(target); } catch { /* 安全网清理 */ }
        }
        if (activeRunByTarget.get(target) === identity) {
          activeRunByTarget.delete(target);
        }
        trace("pipeline-finally", target, { runId: identity.runId, pageId: pageRecord && pageRecord.pageId || "" });
      }
    }

    async function processAdjacentPairs(record, guardAllows = () => true) {
      const current = store.getPageHandle(record.pageId) || record;
      const affectedPageIds = [];
      for (const relation of current.adjacentTargets || []) {
        if (!guardAllows()) return { pageIds: affectedPageIds, aborted: true };
        const neighbor = store.getPageHandleForTarget(relation.target);
        if (!neighbor || !neighbor.payload || !isReadyPageRecord(neighbor)) continue;
        if (neighbor.chapterId && current.chapterId && neighbor.chapterId !== current.chapterId) continue;
        const ordered = relation.side === "previous" ? [neighbor, current] : [current, neighbor];
        try {
          await processSeamPair(ordered[0], ordered[1]);
        } catch (error) {
          // Seam 的任何前处理/决策异常都必须隔离为 pair failure。
          const pairKey = buildCanonicalPairKey(ordered[0], ordered[1]);
          store.markSeamState(pairKey, {
            status: "failed",
            pageIds: [ordered[0].pageId, ordered[1].pageId],
            imageRevisionByPage: revisionsForPages(ordered),
            error: getErrorMessage(error)
          });
          trace("seam-error", ordered[0].target, { pairKey, error: getErrorMessage(error) });
        }
        affectedPageIds.push(neighbor.pageId);
        if (!guardAllows()) return { pageIds: affectedPageIds, aborted: true };
      }
      if (!guardAllows()) return { pageIds: affectedPageIds, aborted: true };
      ensureEdgeWait(current);
      return { pageIds: affectedPageIds, aborted: false };
    }

    function bindReadyAdjacentPageIds(record) {
      const patch = {};
      const adjacentPageIds = new Set(Array.isArray(record.adjacentPageIds) ? record.adjacentPageIds : []);
      for (const relation of record.adjacentTargets || []) {
        const neighbor = store.getPageHandleForTarget(relation.target);
        if (!neighbor || (neighbor.chapterId && record.chapterId && neighbor.chapterId !== record.chapterId)) continue;
        adjacentPageIds.add(neighbor.pageId);
        if (relation.side === "previous") patch.previousPageId = neighbor.pageId;
        else patch.nextPageId = neighbor.pageId;
        const neighborAdjacent = new Set(Array.isArray(neighbor.adjacentPageIds) ? neighbor.adjacentPageIds : []);
        neighborAdjacent.add(record.pageId);
        const reciprocalSide = relation.side === "previous" ? "next" : "previous";
        const reciprocalTargets = mergeAdjacentTargetRelation(
          neighbor.adjacentTargets,
          { side: reciprocalSide, target: record.target }
        );
        store.registerPageHandle({
          ...neighbor,
          ...(relation.side === "previous" ? { nextPageId: record.pageId } : { previousPageId: record.pageId }),
          adjacentPageIds: Object.freeze([...neighborAdjacent].sort()),
          adjacentTargets: Object.freeze(reciprocalTargets)
        });
      }
      return store.registerPageHandle({
        ...record,
        ...patch,
        adjacentPageIds: Object.freeze([...adjacentPageIds].sort())
      });
    }

    async function runSeamCrossPageRender(pageA, pageB) {
      return;
      if (typeof buildSeamPayload !== "function") return;
      const pairKey = buildCanonicalPairKey(pageA, pageB);
      const bandHeight = calculateCanonicalSeamHeight(pageA.width, pageB.width);
      let seamPayload;
      try {
        seamPayload = await buildSeamPayload(pageA, pageB, { height: bandHeight, bandHeight });
      } catch (_error) {
        trace("seam-cross-build-error", pageA.target || null, { pairKey, error: getErrorMessage(_error) });
        return;
      }
      if (!seamPayload) return;
      let response;
      try {
        response = await requestOcrForPayload(seamPayload,
          buildOcrMeta("seam", [pageA, pageB], pairKey, { requireCleanedImage: false }));
      } catch (_error) {
        trace("seam-cross-ocr-error", pageA.target || null, { pairKey, error: getErrorMessage(_error) });
        return;
      }
      if (!response || !response.ok) return;
      let rawObservations = (response.result && response.result.observations || [])
        .filter(function (obs) { return String(obs.originalText || obs.original_text || "").trim(); });
      if (rawObservations.length === 0) return;

      // 翻译 seam OCR 的原文
      let translatedObservations = rawObservations;
      if (typeof requestCanonicalTranslations === "function") {
        try {
          const items = rawObservations.map(function (obs, idx) { return {
            id: "seam-cross-" + pairKey + "-" + idx,
            revision: 1,
            original_text: obs.originalText || obs.original_text || ""
          }; });
          const tResp = await requestCanonicalTranslations(items, {
            sourceLanguage: adapters.sourceLanguage || "auto",
            targetLanguage: adapters.targetLanguage || "zh-CN",
            reason: "seam-cross-page"
          });
          if (tResp && tResp.ok) {
            const tMap = new Map();
            const tList = tResp.result && tResp.result.translations || tResp.translations || [];
            tList.forEach(function (t) { tMap.set(String(t.id || ""), t); });
            translatedObservations = rawObservations.map(function (obs, idx) {
              var t = tMap.get("seam-cross-" + pairKey + "-" + idx);
              var translated = t && String(t.translated_text || t.translatedText || "").trim();
              return translated ? Object.assign({}, obs, { translatedText: translated, originalText: obs.originalText || obs.original_text }) : obs;
            });
          }
        } catch (_error) {
          trace("seam-cross-translate-error", pageA.target || null, { pairKey, error: getErrorMessage(_error) });
        }
      }

      const payloadGeometry = captureSeamPayloadGeometry(seamPayload, [pageA, pageB]);
      if (typeof adapters.renderSeamCrossPage !== "function") return;
      try {
        adapters.renderSeamCrossPage({
          pageA, pageB, pairKey,
          canvasWidth: payloadGeometry.canvasWidth,
          canvasHeight: payloadGeometry.canvasHeight,
          segments: payloadGeometry.segments,
          observations: translatedObservations,
          debug: response.result && response.result.debug || null
        });
      } catch (_error) {
        trace("seam-cross-render-error", pageA.target || null, { pairKey, error: getErrorMessage(_error) });
      }
    }

    async function processSeamPair(pageA, pageB) {
      const pairKey = buildCanonicalPairKey(pageA, pageB);
      const existingState = store.getSeamState(pairKey);
      if (existingState && existingState.status !== "running") return existingState;

      return store.getOrCreateInflightJob(`canonical-seam:${pairKey}`, async () => {
        const currentState = store.getSeamState(pairKey);
        if (currentState && currentState.status !== "running") return currentState;
        let overlapRisk = null;
        try {
          overlapRisk = detectPixelRisk ? await detectPixelRisk(pageA, pageB) : null;
        } catch (error) {
          trace("pixel-risk-error", pageA.target, { pairKey, error: getErrorMessage(error) });
        }

        const evidenceDecision = evaluateSeamEvidence(pageA, pageB, overlapRisk, store);
        if (!evidenceDecision.shouldRun || !buildSeamPayload) {
          return store.markSeamState(pairKey, {
            status: "skipped",
            pageIds: [pageA.pageId, pageB.pageId],
            imageRevisionByPage: revisionsForPages([pageA, pageB]),
            reasons: evidenceDecision.reasons
          });
        }

        store.markSeamState(pairKey, {
          status: "running",
          pageIds: [pageA.pageId, pageB.pageId],
          imageRevisionByPage: revisionsForPages([pageA, pageB]),
          reasons: evidenceDecision.reasons
        });
        store.setCanonicalPagePhase(pageA.pageId, CanonicalPhase.SEAM_OCR);
        store.setCanonicalPagePhase(pageB.pageId, CanonicalPhase.SEAM_OCR);
        trace("seam-ocr", pageA.target, { pairKey });

        try {
          const seamPayload = await withCanonicalTimeout(
            buildSeamPayload(pageA, pageB, {
              height: evidenceDecision.bandHeight,
              bandHeight: evidenceDecision.bandHeight,
              overlap: overlapRisk
            }),
            seamTimeoutMs,
            "Seam payload timed out"
          );
          if (!seamPayload) throw new Error("Seam payload unavailable");
          const payloadGeometry = captureSeamPayloadGeometry(seamPayload, [pageA, pageB]);
          const response = await requestOcrForPayload(
            seamPayload,
            buildOcrMeta("seam", [pageA, pageB], pairKey, {
              requireCleanedImage: true,
              forceCleanedImageArtifact: true
            })
          );
          if (!response || !response.ok) throw new Error(response && response.error || "Seam OCR failed");
          if (!pageRevisionsStillMatch([pageA, pageB])) {
            return store.markSeamState(pairKey, {
              status: "stale",
              pageIds: [pageA.pageId, pageB.pageId],
              imageRevisionByPage: revisionsForPages([pageA, pageB])
            });
          }
          const seamEvidence = normalizeOcrEvidence(response.result, [pageA, pageB], "seam");
          store.upsertObservations(seamEvidence.observations);
          store.upsertObservations(seamEvidence.filteredObservations, { filtered: true });
          const terminal = store.markSeamState(pairKey, {
            status: "completed",
            pageIds: [pageA.pageId, pageB.pageId],
            imageRevisionByPage: revisionsForPages([pageA, pageB]),
            reasons: evidenceDecision.reasons,
            observationIds: seamEvidence.observations.map((item) => item.id),
            observations: seamEvidence.observations,
            filteredObservations: seamEvidence.filteredObservations,
            coordinateSpace: payloadGeometry.coordinateSpace,
            canvasWidth: payloadGeometry.canvasWidth,
            canvasHeight: payloadGeometry.canvasHeight,
            pageSpans: payloadGeometry.pageSpans,
            segments: payloadGeometry.segments,
            seam: payloadGeometry.seam,
            payloadGeometry,
            cleanedImage: seamEvidence.cleanedImage || null,
            cleanedImageToken: seamEvidence.cleanedImageToken || "",
            debug: seamEvidence.debug || null
          });
          trace("seam-complete", pageA.target, { pairKey, observations: seamEvidence.observations.length });
          publishCompletedSeamEvidence(terminal);
          return terminal;
        } catch (error) {
          // Explicit isolation: page observations remain authoritative and are reconciled normally.
          const terminal = store.markSeamState(pairKey, {
            status: "failed",
            pageIds: [pageA.pageId, pageB.pageId],
            imageRevisionByPage: revisionsForPages([pageA, pageB]),
            reasons: evidenceDecision.reasons,
            error: getErrorMessage(error)
          });
          trace("seam-error", pageA.target, { pairKey, error: terminal.error });
          return terminal;
        }
      });
    }

    function publishCompletedSeamEvidence(terminal) {
      if (!terminal || terminal.status !== "completed") return;
      const pageIds = Array.isArray(terminal.pageIds) ? terminal.pageIds.filter(Boolean) : [];
      releaseCompletedEdgeWaits();
      // Seam 是独立的增量证据生产者。即使发起它的 DOM job 随后失效，
      // revision 仍匹配的完成证据也必须触发新的 canonical snapshot。
      Promise.resolve().then(() => refreshCanonicalState({
        reason: "seam-evidence-complete",
        focusPageIds: pageIds
      })).catch((error) => {
        trace("seam-refresh-error", null, { error: getErrorMessage(error), pageIds });
      });
    }

    function evaluateSeamEvidence(pageA, pageB, overlapRisk, activeStore) {
      const reconciler = getCanonicalReconciler();
      const records = [pageA, pageB];
      const observations = dedupeObservationsById(
        activeStore.getObservationsForPage(pageA.pageId, { includeFiltered: false })
          .concat(activeStore.getObservationsForPage(pageB.pageId, { includeFiltered: false }))
      ).filter((item) => observationMatchesPageRevisions(item, records));
      const filtered = activeStore.getFilteredObservations().filter((item) =>
        item.pageIds.some((pageId) => pageId === pageA.pageId || pageId === pageB.pageId) &&
        observationMatchesPageRevisions(item, records)
      );
      if (reconciler && typeof reconciler.evaluateSeamEvidence === "function") {
        return reconciler.evaluateSeamEvidence({
          pageA: canonicalPageDescriptor(pageA),
          pageB: canonicalPageDescriptor(pageB),
          observations,
          filteredObservations: filtered,
          edgeSignals: { [pageA.pageId]: pageA.edgeSignals, [pageB.pageId]: pageB.edgeSignals },
          overlapRisk: overlapRisk ? {
            ...overlapRisk,
            detected: overlapRisk.detected === true || overlapRisk.accepted === true || overlapRisk.risk === true,
            ratio: Number(overlapRisk.ratio ?? overlapRisk.overlapRatio) || 0
          } : null
        });
      }
      const reasons = [];
      if ((pageA.edgeSides || []).includes("bottom") || (pageB.edgeSides || []).includes("top")) reasons.push("edge_observation");
      if (isCanonicalShortPage(pageA) || isCanonicalShortPage(pageB)) reasons.push("short_page");
      if (overlapRisk) reasons.push("pixel_overlap");
      return {
        shouldRun: reasons.length > 0,
        reasons,
        pairKey: buildCanonicalPairKey(pageA, pageB),
        bandHeight: calculateCanonicalSeamHeight(pageA.width, pageB.width)
      };
    }

    function ensureEdgeWait(record) {
      if (!record || !(record.edgeSides || []).length) return;
      const relevant = relevantAdjacentRelations(record);
      if (relevant.length > 0 && relevant.every((relation) => relationIsTerminal(record, relation))) {
        store.clearEdgeWait(record.pageId, clearTimer);
        return;
      }
      const existingWait = store.getEdgeWait(record.pageId);
      if (existingWait && existingWait.imageRevision === record.imageRevision) return;
      if (existingWait) store.clearEdgeWait(record.pageId, clearTimer);
      const deadline = now() + edgeWaitTimeoutMs;
      const waitState = { deadline, timedOut: false, timer: null, imageRevision: record.imageRevision };
      if (typeof setTimer === "function") {
        waitState.timer = setTimer(() => {
          const current = store.getEdgeWait(record.pageId);
          const currentRecord = store.getPageHandle(record.pageId);
          if (
            !current || !currentRecord ||
            current.imageRevision !== record.imageRevision ||
            current.imageRevision !== currentRecord.imageRevision
          ) return;
          store.setEdgeWait(record.pageId, { ...current, timer: null, timedOut: true });
          trace("edge-timeout", record.target, { pageId: record.pageId });
          void refreshCanonicalState({ reason: "edge-timeout", focusPageIds: [record.pageId] });
        }, edgeWaitTimeoutMs);
      }
      store.setEdgeWait(record.pageId, waitState);
    }

    function releaseCompletedEdgeWaits() {
      for (const record of store.getPageHandles()) {
        const wait = store.getEdgeWait(record.pageId);
        if (!wait || wait.timedOut) continue;
        const relevant = relevantAdjacentRelations(record);
        if (relevant.length > 0 && relevant.every((relation) => relationIsTerminal(record, relation))) {
          store.clearEdgeWait(record.pageId, clearTimer);
        }
      }
    }

    function relevantAdjacentRelations(record) {
      return (record.adjacentTargets || []).filter((relation) =>
        (relation.side === "previous" && (record.edgeSides || []).includes("top")) ||
        (relation.side === "next" && (record.edgeSides || []).includes("bottom"))
      );
    }

    function relationIsTerminal(record, relation) {
      const neighbor = store.getPageHandleForTarget(relation.target);
      if (!neighbor) return false;
      const pair = relation.side === "previous" ? [neighbor, record] : [record, neighbor];
      const state = store.getSeamState(buildCanonicalPairKey(pair[0], pair[1]));
      return !!state && ["completed", "failed", "skipped", "stale"].includes(state.status);
    }

    async function refreshCanonicalState({ reason, focusPageIds = [], guard = null } = {}) {
      const guardAllows = () => {
        if (typeof guard !== "function") return true;
        try {
          return guard() !== false;
        } catch {
          return false;
        }
      };
      if (!guardAllows()) return { aborted: true };
      trace("reconcile", null, { reason, pageIds: focusPageIds });
      const reconciliation = await store.runSerializedReconcile(() => {
        if (!guardAllows()) return null;
        for (const pageId of focusPageIds) store.setCanonicalPagePhase(pageId, CanonicalPhase.RECONCILING);
        const result = reconcileCanonicalEvidence(store);
        store.setCanonicalSnapshot(result);
        store.setCoverageLedger(result.ledger);
        store.setReconcileDiagnostics(result.diagnostics || {});
        assertCoverageInvariant(store);
        return result;
      });
      if (!reconciliation || !guardAllows()) return { aborted: true };

      // OCR debug 是识别阶段的诊断结果，不应等待外部翻译接口成功后才出现。
      // 此处只渲染 debug，不把暂时的空 projection 结算为无文字。
      await renderAllCanonicalPages(`${reason}:ocr-debug`, guardAllows, {
        debugOnly: true,
        focusPageIds
      });
      if (!guardAllows()) return { aborted: true };

      const eligible = reconciliation.canonicals.filter((canonical) =>
        canonical.status !== "filtered" && !canonicalWaitsForEdge(canonical)
      );
      trace("translate", null, { reason, count: eligible.length });
      for (const pageId of focusPageIds) store.setCanonicalPagePhase(pageId, CanonicalPhase.TRANSLATING);
      let translated;
      try {
        translated = await translateCanonicals(eligible, reason, guardAllows);
      } catch (error) {
        // 新 revision 翻译失败时仍要把上一版唯一可见译文标成 provisional；
        // 错误继续向上抛给重试调度，页面则不会在此期间变成空白。
        if (guardAllows()) {
          try {
            const fallbackSurfaces = buildSeamRenderSurfaceIndex(store, { isPageAvailable });
            const ordinaryFallbackProjections = buildCanonicalProjections(store);
            const fallbackProjections = buildCanonicalProjections(store, fallbackSurfaces.handledCanonicalIds);
            store.setProjections(fallbackProjections);
            await refreshRequiredCleanedArtifacts(fallbackProjections);
            if (guardAllows()) {
              // 每页是否完整由当前 canonical revision 和 provisional projection 独立判断。
              // 不能用一个失败项把全章其他已完成页面也降级成 pending。
              await renderAllCanonicalPages(`${reason}:translation-fallback`, guardAllows, {
                seamSurfaceIndex: fallbackSurfaces,
                fallbackProjectionsByPage: ordinaryFallbackProjections
              });
            }
          } catch (fallbackError) {
            trace("translation-fallback-render-error", null, { error: getErrorMessage(fallbackError) });
          }
        }
        throw error;
      }
      if (translated === false || !guardAllows()) return { aborted: true };

      trace("project", null, { reason });
      for (const pageId of focusPageIds) store.setCanonicalPagePhase(pageId, CanonicalPhase.PROJECTING);
      const seamSurfaceIndex = buildSeamRenderSurfaceIndex(store, { isPageAvailable });
      const ordinaryFallbackProjections = buildCanonicalProjections(store);
      const projections = buildCanonicalProjections(store, seamSurfaceIndex.handledCanonicalIds);
      store.setProjections(projections);
      await refreshRequiredCleanedArtifacts(projections);
      if (!guardAllows()) return { aborted: true };
      trace("render", null, { reason });
      for (const pageId of focusPageIds) store.setCanonicalPagePhase(pageId, CanonicalPhase.RENDERING);
      await renderAllCanonicalPages(reason, guardAllows, {
        seamSurfaceIndex,
        fallbackProjectionsByPage: ordinaryFallbackProjections
      });
      if (!guardAllows()) return { aborted: true };
      for (const pageId of focusPageIds) store.setCanonicalPagePhase(pageId, CanonicalPhase.RENDERED);
      return reconciliation;
    }

    function canonicalWaitsForEdge(canonical) {
      const memberIds = Array.isArray(canonical.memberObservationIds) ? canonical.memberObservationIds : [];
      for (const observationId of memberIds) {
        const observation = store.getObservations().find((item) => item.id === observationId);
        if (!observation || observation.sourceType === "seam") continue;
        for (const pageId of observation.pageIds) {
          const record = store.getPageHandle(pageId);
          if (!record || getObservationEdgeSides(observation, record).length === 0) continue;
          const pairPending = relevantAdjacentRelations(record).some((relation) => {
            const neighbor = store.getPageHandleForTarget(relation.target);
            if (!neighbor || !isReadyPageRecord(neighbor)) return false;
            const pair = relation.side === "previous" ? [neighbor, record] : [record, neighbor];
            const seam = store.getSeamState(buildCanonicalPairKey(pair[0], pair[1]));
            return !seam || !["completed", "failed", "skipped", "stale"].includes(seam.status);
          });
          if (pairPending) return true;
          const wait = store.getEdgeWait(pageId);
          if (wait && !wait.timedOut) return true;
        }
      }
      return false;
    }

    async function translateCanonicals(canonicals, reason, guardAllows = () => true) {
      const candidates = canonicals.map((canonical) => ({
        id: canonical.id,
        revision: Number(canonical.revision) || 1,
        original_text: String(canonical.originalText || canonical.original_text || ""),
        non_translate: canonical.nonTranslate === true
      })).filter((item) => item.original_text);
      const items = store.claimTranslations(candidates);
      if (items.length === 0) {
        await store.waitForPendingTranslations(candidates);
        const failures = store.getTranslationFailures(candidates);
        if (failures.length > 0) {
          throw new CanonicalTranslationError(failures.map((failure) => failure.error).filter(Boolean).join("; "));
        }
        return guardAllows();
      }
      if (!guardAllows()) {
        store.releaseTranslationClaims(items);
        return false;
      }

      let response;
      try {
        response = await requestCanonicalTranslations(items, {
          sourceLanguage: adapters.sourceLanguage || "auto",
          targetLanguage: adapters.targetLanguage || KAKAO_CANONICAL_TARGET_LANGUAGE,
          reason
        });
        if (!response || response.ok === false) {
          throw new CanonicalTranslationError(response && response.error || "Canonical translation request failed");
        }
      } catch (error) {
        store.failTranslationClaims(items, error);
        if (!guardAllows()) return false;
        trace("translation-error", null, { error: getErrorMessage(error), count: items.length });
        throw error;
      }

      const translations = response && response.result && Array.isArray(response.result.translations)
        ? response.result.translations
        : response && Array.isArray(response.translations) ? response.translations : [];
      const mayRender = guardAllows();
      const byKey = new Map(translations.map((translation) => [
        canonicalRevisionKey(translation && translation.id, translation && translation.revision),
        translation
      ]));
      const missing = [];
      for (const item of items) {
        const translation = byKey.get(canonicalRevisionKey(item.id, item.revision));
        if (translation && String(translation.translated_text || "").trim()) {
          store.settleTranslation(item, translation);
        } else {
          missing.push(item);
          trace("translation-partial", null, { id: item.id, revision: item.revision });
        }
      }
      if (missing.length > 0) {
        const error = new CanonicalTranslationError(`Translation response omitted ${missing.length} canonical item(s)`);
        store.failTranslationClaims(missing, error);
        trace("translation-error", null, { error: getErrorMessage(error), count: missing.length });
        throw error;
      }
      // 翻译事实按 canonical revision 保存；旧作业不能继续 project/render。
      // 若同 URL 重载后的摘要相同，新作业可以复用这次唯一的外部请求结果。
      return mayRender;
    }

    function buildCanonicalProjections(activeStore, handledCanonicalIds = new Set()) {
      const reconciler = getCanonicalReconciler();
      const pages = activeStore.getPageHandles().map(canonicalPageDescriptor);
      const previousProjections = activeStore.getAllProjections();
      const translations = new Map();
      const handledIds = handledCanonicalIds instanceof Set
        ? handledCanonicalIds
        : new Set(Array.from(handledCanonicalIds || [], String));
      const currentCanonicals = activeStore.getCanonicalSnapshot().filter((canonical) =>
        !handledIds.has(String(canonical && canonical.id || ""))
      );
      const canonicals = currentCanonicals.filter((canonical) => {
        const translation = activeStore.getTranslation(canonical.id, canonical.revision);
        if (!translation || !String(translation.translated_text || translation.translatedText || "").trim()) return false;
        translations.set(canonicalRevisionKey(canonical.id, canonical.revision), translation);
        return true;
      });
      const availablePageIds = pages.filter((page) => isPageAvailable(page.pageId)).map((page) => page.pageId);
      let flat = null;
      if (reconciler && typeof reconciler.buildRenderProjections === "function") {
        flat = reconciler.buildRenderProjections({ pages, canonicals, availablePageIds, translations });
      }
      if (!Array.isArray(flat)) {
        flat = fallbackBuildRenderProjections({
          pages,
          canonicals: canonicals.map((canonical) => ({
            ...canonical,
            translation: translations.get(canonicalRevisionKey(canonical.id, canonical.revision))
          })),
          availablePageIds
        });
      }
      const grouped = new Map();
      const existingCoverKeys = new Set(flat
        .filter((projection) => projection && projection.role === "cover")
        .map((projection) => `${String(projection.canonicalId || "")}|${String(projection.pageId || "")}`));
      for (const projection of flat) {
        if (!projection || !projection.pageId) continue;
        if (!grouped.has(projection.pageId)) grouped.set(projection.pageId, []);
        const normalized = Object.freeze({
          ...projection,
          cover: projection.cover !== false,
          translated_text: String(
            projection.translated_text ||
            projection.translatedText ||
            projection.bubble && projection.bubble.translated_text ||
            projection.translation && projection.translation.translated_text ||
            ""
          )
        });
        grouped.get(projection.pageId).push(normalized);
        // A standby keeps takeover metadata, while a distinct cover projection
        // hides the duplicate source text on the non-primary page.
        const coverKey = `${String(normalized.canonicalId || "")}|${String(normalized.pageId || "")}`;
        if (!existingCoverKeys.has(coverKey)) {
          for (const coverProjection of buildStandbyCoverProjections(normalized)) {
            grouped.get(projection.pageId).push(coverProjection);
          }
        }
      }
      for (const items of grouped.values()) items.sort(compareProjectionRecords);
      appendProvisionalProjectionFallbacks({
        grouped,
        previousProjections,
        currentCanonicals,
        activeStore,
        isPageAvailable
      });
      for (const [pageId, items] of grouped) {
        grouped.set(pageId, items.filter((projection) =>
          !handledIds.has(String(projection && projection.canonicalId || "")) &&
          !handledIds.has(String(projection && projection.pendingCanonicalId || ""))
        ));
      }
      return grouped;
    }

    function isPageAvailable(pageId) {
      const handle = store.getPageHandle(pageId);
      const target = getTargetForPageId ? getTargetForPageId(pageId) : handle && handle.target;
      return targetIsUsable(target);
    }

    async function refreshRequiredCleanedArtifacts(projectionsByPage) {
      const tasks = [];
      const crossPageCanonicalIds = collectCrossPageCanonicalIds(
        projectionsByPage,
        store.getCanonicalSnapshot()
      );
      for (const [pageId, projections] of projectionsByPage instanceof Map ? projectionsByPage.entries() : []) {
        if (!projectionsRequireCleanedImage(projections)) continue;
        const handle = store.getPageHandle(pageId);
        if (!handle || !handle.payload) continue;
        const cleanedMasks = buildCanonicalCleanMasks(projections, crossPageCanonicalIds);
        const artifactKey = buildCleanedArtifactKey(handle.imageRevision, cleanedMasks);
        if (handle.cleanedImageArtifactKey === artifactKey && isDataUrlValue(handle.cleanedImage)) continue;
        if (handle.artifactRefreshAttemptedKey === artifactKey) continue;
        if (
          handle.artifactRefreshRetryKey === artifactKey &&
          Number(handle.artifactRefreshRetryAfter || 0) > now()
        ) continue;
        if (handle.artifactRefreshRetryTimer && typeof clearTimer === "function") {
          clearTimer(handle.artifactRefreshRetryTimer);
        }
        store.registerPageHandle({
          ...handle,
          artifactRefreshAttemptedRevision: handle.imageRevision,
          artifactRefreshAttemptedKey: artifactKey,
          artifactRefreshRetryKey: "",
          artifactRefreshRetryAfter: 0,
          artifactRefreshRetryTimer: null
        });
        const releaseArtifactAttempt = () => {
          const current = store.getPageHandle(handle.pageId);
          if (
            current &&
            current.imageRevision === handle.imageRevision &&
            current.artifactRefreshAttemptedKey === artifactKey
          ) {
            const failureCount = current.artifactRefreshFailureKey === artifactKey
              ? Number(current.artifactRefreshFailureCount || 0) + 1
              : 1;
            const shouldSchedule = failureCount <= KAKAO_CLEANED_ARTIFACT_AUTO_RETRY_LIMIT &&
              typeof setTimer === "function";
            let retryTimer = null;
            if (shouldSchedule) {
              retryTimer = setTimer(() => {
                const latest = store.getPageHandle(handle.pageId);
                if (
                  !latest ||
                  latest.imageRevision !== handle.imageRevision ||
                  latest.artifactRefreshRetryKey !== artifactKey ||
                  latest.artifactRefreshRetryTimer !== retryTimer
                ) return;
                store.registerPageHandle({
                  ...latest,
                  artifactRefreshRetryAfter: 0,
                  artifactRefreshRetryTimer: null
                });
                if (!isPageAvailable(handle.pageId)) return;
                void refreshCanonicalState({
                  reason: "cleaned-artifact-retry",
                  focusPageIds: [handle.pageId]
                }).catch((error) => {
                  trace("cleaned-artifact-retry-error", handle.target, {
                    pageId: handle.pageId,
                    error: getErrorMessage(error)
                  });
                });
              }, KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS);
            }
            store.registerPageHandle({
              ...current,
              artifactRefreshAttemptedKey: "",
              artifactRefreshRetryKey: artifactKey,
              artifactRefreshRetryAfter: now() + KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS,
              artifactRefreshRetryTimer: retryTimer,
              artifactRefreshFailureKey: artifactKey,
              artifactRefreshFailureCount: failureCount
            });
          }
        };
        tasks.push(store.getOrCreateInflightJob(
          `canonical-cleaned-artifact:${handle.pageId}:${artifactKey}`,
          async () => {
            try {
              const response = await requestOcrForPayload(
                handle.payload,
                buildOcrMeta("page", [handle], "", {
                  requireCleanedImage: true,
                  forceCleanedImageArtifact: true,
                  cleanedMasks
                })
              );
              if (!response || !response.ok) {
                trace("cleaned-artifact-error", handle.target, {
                  pageId: handle.pageId,
                  error: response && response.error || "artifact refresh failed"
                });
                releaseArtifactAttempt();
                return;
              }
              const cleanedImage = response.result && (response.result.cleanedImage || response.result.cleaned_image);
              if (!isDataUrlValue(cleanedImage)) {
                trace("cleaned-artifact-error", handle.target, {
                  pageId: handle.pageId,
                  error: "artifact refresh returned no cleaned image"
                });
                releaseArtifactAttempt();
                return;
              }
              const current = store.getPageHandle(handle.pageId);
              if (
                !current ||
                current.imageRevision !== handle.imageRevision ||
                current.artifactRefreshAttemptedKey !== artifactKey
              ) return;
              store.registerPageHandle({
                ...current,
                cleanedImage,
                cleanedImageRevision: current.imageRevision,
                cleanedImageArtifactKey: artifactKey,
                artifactRefreshRetryKey: "",
                artifactRefreshRetryAfter: 0,
                artifactRefreshRetryTimer: null,
                artifactRefreshFailureKey: "",
                artifactRefreshFailureCount: 0,
                ocrDebug: response.result && response.result.debug || current.ocrDebug || null
              });
            } catch (error) {
              trace("cleaned-artifact-error", handle.target, { pageId: handle.pageId, error: getErrorMessage(error) });
              releaseArtifactAttempt();
            }
          }
        ));
      }
      await Promise.all(tasks);
    }

    function getCanonicalPageTranslationStatus(pageId, projections = []) {
      const normalizedPageId = String(pageId || "");
      const observationById = new Map(store.getObservations().map((item) => [String(item.id || ""), item]));
      const relevant = store.getCanonicalSnapshot().filter((canonical) => {
        if (!canonical || canonical.status === "filtered") return false;
        if (canonical.geometryByPage && canonical.geometryByPage[normalizedPageId]) return true;
        return (Array.isArray(canonical.memberObservationIds) ? canonical.memberObservationIds : [])
          .some((id) => {
            const observation = observationById.get(String(id || ""));
            return observation && Array.isArray(observation.pageIds) && observation.pageIds.includes(normalizedPageId);
          });
      });
      const provisional = (Array.isArray(projections) ? projections : []).some((projection) =>
        projection && (projection.provisional === true || projection.pendingCanonicalId)
      );
      const complete = !provisional && relevant.every((canonical) =>
        !canonicalWaitsForEdge(canonical) && !!store.getTranslation(canonical.id, canonical.revision)
      );
      return { relevantCount: relevant.length, complete };
    }

    async function renderAllCanonicalPages(reason, guardAllows = () => true, options = {}) {
      const focusPageIds = new Set((Array.isArray(options.focusPageIds) ? options.focusPageIds : []).map(String));
      const seamSurfaceIndex = options.seamSurfaceIndex || buildSeamRenderSurfaceIndex(store, { isPageAvailable });
      const fallbackProjectionMap = options.fallbackProjectionsByPage instanceof Map
        ? options.fallbackProjectionsByPage
        : new Map();
      const descriptors = [];
      for (const handle of store.getPageHandles()) {
        if (!guardAllows()) return;
        // 全局 reconcile 会遍历已经登记的所有页面，其中可能包含仍在 OCR 的并发页面。
        // 这类页面的空 projections 只是“尚未产出”，不能交给渲染层结算为无文字。
        if (!isReadyPageRecord(handle)) continue;
        const seamSurfaces = seamSurfaceIndex.byPage.get(String(handle.pageId)) || Object.freeze([]);
        const handledCanonicalIds = new Set(seamSurfaces.flatMap((surface) => surface.handledCanonicalIds || []));
        if (options.debugOnly === true && !handle.ocrDebug && !seamSurfaces.some((surface) => surface.debug)) continue;
        if (
          options.debugOnly === true &&
          focusPageIds.size > 0 &&
          !focusPageIds.has(String(handle.pageId)) &&
          seamSurfaces.length === 0
        ) continue;
        const target = getTargetForPageId ? getTargetForPageId(handle.pageId) : handle.target;
        if (!targetIsUsable(target)) continue;
        const storedProjections = store.getProjections(handle.pageId).filter((projection) =>
          !handledCanonicalIds.has(String(projection && projection.canonicalId || "")) &&
          !handledCanonicalIds.has(String(projection && projection.pendingCanonicalId || ""))
        );
        if (
          options.debugOnly === true &&
          seamSurfaces.length === 0 &&
          storedProjections.some((item) => item.activeText && item.translated_text)
        ) {
          continue;
        }
        const projections = options.debugOnly === true ? [] : storedProjections;
        const terminal = store.getPageTerminal(handle.pageId);
        const observationCount = Number(terminal && terminal.details && terminal.details.observationCount);
        const translationStatus = getCanonicalPageTranslationStatus(handle.pageId, projections);
        const authoritativeEmpty = options.debugOnly !== true &&
          seamSurfaces.length === 0 &&
          Number.isFinite(observationCount) &&
          (observationCount === 0 || translationStatus.relevantCount === 0);
        const translationComplete = options.debugOnly !== true &&
          options.translationComplete !== false &&
          translationStatus.complete;
        const activeBubbles = projections.filter((item) => item.activeText && item.translated_text).map(projectionToBubble);
        descriptors.push({
          handle,
          target,
          pageId: handle.pageId,
          projections,
          fallbackProjections: fallbackProjectionMap.get(String(handle.pageId)) || projections,
          seamSurfaces,
          activeBubbles,
          translationComplete,
          authoritativeEmpty
        });
      }

      const descriptorByPage = new Map(descriptors.map((descriptor) => [String(descriptor.pageId), descriptor]));
      const uniqueSurfaces = new Map();
      for (const descriptor of descriptors) {
        for (const surface of descriptor.seamSurfaces) {
          uniqueSurfaces.set(String(surface.renderKey || surface.pairKey || ""), surface);
        }
      }
      const batchSurfaces = [...uniqueSurfaces.values()].filter((surface) =>
        (surface.pageIds || []).every((pageId) => descriptorByPage.has(String(pageId)))
      );
      const batchPageIds = new Set(batchSurfaces.flatMap((surface) => surface.pageIds || []).map(String));
      const renderDescriptor = async (descriptor, extra = {}) => renderCanonicalProjections({
        target: descriptor.target,
        pageId: descriptor.pageId,
        targetKey: descriptor.handle.targetKey,
        scopedTargetKey: descriptor.handle.scopedTargetKey,
        projections: descriptor.projections,
        seamSurfaces: extra.seamSurfaces || descriptor.seamSurfaces,
        result: {
          bubbles: descriptor.activeBubbles,
          cleanedImage: descriptor.handle.cleanedImage || null,
          debug: descriptor.handle.ocrDebug || null
        },
        payload: descriptor.handle.payload,
        cleanedImage: descriptor.handle.cleanedImage || null,
        debug: descriptor.handle.ocrDebug || null,
        debugOnly: options.debugOnly === true,
        translationComplete: descriptor.translationComplete,
        authoritativeEmpty: descriptor.authoritativeEmpty,
        reason,
        ...extra
      });

      if (batchPageIds.size > 0) {
        const batchDescriptors = [...batchPageIds].map((pageId) => descriptorByPage.get(pageId)).filter(Boolean);
        const first = batchDescriptors[0];
        const mapByPage = (selector) => new Map(batchDescriptors.map((descriptor) => [
          String(descriptor.pageId),
          selector(descriptor)
        ]));
        // 两个裁剪视窗携带各自完整的普通 projection/debug/payload，在同一次调用里原子安装。
        await renderDescriptor(first, {
          seamSurfaces: batchSurfaces,
          projectionsByPage: mapByPage((descriptor) => descriptor.projections),
          fallbackProjectionsByPage: mapByPage((descriptor) => descriptor.fallbackProjections),
          payloadByPage: mapByPage((descriptor) => descriptor.handle.payload),
          cleanedImageByPage: mapByPage((descriptor) => descriptor.handle.cleanedImage || null),
          debugByPage: mapByPage((descriptor) => descriptor.handle.ocrDebug || null),
          translationCompleteByPage: mapByPage((descriptor) => descriptor.translationComplete),
          authoritativeEmptyByPage: mapByPage((descriptor) => descriptor.authoritativeEmpty)
        });
      }

      for (const descriptor of descriptors) {
        if (!guardAllows()) return;
        if (batchPageIds.has(String(descriptor.pageId))) continue;
        await renderDescriptor(descriptor, {
          seamSurfaces: [],
          fallbackProjectionsByPage: new Map([[
            String(descriptor.pageId),
            descriptor.fallbackProjections
          ]])
        });
      }
    }

    async function runCached(target, _cachedResult, options = {}) {
      const handle = store.getPageHandleForTarget(target);
      if (!handle || !isReadyPageRecord(handle)) {
        return run(target, { ...options, reason: options.reason || "store-cache-miss" });
      }
      await refreshCanonicalState({ reason: "store-cache", focusPageIds: [handle.pageId] });
      return {
        ok: true,
        reused: true,
        pageId: handle.pageId,
        bubbles: store.getProjections(handle.pageId).filter((item) => item.activeText).length
      };
    }

    function pageRevisionsStillMatch(records) {
      return records.every((record) => {
        const current = store.getPageHandle(record.pageId);
        return current && current.imageRevision === record.imageRevision;
      });
    }

    async function onAdjacentTargetAvailable(previousTarget, nextTarget) {
      let previous = store.getPageHandleForTarget(previousTarget);
      let next = store.getPageHandleForTarget(nextTarget);
      if (!previous || !next) return { ok: false, skipped: true, reason: "page-not-observed" };
      if (!previous.chapterId || previous.chapterId !== next.chapterId) {
        return { ok: false, skipped: true, reason: "chapter-mismatch" };
      }
      previous = store.registerPageHandle({
        ...previous,
        nextPageId: next.pageId,
        adjacentPageIds: Object.freeze(Array.from(new Set([...(previous.adjacentPageIds || []), next.pageId])).sort()),
        adjacentTargets: Object.freeze(mergeAdjacentTargetRelation(previous.adjacentTargets, { side: "next", target: nextTarget }))
      });
      next = store.registerPageHandle({
        ...next,
        previousPageId: previous.pageId,
        adjacentPageIds: Object.freeze(Array.from(new Set([...(next.adjacentPageIds || []), previous.pageId])).sort()),
        adjacentTargets: Object.freeze(mergeAdjacentTargetRelation(next.adjacentTargets, { side: "previous", target: previousTarget }))
      });
      if (!isReadyPageRecord(previous) || !isReadyPageRecord(next)) {
        return { ok: false, skipped: true, reason: "page-ocr-pending" };
      }
      await processSeamPair(previous, next);
      releaseCompletedEdgeWaits();
      await refreshCanonicalState({
        reason: "adjacent-target-available",
        focusPageIds: [previous.pageId, next.pageId]
      });
      return { ok: true, pageIds: [previous.pageId, next.pageId] };
    }

    return Object.freeze({
      store,
      run,
      runCached,
      refresh: refreshCanonicalState,
      processAdjacentPairs,
      processSeamPair,
      onAdjacentTargetAvailable,
      CanonicalPhase
    });
  }

  function requireCanonicalAdapter(adapters, ...names) {
    for (const name of names) {
      if (typeof adapters[name] === "function") return adapters[name];
    }
    throw new Error(`KakaoCanonicalPipeline: missing adapter "${names.join(" or ")}"`);
  }

  function defaultIsAuthoritativePagePayload(payload) {
    if (!payload || typeof payload !== "object") return false;
    const source = String(payload.source || "").trim().toLowerCase();
    const mode = String(payload.captureMode || payload.capture_mode || "").trim().toLowerCase();
    return source !== "visible-tab-crop" && source !== "screenshot" && mode !== "screenshot";
  }

  class CanonicalPageOcrError extends Error {
    constructor(message) {
      super(message);
      this.name = "CanonicalPageOcrError";
    }
  }

  class CanonicalTranslationError extends Error {
    constructor(message) {
      super(message);
      this.name = "CanonicalTranslationError";
    }
  }

  function canonicalRevisionKey(id, revision) {
    return `${String(id || "")}@${Math.max(1, Number(revision) || 1)}`;
  }

  function compareStableIds(left, right) {
    return String(left && left.id || left || "").localeCompare(String(right && right.id || right || ""));
  }

  function comparePageRecords(left, right) {
    const leftOrder = Number(left && left.readingOrder);
    const rightOrder = Number(right && right.readingOrder);
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left && left.pageId || "").localeCompare(String(right && right.pageId || ""));
  }

  function compareCanonicalRecords(left, right) {
    const leftPages = Object.keys(left && left.geometryByPage || {});
    const rightPages = Object.keys(right && right.geometryByPage || {});
    const pageCompare = String(leftPages[0] || "").localeCompare(String(rightPages[0] || ""));
    return pageCompare || compareStableIds(left, right);
  }

  function compareProjectionRecords(left, right) {
    const roleOrder = { primary: 0, standby: 1, cover: 2 };
    const roleCompare = (roleOrder[left && left.role] ?? 9) - (roleOrder[right && right.role] ?? 9);
    return roleCompare || String(left && left.canonicalId || "").localeCompare(String(right && right.canonicalId || ""));
  }

  function freezeCanonicalValue(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    if (Array.isArray(value)) return Object.freeze(value.map(freezeCanonicalValue));
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = freezeCanonicalValue(item);
    return Object.freeze(copy);
  }

  function freezeObservation(observation) {
    const pageIds = Object.freeze((Array.isArray(observation.pageIds) ? observation.pageIds : []).map(String));
    const imageRevisionByPage = Object.freeze({ ...(observation.imageRevisionByPage || {}) });
    const pageSpans = Object.freeze((Array.isArray(observation.pageSpans) ? observation.pageSpans : []).map((span) => Object.freeze({
      ...span,
      pageId: String(span && span.pageId || ""),
      box: span && span.box ? Object.freeze({ ...span.box }) : null,
      polygon: Array.isArray(span && span.polygon)
        ? Object.freeze(span.polygon.map((point) => Object.freeze(Array.isArray(point) ? [...point] : { ...point })))
        : span && span.polygon || null
    })));
    return Object.freeze({
      ...observation,
      id: String(observation.id),
      sourceType: observation.sourceType === "seam" ? "seam" : "page",
      pageIds,
      imageRevisionByPage,
      pageSpans,
      originalText: String(observation.originalText || observation.original_text || ""),
      visual: freezeCanonicalValue(observation.visual || {})
    });
  }

  function freezeCanonical(canonical) {
    const geometryByPage = {};
    for (const [pageId, geometry] of Object.entries(canonical.geometryByPage || {})) {
      geometryByPage[pageId] = freezeCanonicalValue(geometry);
    }
    return Object.freeze({
      ...canonical,
      id: String(canonical.id),
      revision: Math.max(1, Number(canonical.revision) || 1),
      memberObservationIds: Object.freeze((Array.isArray(canonical.memberObservationIds) ? canonical.memberObservationIds : []).map(String).sort()),
      originalText: String(canonical.originalText || canonical.original_text || ""),
      geometryByPage: Object.freeze(geometryByPage),
      status: String(canonical.status || "ready")
    });
  }

  function validatePageIdentity(identity) {
    if (!identity || !identity.pageId) throw new Error("KakaoCanonicalPipeline: pageId missing");
    if (!identity.imageRevision) throw new Error("KakaoCanonicalPipeline: imageRevision missing");
    if (!(Number(identity.width) > 0) || !(Number(identity.height) > 0)) {
      throw new Error("KakaoCanonicalPipeline: natural page dimensions missing");
    }
  }

  function revisionsForPages(records) {
    return Object.fromEntries(records.map((record) => [record.pageId, record.imageRevision]));
  }

  function buildOcrMeta(sourceType, records, pairKey = "", options = {}) {
    const pageIds = records.map((record) => record.pageId);
    return Object.freeze({
      sourceType,
      pageIds,
      imageRevision: records.length === 1 ? records[0].imageRevision : "",
      imageRevisionByPage: Object.freeze(revisionsForPages(records)),
      imageMeta: records.length === 1 ? records[0].imageMeta || records[0].identity && records[0].identity.imageMeta || null : {
        pairKey,
        pages: records.map((record) => ({ pageId: record.pageId, width: record.width, height: record.height }))
      },
      requireCleanedImage: options.requireCleanedImage === true,
      forceCleanedImageArtifact: options.forceCleanedImageArtifact === true,
      cleanedMasks: freezeCanonicalValue(Array.isArray(options.cleanedMasks) ? options.cleanedMasks : []),
      requestKey: sourceType === "page"
        ? `page:${pageIds[0]}:${records[0].imageRevision}`
        : `seam:${pairKey}`
    });
  }

  function getCanonicalReconciler() {
    return globalThis.MangaTranslatorKakaoReconciler || null;
  }

  function canonicalPageDescriptor(record) {
    return Object.freeze({
      chapterId: String(record && record.chapterId || ""),
      pageId: String(record && record.pageId || ""),
      imageRevision: String(record && record.imageRevision || ""),
      width: Number(record && record.width) || 1,
      height: Number(record && record.height) || 1,
      readingOrder: Number.isFinite(Number(record && record.readingOrder)) ? Number(record.readingOrder) : undefined,
      shortPage: isCanonicalShortPage(record),
      edgeSignals: record && record.edgeSignals || null,
      previousPageId: String(record && record.previousPageId || ""),
      nextPageId: String(record && record.nextPageId || ""),
      adjacentPageIds: Object.freeze((Array.isArray(record && record.adjacentPageIds) ? record.adjacentPageIds : []).map(String).sort())
    });
  }

  function normalizeOcrEvidence(result, records, sourceType) {
    const payload = result && typeof result === "object" ? result : {};
    const normalizeItems = (items, filtered) => (Array.isArray(items) ? items : []).map((item) => {
      const pageIds = Array.isArray(item && item.pageIds) && item.pageIds.length
        ? item.pageIds.map(String)
        : records.map((record) => record.pageId);
      const imageRevisionByPage = {
        ...revisionsForPages(records),
        ...(item && item.imageRevisionByPage || {})
      };
      let pageSpans = Array.isArray(item && item.pageSpans) ? item.pageSpans : [];
      if (pageSpans.length === 0 && records.length === 1 && item && (item.box || item.bbox || item.polygon)) {
        pageSpans = [{
          pageId: records[0].pageId,
          box: item.box || item.bbox || null,
          polygon: item.polygon || null,
          overlapRatio: 1
        }];
      }
      const providerBlockId = String(item && (item.providerBlockId || item.provider_block_id || item.id) || "");
      const originalText = String(item && (item.originalText || item.original_text || item.text) || "");
      const id = String(item && item.id || buildFallbackObservationId({
        providerBlockId,
        sourceType,
        pageIds,
        imageRevisionByPage,
        originalText,
        pageSpans
      }));
      const candidate = {
        ...(item || {}),
        id,
        sourceType,
        pageIds,
        imageRevisionByPage,
        pageSpans,
        originalText,
        confidence: Number(item && (item.confidence ?? item.score)) || 0,
        visual: item && item.visual || null,
        providerBlockId,
        ...(filtered ? { filterReason: String(item && (item.filterReason || item.filter_reason) || "provider_filtered") } : {})
      };
      const reconciler = getCanonicalReconciler();
      if (reconciler && typeof reconciler.createObservation === "function") {
        try {
          return reconciler.createObservation(candidate);
        } catch (_error) {
          // Keep provider-neutral evidence available even when optional validation rejects extras.
        }
      }
      return freezeObservation(candidate);
    });
    return Object.freeze({
      observations: normalizeItems(payload.observations, false),
      filteredObservations: normalizeItems(payload.filteredObservations || payload.filtered_observations, true),
      edgeSignals: payload.edgeSignals || payload.edge_signals || null,
      cleanedImage: payload.cleanedImage || payload.cleaned_image || null,
      cleanedImageToken: String(payload.cleanedImageToken || payload.cleaned_image_token || ""),
      debug: payload.debug || null
    });
  }

  function normalizeSeamGeometryRect(value) {
    if (!value || typeof value !== "object") return null;
    const x = Number(value.x ?? value.left);
    const y = Number(value.y ?? value.top);
    const w = Number(value.w ?? value.width);
    const h = Number(value.h ?? value.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  function captureSeamPayloadGeometry(payload, records = []) {
    const source = payload && typeof payload === "object" ? payload : {};
    const rawSeam = source.seam && typeof source.seam === "object" ? source.seam : {};
    const canvasWidth = Number(rawSeam.canvasWidth ?? source.width ?? source.sourceWidth) || 0;
    const canvasHeight = Number(rawSeam.canvasHeight ?? source.height ?? source.sourceHeight) || 0;
    const fallbackByPage = new Map((Array.isArray(records) ? records : []).map((record) => [String(record.pageId || ""), record]));
    const segments = (Array.isArray(rawSeam.segments) ? rawSeam.segments : Array.isArray(source.segments) ? source.segments : [])
      .map((segment) => {
        const pageId = String(segment && segment.pageId || "");
        const fallback = fallbackByPage.get(pageId) || {};
        const drawRect = normalizeSeamGeometryRect(segment && segment.drawRect);
        const sourceCrop = normalizeSeamGeometryRect(segment && segment.sourceCrop);
        if (!pageId || !drawRect || !sourceCrop) return null;
        return {
          pageId,
          drawRect,
          sourceCrop,
          naturalWidth: Number(segment && segment.naturalWidth) || Number(fallback.width) || 0,
          naturalHeight: Number(segment && segment.naturalHeight) || Number(fallback.height) || 0
        };
      })
      .filter(Boolean);
    return freezeCanonicalValue({
      coordinateSpace: String(source.coordinateSpace || "kakao-seam-v1"),
      canvasWidth,
      canvasHeight,
      pageSpans: Array.isArray(source.pageSpans) ? source.pageSpans : [],
      segments,
      seam: { ...rawSeam, canvasWidth, canvasHeight, segments }
    });
  }

  function normalizeSeamPercentBox(value) {
    if (!value || typeof value !== "object") return null;
    let x = Number(value.x ?? value.left);
    let y = Number(value.y ?? value.top);
    let w = Number(value.w ?? value.width);
    let h = Number(value.h ?? value.height);
    const coordinateSpace = String(value.coordinateSpace || value.coordinate_space || "").toLowerCase();
    if (coordinateSpace === "normalized" || coordinateSpace === "ratio") {
      x *= 100;
      y *= 100;
      w *= 100;
      h *= 100;
    }
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const left = clamp(x, 0, 100);
    const top = clamp(y, 0, 100);
    const right = clamp(x + w, 0, 100);
    const bottom = clamp(y + h, 0, 100);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function seamPercentPolygonBounds(value) {
    const points = (Array.isArray(value) ? value : [])
      .map((point) => ({
        x: Number(Array.isArray(point) ? point[0] : point && point.x),
        y: Number(Array.isArray(point) ? point[1] : point && point.y)
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 3) return null;
    return normalizeSeamPercentBox({
      x: Math.min(...points.map((point) => point.x)),
      y: Math.min(...points.map((point) => point.y)),
      w: Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
      h: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))
    });
  }

  function rawSeamBoxToPercent(value, canvasWidth, canvasHeight) {
    const rect = normalizeSeamGeometryRect(value);
    if (!rect || !(canvasWidth > 0) || !(canvasHeight > 0)) return null;
    return normalizeSeamPercentBox({
      x: rect.x / canvasWidth * 100,
      y: rect.y / canvasHeight * 100,
      w: rect.w / canvasWidth * 100,
      h: rect.h / canvasHeight * 100
    });
  }

  function unionSeamPercentBoxes(boxes) {
    const valid = (Array.isArray(boxes) ? boxes : []).filter(Boolean);
    if (!valid.length) return null;
    const left = Math.min(...valid.map((box) => box.x));
    const top = Math.min(...valid.map((box) => box.y));
    const right = Math.max(...valid.map((box) => box.x + box.w));
    const bottom = Math.max(...valid.map((box) => box.y + box.h));
    return normalizeSeamPercentBox({ x: left, y: top, w: right - left, h: bottom - top });
  }

  function observationHasTrueSeamContribution(observation, pageIds) {
    if (!observation || observation.sourceType !== "seam") return false;
    const spans = Array.isArray(observation.pageSpans) ? observation.pageSpans : [];
    const acceptedPageIds = new Set((Array.isArray(pageIds) ? pageIds : []).map(String));
    return spans.some((span) => {
      if (!acceptedPageIds.has(String(span && span.pageId || ""))) return false;
      if (!normalizeSeamPercentBox(span && span.box)) return false;
      return span.overlapRatio == null || Number(span.overlapRatio) > 0;
    });
  }

  function seamObservationsCoverPair(observations, pageIds) {
    const covered = new Set();
    for (const observation of Array.isArray(observations) ? observations : []) {
      for (const span of Array.isArray(observation && observation.pageSpans) ? observation.pageSpans : []) {
        const pageId = String(span && span.pageId || "");
        if (
          pageIds.includes(pageId) &&
          normalizeSeamPercentBox(span && span.box) &&
          (span.overlapRatio == null || Number(span.overlapRatio) > 0)
        ) {
          covered.add(pageId);
        }
      }
    }
    return pageIds.every((pageId) => covered.has(pageId));
  }

  function isValidSeamSurfaceSegment(segment) {
    return !!segment &&
      !!String(segment.pageId || "") &&
      !!normalizeSeamGeometryRect(segment.drawRect) &&
      !!normalizeSeamGeometryRect(segment.sourceCrop) &&
      Number(segment.naturalWidth) > 0 &&
      Number(segment.naturalHeight) > 0;
  }

  function hasRenderableSeamDebug(debug) {
    if (!debug || typeof debug !== "object") return false;
    return [debug.rawItems, debug.duplicateItems, debug.dedupedItems, debug.finalBubbles]
      .some((items) => Array.isArray(items) && items.length > 0);
  }

  function seamObservationCaptureBox(observation, canvasWidth, canvasHeight) {
    const visual = observation && observation.visual && typeof observation.visual === "object"
      ? observation.visual
      : {};
    const bgType = String(visual.bgType || visual.bg_type || "none").trim().toLowerCase();
    const regionBounds = seamPercentPolygonBounds(visual.regionPolygon || visual.region_polygon);
    const fillBox = normalizeSeamPercentBox(visual.fillBox || visual.fill_box);
    // 纯色 caption/speech panel 的区域多边形才是单页最终呈现使用的完整清理边界；
    // OCR 文字 union 只覆盖字形，会在跨缝处留下用户看到的半截原文。
    return (bgType === "solid" ? regionBounds || fillBox : fillBox || regionBounds)
      || normalizeSeamPercentBox(visual.box)
      || seamPercentPolygonBounds(visual.polygon)
      || rawSeamBoxToPercent(visual.rawBox || visual.raw_box, canvasWidth, canvasHeight);
  }

  function selectSeamVisualObservation(observations) {
    return [...(Array.isArray(observations) ? observations : [])].sort((left, right) => {
      const leftBg = Number(left && left.visual && (left.visual.bgConfidence ?? left.visual.bg_confidence)) || 0;
      const rightBg = Number(right && right.visual && (right.visual.bgConfidence ?? right.visual.bg_confidence)) || 0;
      return rightBg - leftBg
        || (Number(right && right.confidence) || 0) - (Number(left && left.confidence) || 0)
        || Array.from(String(right && right.originalText || "")).length - Array.from(String(left && left.originalText || "")).length
        || String(left && left.id || "").localeCompare(String(right && right.id || ""));
    })[0] || null;
  }

  function buildSeamSurfaceBubble(canonical, translation, observations, canvasWidth, canvasHeight) {
    const linked = (Array.isArray(observations) ? observations : [])
      .filter((observation) => seamObservationCaptureBox(observation, canvasWidth, canvasHeight));
    if (!linked.length) return null;
    const box = unionSeamPercentBoxes(linked.map((observation) =>
      seamObservationCaptureBox(observation, canvasWidth, canvasHeight)
    ));
    if (!box) return null;
    const selected = selectSeamVisualObservation(linked);
    const rawVisual = selected && selected.visual && typeof selected.visual === "object" ? selected.visual : {};
    const translatedText = String(translation && (translation.translated_text || translation.translatedText) || "").trim();
    if (!translatedText) return null;
    const bgType = String(rawVisual.bgType || rawVisual.bg_type || "none");
    const bgColor = String(rawVisual.bgColor || rawVisual.bg_color || "");
    const bgConfidence = Number(rawVisual.bgConfidence ?? rawVisual.bg_confidence) || 0;
    const regionId = String(rawVisual.regionId || rawVisual.region_id || "");
    const regionType = String(rawVisual.regionType || rawVisual.region_type || "plain_text");
    const regionPolygon = rawVisual.regionPolygon || rawVisual.region_polygon || null;
    const polygon = bgType.trim().toLowerCase() === "solid"
      ? regionPolygon || null
      : rawVisual.polygon || null;
    const textColor = String(rawVisual.textColor || rawVisual.text_color || "");
    const strokeColor = String(rawVisual.strokeColor || rawVisual.stroke_color || "");
    const rotationDeg = Number(rawVisual.rotationDeg ?? rawVisual.rotation_deg) || 0;
    const sourceLineCount = Math.max(
      linked.length,
      Number(rawVisual.sourceLineCount ?? rawVisual.source_line_count) || 1
    );
    const visual = freezeCanonicalValue({
      ...rawVisual,
      fillBox: box,
      fill_box: box,
      bgType,
      bg_type: bgType,
      bgColor,
      bg_color: bgColor,
      bgConfidence,
      bg_confidence: bgConfidence,
      regionId,
      region_id: regionId,
      regionType,
      region_type: regionType,
      textColor,
      text_color: textColor,
      strokeColor,
      stroke_color: strokeColor,
      rotationDeg,
      rotation_deg: rotationDeg,
      sourceLineCount,
      source_line_count: sourceLineCount
    });
    return freezeCanonicalValue({
      id: `${canonical.id}:seam`,
      block_id: `${canonical.id}:seam`,
      canonicalId: String(canonical.id),
      canonical_id: String(canonical.id),
      canonicalRevision: Math.max(1, Number(canonical.revision) || 1),
      canonical_revision: Math.max(1, Number(canonical.revision) || 1),
      coordinateSpace: "percent",
      coordinate_space: "percent",
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      originalText: String(canonical.originalText || canonical.original_text || ""),
      original_text: String(canonical.originalText || canonical.original_text || ""),
      translatedText,
      translated_text: translatedText,
      visual,
      fill_box: box,
      bg_type: bgType,
      bg_color: bgColor,
      bg_confidence: bgConfidence,
      region_id: regionId,
      region_type: regionType,
      region_polygon: regionPolygon,
      polygon,
      text_color: textColor,
      stroke_color: strokeColor,
      rotation_deg: rotationDeg,
      source_line_count: sourceLineCount
    });
  }

  function seamBubbleRequiresCleanedImage(bubble) {
    const bgType = String(bubble && (bubble.bg_type || bubble.visual && (bubble.visual.bgType || bubble.visual.bg_type)) || "none")
      .trim()
      .toLowerCase();
    return bgType !== "solid";
  }

  function buildSeamRenderSurfaceIndex(activeStore, options = {}) {
    const byPage = new Map();
    const surfaces = [];
    const handledCanonicalIds = new Set();
    if (!activeStore) return { byPage, surfaces: Object.freeze([]), handledCanonicalIds };
    const canonicals = activeStore.getCanonicalSnapshot();
    const observationsById = new Map(activeStore.getObservations().map((item) => [String(item.id || ""), item]));
    const isAvailable = typeof options.isPageAvailable === "function" ? options.isPageAvailable : null;

    for (const state of activeStore.getSeamStates()) {
      if (!state || state.status !== "completed") continue;
      const pageIds = (Array.isArray(state.pageIds) ? state.pageIds : []).map(String);
      if (pageIds.length !== 2 || new Set(pageIds).size !== 2) continue;
      const currentRecords = pageIds.map((pageId) => activeStore.getPageHandle(pageId));
      if (currentRecords.some((record, index) => !record ||
        String(record.imageRevision || "") !== String(state.imageRevisionByPage && state.imageRevisionByPage[pageIds[index]] || ""))) {
        continue;
      }
      if (currentRecords.some((record) => {
        const terminal = activeStore.getPageTerminal(record.pageId);
        return !terminal || terminal.state !== "ready" || (
          terminal.details && terminal.details.imageRevision &&
          String(terminal.details.imageRevision) !== String(record.imageRevision || "")
        );
      })) continue;
      if (isAvailable && pageIds.some((pageId) => !isAvailable(pageId))) continue;

      const canvasWidth = Number(state.canvasWidth || state.payloadGeometry && state.payloadGeometry.canvasWidth) || 0;
      const canvasHeight = Number(state.canvasHeight || state.payloadGeometry && state.payloadGeometry.canvasHeight) || 0;
      const segments = Array.isArray(state.segments) ? state.segments : [];
      if (!(canvasWidth > 0 && canvasHeight > 0) ||
        pageIds.some((pageId) => !segments.some((segment) =>
          String(segment && segment.pageId || "") === pageId && isValidSeamSurfaceSegment(segment)
        ))) {
        continue;
      }

      const stateObservationIds = new Set((Array.isArray(state.observationIds) ? state.observationIds : []).map(String));
      const stateObservationsById = new Map((Array.isArray(state.observations) ? state.observations : [])
        .map((item) => [String(item && item.id || ""), item]));
      const candidates = [];
      for (const canonical of canonicals) {
        if (!canonical || handledCanonicalIds.has(String(canonical.id || ""))) continue;
        const canonicalPageIds = Object.entries(canonical.geometryByPage || {})
          .filter(([, geometries]) => Array.isArray(geometries) ? geometries.length > 0 : !!geometries)
          .map(([pageId]) => String(pageId))
          .sort();
        if (
          canonicalPageIds.length !== pageIds.length ||
          pageIds.some((pageId) => !canonicalPageIds.includes(pageId))
        ) continue;
        const linked = (Array.isArray(canonical.memberObservationIds) ? canonical.memberObservationIds : [])
          .filter((id) => stateObservationIds.has(String(id)))
          .map((id) => stateObservationsById.get(String(id)) || observationsById.get(String(id)))
          .filter((observation) => observationHasTrueSeamContribution(observation, pageIds));
        if (!linked.length || !seamObservationsCoverPair(linked, pageIds)) continue;
        const translation = activeStore.getTranslation(canonical.id, canonical.revision);
        const bubble = buildSeamSurfaceBubble(canonical, translation, linked, canvasWidth, canvasHeight);
        if (!bubble) continue;
        candidates.push({ canonical, translation, bubble });
      }
      const hasDebug = hasRenderableSeamDebug(state.debug);
      if (!candidates.length && !hasDebug) continue;

      const cleanedImage = isDataUrlValue(state.cleanedImage) ? state.cleanedImage : null;
      const renderable = candidates.filter((candidate) =>
        !seamBubbleRequiresCleanedImage(candidate.bubble) || !!cleanedImage
      );
      if (!renderable.length && !hasDebug) continue;
      renderable.sort((left, right) => left.bubble.y - right.bubble.y
        || left.bubble.x - right.bubble.x
        || String(left.canonical.id).localeCompare(String(right.canonical.id)));
      const bubbles = Object.freeze(renderable.map((candidate) => candidate.bubble));
      const handledIds = Object.freeze(renderable.map((candidate) => String(candidate.canonical.id)).sort());
      const cleanedImageToken = String(state.cleanedImageToken || (
        cleanedImage ? `derived-${hashFnv1a(cleanedImage)}` : ""
      ));
      const canonicalRevisionById = Object.fromEntries(renderable.map((candidate) => [
        String(candidate.canonical.id),
        Math.max(1, Number(candidate.canonical.revision) || 1)
      ]));
      const translationFingerprintByCanonicalId = Object.fromEntries(renderable.map((candidate) => [
        String(candidate.canonical.id),
        String(
          candidate.translation && (
            candidate.translation.translationFingerprint ||
            candidate.translation.translation_fingerprint
          ) || hashFnv1a(candidate.bubble.translated_text)
        )
      ]));
      const layoutFingerprint = JSON.stringify({
        pairKey: state.pairKey,
        canvasWidth,
        canvasHeight,
        bubbles: renderable.map((candidate) => ({
          id: candidate.canonical.id,
          revision: candidate.canonical.revision,
          translationFingerprint: String(
            candidate.translation && (candidate.translation.translationFingerprint || candidate.translation.translation_fingerprint) ||
            hashFnv1a(candidate.bubble.translated_text)
          ),
          box: [candidate.bubble.x, candidate.bubble.y, candidate.bubble.w, candidate.bubble.h]
        }))
      });
      const layoutKey = `seam-layout-v1:${hashFnv1a(layoutFingerprint)}`;
      const renderKey = `seam-render-v1:${hashFnv1a(JSON.stringify({
        pairKey: state.pairKey,
        imageRevisionByPage: pageIds.map((pageId) => [pageId, state.imageRevisionByPage[pageId]]),
        layoutKey,
        cleanedImageToken,
        handledIds
      }))}`;
      const surface = freezeCanonicalValue({
        renderKey,
        layoutKey,
        pairKey: String(state.pairKey || ""),
        coordinateSpace: "kakao-seam-v1",
        canvasWidth,
        canvasHeight,
        pageIds,
        imageRevisionByPage: state.imageRevisionByPage || {},
        canonicalRevisionById,
        translationFingerprintByCanonicalId,
        artifactFingerprint: cleanedImageToken,
        segments,
        cleanedImage: renderable.length > 0 ? cleanedImage : null,
        cleanedImageToken,
        bubbles,
        debug: state.debug || null,
        handledCanonicalIds: handledIds
      });
      surfaces.push(surface);
      for (const canonicalId of handledIds) handledCanonicalIds.add(canonicalId);
      for (const pageId of pageIds) {
        if (!byPage.has(pageId)) byPage.set(pageId, []);
        byPage.get(pageId).push(surface);
      }
    }
    for (const [pageId, pageSurfaces] of byPage) {
      byPage.set(pageId, Object.freeze([...pageSurfaces].sort((left, right) => left.pairKey.localeCompare(right.pairKey))));
    }
    return {
      byPage,
      surfaces: Object.freeze([...surfaces]),
      handledCanonicalIds
    };
  }

  function buildFallbackObservationId(value) {
    const stable = JSON.stringify({
      providerBlockId: value.providerBlockId,
      sourceType: value.sourceType,
      pageIds: [...value.pageIds].sort(),
      imageRevisionByPage: Object.fromEntries(Object.entries(value.imageRevisionByPage).sort(([a], [b]) => a.localeCompare(b))),
      originalText: String(value.originalText || "").normalize("NFKC"),
      pageSpans: value.pageSpans
    });
    return `obs:${hashFnv1a(stable)}`;
  }

  function dedupeObservationsById(items) {
    return [...new Map((Array.isArray(items) ? items : [])
      .filter((item) => item && item.id)
      .map((item) => [item.id, item])).values()].sort(compareStableIds);
  }

  function observationMatchesPageRevisions(observation, records) {
    const current = new Map((Array.isArray(records) ? records : []).map((record) => [record.pageId, record.imageRevision]));
    for (const pageId of observation && observation.pageIds || []) {
      if (!current.has(pageId)) continue;
      if (String(observation.imageRevisionByPage && observation.imageRevisionByPage[pageId] || "") !== String(current.get(pageId) || "")) {
        return false;
      }
    }
    return true;
  }

  function calculateCanonicalSeamHeight(widthA, widthB) {
    const reconciler = getCanonicalReconciler();
    if (reconciler && typeof reconciler.calculateSeamBandHeight === "function") {
      return reconciler.calculateSeamBandHeight(widthA, widthB);
    }
    const width = Math.max(1, Math.min(Number(widthA) || 1, Number(widthB) || 1));
    return clamp(Math.round(width * KAKAO_SEAM_HEIGHT_WIDTH_RATIO), KAKAO_SEAM_HEIGHT_MIN_PX, KAKAO_SEAM_HEIGHT_MAX_PX);
  }

  function buildCanonicalPairKey(pageA, pageB) {
    const reconciler = getCanonicalReconciler();
    if (reconciler && typeof reconciler.buildSeamPairKey === "function") {
      return reconciler.buildSeamPairKey(canonicalPageDescriptor(pageA), canonicalPageDescriptor(pageB));
    }
    return `${pageA.pageId}>${pageB.pageId}@${pageA.imageRevision}>${pageB.imageRevision}`;
  }

  function isCanonicalShortPage(record) {
    if (record && typeof record.shortPage === "boolean") return record.shortPage;
    const width = Math.max(1, Number(record && record.width) || 1);
    const height = Math.max(1, Number(record && record.height) || 1);
    return height <= Math.max(KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT, width * KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO);
  }

  function normalizeAdjacentTargets(value) {
    const output = [];
    if (value && value.previous) output.push(Object.freeze({ side: "previous", target: value.previous }));
    if (value && value.next) output.push(Object.freeze({ side: "next", target: value.next }));
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item) continue;
        if (item.target) output.push(Object.freeze({ side: item.side === "previous" ? "previous" : "next", target: item.target }));
        else output.push(Object.freeze({ side: "next", target: item }));
      }
    }
    return output;
  }

  function mergeAdjacentTargetRelation(existing, addition) {
    const output = [];
    for (const relation of [...(Array.isArray(existing) ? existing : []), addition]) {
      if (!relation || !relation.target) continue;
      const side = relation.side === "previous" ? "previous" : "next";
      if (output.some((item) => item.side === side && item.target === relation.target)) continue;
      output.push(Object.freeze({ side, target: relation.target }));
    }
    return output;
  }

  function collectPageEdgeSides(record, observations, filteredObservations, edgeSignals) {
    const sides = new Set();
    for (const observation of [...observations, ...filteredObservations]) {
      for (const side of getObservationEdgeSides(observation, record)) sides.add(side);
    }
    const signal = edgeSignals || {};
    if (isCanonicalEdgeSignalDetected(signal.top) || signal.intersectsTop === true || signal.hasTop === true || signal.topCount > 0) sides.add("top");
    if (isCanonicalEdgeSignalDetected(signal.bottom) || signal.intersectsBottom === true || signal.hasBottom === true || signal.bottomCount > 0) sides.add("bottom");
    if (Array.isArray(signal.sides)) for (const side of signal.sides) if (side === "top" || side === "bottom") sides.add(side);
    return [...sides].sort();
  }

  function isCanonicalEdgeSignalDetected(value) {
    if (value === true) return true;
    if (!value || typeof value !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(value, "detected")) return value.detected === true;
    if (Object.prototype.hasOwnProperty.call(value, "visualDetected")) return value.visualDetected === true;
    if (Object.prototype.hasOwnProperty.call(value, "visual_detected")) return value.visual_detected === true;
    return [
      value.retainedObservationIds,
      value.filteredObservationIds,
      value.ids,
      value.regionIds,
      value.polygons
    ].some((items) => Array.isArray(items) && items.length > 0);
  }

  function getObservationEdgeSides(observation, record) {
    const sides = new Set();
    const band = Math.min(Number(record.height) || 1, calculateCanonicalSeamHeight(record.width, record.width));
    for (const span of observation && observation.pageSpans || []) {
      if (String(span && span.pageId || "") !== String(record.pageId)) continue;
      const box = normalizeSpanBoxPixels(span.box, record);
      if (box && box.top < band && box.top + box.height > 0) sides.add("top");
      if (box && box.top < record.height && box.top + box.height > record.height - band) sides.add("bottom");
      if (!box && Array.isArray(span.polygon) && span.polygon.length) {
        const points = span.polygon.map((point) => Array.isArray(point) ? point : [point.x, point.y]);
        const ys = points.map((point) => Number(point[1])).filter(Number.isFinite);
        if (ys.length) {
          const percent = Math.max(...ys.map(Math.abs)) <= 100;
          const minY = Math.min(...ys) * (percent ? record.height / 100 : 1);
          const maxY = Math.max(...ys) * (percent ? record.height / 100 : 1);
          if (minY < band) sides.add("top");
          if (maxY > record.height - band) sides.add("bottom");
        }
      }
    }
    return [...sides].sort();
  }

  function normalizeSpanBoxPixels(box, record) {
    if (!box || typeof box !== "object") return null;
    const left = Number(box.left ?? box.x);
    const top = Number(box.top ?? box.y);
    const width = Number(box.width ?? box.w);
    const height = Number(box.height ?? box.h);
    if (![left, top, width, height].every(Number.isFinite)) return null;
    const coordinateModel = String(box.coordinateModel || box.coordinate_model || "").toLowerCase();
    const isPercent = coordinateModel.includes("percent") || (
      Math.max(Math.abs(left), Math.abs(top), Math.abs(width), Math.abs(height)) <= 100 &&
      (Number(record.width) > 100 || Number(record.height) > 100)
    );
    return {
      left: left * (isPercent ? Number(record.width) / 100 : 1),
      top: top * (isPercent ? Number(record.height) / 100 : 1),
      width: width * (isPercent ? Number(record.width) / 100 : 1),
      height: height * (isPercent ? Number(record.height) / 100 : 1)
    };
  }

  function reconcileCanonicalEvidence(store) {
    const pages = store.getPageHandles().map(canonicalPageDescriptor);
    const adjacentPagePairs = buildConfirmedAdjacentPagePairs(store.getPageHandles());
    const observations = store.getObservations().filter((item) => !store.getFilteredObservations().some((filtered) => filtered.id === item.id));
    const filteredObservations = store.getFilteredObservations();
    const previousCanonicals = store.getCanonicalSnapshot();
    const reconciler = getCanonicalReconciler();
    if (reconciler && typeof reconciler.reconcileObservations === "function") {
      const result = reconciler.reconcileObservations({
        pages,
        observations,
        filteredObservations,
        previousCanonicals,
        adjacentPagePairs
      });
      return normalizeReconciliationResult(result, observations, filteredObservations, previousCanonicals);
    }
    return fallbackReconcileObservations({ pages, observations, filteredObservations, previousCanonicals });
  }

  function buildConfirmedAdjacentPagePairs(records) {
    const pageById = new Map((Array.isArray(records) ? records : []).map((record) => [record.pageId, record]));
    const pairs = new Map();
    for (const record of pageById.values()) {
      const candidates = new Set([
        String(record.previousPageId || ""),
        String(record.nextPageId || ""),
        ...(Array.isArray(record.adjacentPageIds) ? record.adjacentPageIds.map(String) : [])
      ]);
      for (const adjacentPageId of candidates) {
        const adjacent = pageById.get(adjacentPageId);
        if (!adjacent || adjacent.pageId === record.pageId) continue;
        const ordered = [record, adjacent].sort(comparePageRecords);
        const key = `${ordered[0].pageId}|${ordered[1].pageId}`;
        pairs.set(key, Object.freeze({
          pageIds: Object.freeze(ordered.map((page) => page.pageId)),
          pageAId: ordered[0].pageId,
          pageBId: ordered[1].pageId,
          imageRevisionByPage: Object.freeze(revisionsForPages(ordered))
        }));
      }
    }
    return [...pairs.values()].sort((left, right) => left.pageIds.join("|").localeCompare(right.pageIds.join("|")));
  }

  function normalizeReconciliationResult(result, observations, filteredObservations, previousCanonicals) {
    if (!result || !Array.isArray(result.canonicals)) {
      return fallbackReconcileObservations({ observations, filteredObservations, previousCanonicals });
    }
    return {
      ...result,
      canonicals: result.canonicals.map(freezeCanonical).sort(compareCanonicalRecords),
      ledger: result.ledger || result.coverageLedger || {},
      diagnostics: result.diagnostics || []
    };
  }

  function fallbackReconcileObservations({ observations = [], filteredObservations = [], previousCanonicals = [] }) {
    const previousById = new Map(previousCanonicals.map((canonical) => [canonical.id, canonical]));
    const canonicals = [];
    const ledger = {};
    for (const observation of [...observations].sort(compareStableIds)) {
      const id = `canonical:${observation.id}`;
      const geometryByPage = {};
      for (const span of observation.pageSpans || []) {
        if (!geometryByPage[span.pageId]) geometryByPage[span.pageId] = [];
        geometryByPage[span.pageId].push(span.box || { polygon: span.polygon });
      }
      const previous = previousById.get(id);
      const stableValue = JSON.stringify({ memberObservationIds: [observation.id], originalText: observation.originalText, geometryByPage });
      const previousValue = previous && JSON.stringify({
        memberObservationIds: previous.memberObservationIds,
        originalText: previous.originalText,
        geometryByPage: previous.geometryByPage
      });
      canonicals.push(freezeCanonical({
        id,
        revision: previous ? (stableValue === previousValue ? previous.revision : Number(previous.revision) + 1) : 1,
        supersedesId: null,
        memberObservationIds: [observation.id],
        originalText: observation.originalText,
        geometryByPage,
        status: "ready",
        translationFingerprint: ""
      }));
      ledger[observation.id] = { observationId: observation.id, resolution: "standalone", canonicalId: id };
    }
    for (const observation of filteredObservations) {
      ledger[observation.id] = {
        observationId: observation.id,
        resolution: "filtered",
        filterReason: observation.filterReason || "provider_filtered"
      };
    }
    return { canonicals: canonicals.sort(compareCanonicalRecords), ledger, diagnostics: [] };
  }

  function assertCoverageInvariant(store) {
    const ledger = store.getCoverageLedger();
    const observations = store.getObservations();
    const activeMembership = new Map();
    for (const canonical of store.getCanonicalSnapshot()) {
      for (const observationId of canonical.memberObservationIds) {
        if (activeMembership.has(observationId)) {
          throw new Error(`Canonical invariant violated: observation ${observationId} belongs to multiple canonicals`);
        }
        activeMembership.set(observationId, canonical.id);
      }
    }
    for (const observation of observations) {
      const resolution = ledger.get(observation.id);
      if (!resolution || !["standalone", "consumed", "filtered"].includes(String(resolution.resolution || resolution.status))) {
        throw new Error(`Canonical invariant violated: unresolved observation ${observation.id}`);
      }
    }
  }

  function fallbackBuildRenderProjections({ pages, canonicals, availablePageIds }) {
    const pageById = new Map(pages.map((page) => [page.pageId, page]));
    const available = new Set(availablePageIds || []);
    const projections = [];
    for (const canonical of canonicals) {
      const translation = canonical.translation || null;
      if (!translation || !String(translation.translated_text || "").trim()) continue;
      const geometries = Object.entries(canonical.geometryByPage || {}).map(([pageId, geometry]) => ({
        pageId,
        geometry,
        area: geometryArea(geometry),
        page: pageById.get(pageId) || { pageId }
      })).sort((left, right) => right.area - left.area || comparePageRecords(left.page, right.page));
      if (geometries.length === 0) continue;
      const desiredPrimary = geometries[0].pageId;
      const activePrimary = available.has(desiredPrimary)
        ? desiredPrimary
        : (geometries.find((item) => available.has(item.pageId)) || geometries[0]).pageId;
      for (const item of geometries) {
        const role = item.pageId === activePrimary ? "primary" : "standby";
        projections.push({
          canonicalId: canonical.id,
          revision: canonical.revision,
          pageId: item.pageId,
          role,
          activeText: role === "primary",
          geometry: item.geometry,
          original_text: canonical.originalText,
          translated_text: translation.translated_text,
          translation
        });
      }
    }
    return projections.sort((left, right) => String(left.pageId).localeCompare(String(right.pageId)) || compareProjectionRecords(left, right));
  }

  function geometryArea(geometry) {
    const items = Array.isArray(geometry) ? geometry : [geometry];
    return items.reduce((total, item) => {
      if (!item) return total;
      const width = Math.max(0, Number(item.width ?? item.w) || 0);
      const height = Math.max(0, Number(item.height ?? item.h) || 0);
      return total + width * height;
    }, 0);
  }

  function projectionToBubble(projection) {
    if (projection && projection.bubble) {
      return { ...projection.bubble, original_text: projection.original_text, translated_text: projection.translated_text };
    }
    const geometry = Array.isArray(projection.geometry) ? projection.geometry[0] : projection.geometry || {};
    return {
      id: projection.canonicalId,
      revision: projection.revision,
      x: Number(geometry.x ?? geometry.left) || 0,
      y: Number(geometry.y ?? geometry.top) || 0,
      w: Number(geometry.w ?? geometry.width) || 0,
      h: Number(geometry.h ?? geometry.height) || 0,
      original_text: projection.original_text,
      translated_text: projection.translated_text,
      canonical_id: projection.canonicalId,
      canonical_revision: projection.revision
    };
  }

  function buildStandbyCoverProjections(projection) {
    if (!projection || projection.role !== "standby") return [];
    return [Object.freeze({
      ...projection,
      id: `${String(projection.id || projection.canonicalId || "projection")}:cover`,
      projectionId: `${String(projection.projectionId || projection.id || projection.canonicalId || "projection")}:cover`,
      role: "cover",
      active: true,
      activeText: false,
      coverOnly: true,
      translated_text: "",
      translatedText: "",
      bubble: projection.bubble ? Object.freeze({
        ...projection.bubble,
        translated_text: "",
        projection_role: "cover_only",
        cover_only: true
      }) : projection.bubble
    })];
  }

  function projectionsRequireCleanedImage(projections) {
    return (Array.isArray(projections) ? projections : []).some(projectionRequiresCleanedImage);
  }

  function projectionRequiresCleanedImage(projection) {
    if (!projection || projection.active === false) return false;
    const role = String(projection.role || "");
    const cover = role === "cover" || role === "cover_only" || projection.coverOnly === true;
    if (!cover && projection.activeText !== true) return false;
    const bgType = String(
      projection.visual && (projection.visual.bgType || projection.visual.bg_type) ||
      projection.bubble && (projection.bubble.bg_type || projection.bubble.bgType) ||
      projection.bgType || projection.bg_type || ""
    ).trim().toLowerCase();
    return bgType === "none";
  }

  function quantizeCleanMaskNumber(value) {
    return Math.round(clamp(Number(value) || 0, 0, 100) * 100) / 100;
  }

  function normalizeCanonicalCleanMaskGeometry(geometry) {
    const inputs = Array.isArray(geometry) ? geometry : [geometry];
    const bounds = [];
    for (const input of inputs) {
      if (!input || typeof input !== "object") continue;
      const box = input.box || input.geometry || input;
      const x = Number(box && (box.x ?? box.left));
      const y = Number(box && (box.y ?? box.top));
      const w = Number(box && (box.w ?? box.width));
      const h = Number(box && (box.h ?? box.height));
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
        bounds.push({ left: x, top: y, right: x + w, bottom: y + h });
        continue;
      }
      const points = (Array.isArray(input.polygon) ? input.polygon : [])
        .map((point) => ({
          x: Number(Array.isArray(point) ? point[0] : point && point.x),
          y: Number(Array.isArray(point) ? point[1] : point && point.y)
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length >= 3) {
        bounds.push({
          left: Math.min(...points.map((point) => point.x)),
          top: Math.min(...points.map((point) => point.y)),
          right: Math.max(...points.map((point) => point.x)),
          bottom: Math.max(...points.map((point) => point.y))
        });
      }
    }
    if (!bounds.length) return null;
    const left = quantizeCleanMaskNumber(Math.min(...bounds.map((box) => box.left)));
    const top = quantizeCleanMaskNumber(Math.min(...bounds.map((box) => box.top)));
    const right = quantizeCleanMaskNumber(Math.max(...bounds.map((box) => box.right)));
    const bottom = quantizeCleanMaskNumber(Math.max(...bounds.map((box) => box.bottom)));
    if (right <= left || bottom <= top) return null;
    return {
      coordinateSpace: "percent",
      box: {
        x: left,
        y: top,
        w: quantizeCleanMaskNumber(right - left),
        h: quantizeCleanMaskNumber(bottom - top)
      }
    };
  }

  function buildCanonicalCleanMasks(projections, crossPageCanonicalIds = new Set()) {
    const crossPageIds = crossPageCanonicalIds instanceof Set
      ? crossPageCanonicalIds
      : new Set(Array.from(crossPageCanonicalIds || [], String));
    const byKey = new Map();
    for (const projection of Array.isArray(projections) ? projections : []) {
      const canonicalId = String(projection && projection.canonicalId || "");
      if (!canonicalId || !crossPageIds.has(canonicalId) || !projectionRequiresCleanedImage(projection)) continue;
      // 跨页漏字往往恰好落在单页 OCR 多边形之外；清理范围必须采用渲染蓝框
      // 对应的 canonical union，而不能退回某一行文字或某个 seam 字框。
      const mask = normalizeCanonicalCleanMaskGeometry(projection.geometry || projection.box);
      if (mask) byKey.set(JSON.stringify(mask), mask);
    }
    return [...byKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, mask]) => mask);
  }

  function buildCleanedMaskFingerprint(masks) {
    const text = JSON.stringify(Array.isArray(masks) ? masks : []);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function buildCleanedArtifactKey(imageRevision, masks) {
    return `${String(imageRevision || "")}:canonical-mask-v1:${buildCleanedMaskFingerprint(masks)}`;
  }

  function collectCrossPageCanonicalIds(projectionsByPage, canonicals = []) {
    const pageIdsByCanonical = new Map();
    for (const [fallbackPageId, projections] of projectionsByPage instanceof Map ? projectionsByPage.entries() : []) {
      for (const projection of Array.isArray(projections) ? projections : []) {
        const canonicalId = String(projection && projection.canonicalId || "");
        const pageId = String(projection && projection.pageId || fallbackPageId || "");
        if (!canonicalId || !pageId) continue;
        if (!pageIdsByCanonical.has(canonicalId)) pageIdsByCanonical.set(canonicalId, new Set());
        pageIdsByCanonical.get(canonicalId).add(pageId);
      }
    }
    const result = new Set([...pageIdsByCanonical.entries()]
      .filter(([, pageIds]) => pageIds.size > 1)
      .map(([canonicalId]) => canonicalId));
    for (const canonical of Array.isArray(canonicals) ? canonicals : []) {
      if (canonical && Object.keys(canonical.geometryByPage || {}).length > 1) {
        result.add(String(canonical.id || ""));
      }
    }
    result.delete("");
    return result;
  }

  function isDataUrlValue(value) {
    return /^data:[^,]+,/i.test(String(value || ""));
  }

  function appendProvisionalProjectionFallbacks({
    grouped,
    previousProjections,
    currentCanonicals,
    activeStore,
    isPageAvailable
  }) {
    const previous = [...(previousProjections instanceof Map ? previousProjections.values() : [])].flat();
    const claimedPreviousCanonicalIds = new Set();
    for (const canonical of [...(currentCanonicals || [])].sort(compareCanonicalRecords)) {
      if (activeStore.getTranslation(canonical.id, canonical.revision)) continue;
      const lineageIds = [canonical.id, canonical.supersedesId].filter(Boolean).map(String);
      const previousId = lineageIds.find((id) =>
        !claimedPreviousCanonicalIds.has(id) && previous.some((projection) => String(projection.canonicalId || "") === id)
      );
      if (!previousId) continue;
      const candidates = previous.filter((projection) => String(projection.canonicalId || "") === previousId);
      const translationText = String(
        candidates.find((projection) => String(projection.translated_text || projection.translatedText || "").trim())?.translated_text ||
        candidates.find((projection) => String(projection.translatedText || "").trim())?.translatedText ||
        ""
      );
      if (!translationText) continue;
      claimedPreviousCanonicalIds.add(previousId);

      const textCandidates = candidates.filter((projection) => projection.role !== "cover" && projection.coverOnly !== true);
      const preferredPageId = String(
        textCandidates[0] && textCandidates[0].preferredPrimaryPageId ||
        textCandidates.find((projection) => projection.activeText)?.pageId ||
        ""
      );
      const activePageId = preferredPageId && isPageAvailable(preferredPageId)
        ? preferredPageId
        : String(textCandidates.find((projection) => isPageAvailable(projection.pageId))?.pageId || "");

      for (const projection of candidates) {
        const isCover = projection.role === "cover" || projection.coverOnly === true;
        const activeText = !isCover && !!activePageId && String(projection.pageId) === activePageId;
        const clone = Object.freeze({
          ...projection,
          provisional: true,
          pendingCanonicalId: canonical.id,
          pendingCanonicalRevision: canonical.revision,
          active: isCover ? projection.active !== false : activeText,
          activeText,
          translated_text: activeText ? translationText : "",
          translatedText: activeText ? translationText : "",
          bubble: projection.bubble ? Object.freeze({
            ...projection.bubble,
            translated_text: activeText ? translationText : "",
            projection_active: isCover ? projection.active !== false : activeText
          }) : projection.bubble
        });
        if (!grouped.has(clone.pageId)) grouped.set(clone.pageId, []);
        grouped.get(clone.pageId).push(clone);
      }
    }
    for (const items of grouped.values()) items.sort(compareProjectionRecords);
  }

  /* =================================================================
   * 内部工具函数（独立于 adapters）
   * ================================================================= */

  function normalizeResult(result) {
    if (!result || typeof result !== "object") return { bubbles: [] };
    if (!Array.isArray(result.bubbles)) return { ...result, bubbles: [] };
    return result;
  }

  function buildOcrRequestKey(targetKey, payload) {
    const mode = String(payload && payload.ocrMode || "single");
    const sourceToken = String(payload && payload.sourceToken || "");
    const reason = String(payload && (payload.fallbackReason || payload.stitchRejectionReason) || "");
    const stitchKey = String(payload && payload.stitchKey || "");
    return [
      String(targetKey || ""),
      `src:${hashFnv1a(sourceToken)}`,
      `mode:${mode}`,
      reason ? `reason:${hashFnv1a(reason)}` : "",
      stitchKey ? `stitch:${hashFnv1a(stitchKey)}` : ""
    ].filter(Boolean).join("|");
  }

  function hashFnv1a(text) {
    const t = String(text || "");
    let hash = 2166136261;
    for (let i = 0; i < t.length; i += 1) {
      hash ^= t.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function buildSingleFallbackPayload(singlePayload, stitchedPayload, fallbackReason) {
    const reason = String(fallbackReason || "stitched result rejected").trim();
    return {
      ...singlePayload,
      ocrMode: "single-fallback",
      sourceToken: String(stitchedPayload && stitchedPayload.sourceToken ||
        singlePayload && singlePayload.sourceToken || ""),
      fallbackReason: reason,
      stitchAdmission: "fallback"
    };
  }

  function getErrorMessage(error) {
    if (!error) return "unknown error";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    return String(error);
  }

  function isScreenshotTargetNotVisibleError(reason) {
    return reason === "Target is not visible enough for screenshot capture";
  }

  function hasAttachedShortPageBubble(result) {
    return !!(result && Array.isArray(result.bubbles) &&
      result.bubbles.some((b) => b && b.stitch_attached_short_page === true));
  }

  function extractAttachedShortPageKeys(renderPayload) {
    if (renderPayload && Array.isArray(renderPayload.attachedShortPageKeys)) {
      return renderPayload.attachedShortPageKeys.filter(Boolean);
    }
    return [];
  }

  /**
   * 跨图去重（内部使用 Store 的串行化事务）
   */
  async function dedupeKakaoResultByPageCoordinates({
    result,
    target,
    targetKey,
    scopedTargetKey = targetKey,
    store,
    adapters = {},
    scrollX = 0,
    scrollY = 0
  }) {
    if (!store || !result || !Array.isArray(result.bubbles) || !targetKey) {
      return result;
    }
    return store.runSerializedDedupe(() =>
      executeDedupe(
        target,
        targetKey,
        scopedTargetKey,
        result,
        scrollX,
        scrollY,
        store,
        adapters
      )
    );
  }

  async function executeDedupe(target, targetKey, scopedTargetKey, result, scrollX, scrollY, store, adapters = {}) {
    if (!result || !Array.isArray(result.bubbles) || !targetKey) return result;

    const targetRect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    if (!targetRect || !(targetRect.width > 0) || !(targetRect.height > 0)) return result;

    // 为所有气泡添加 global_box
    const bubblesWithBox = result.bubbles.map((bubble) => ({
      ...bubble,
      global_box: bubble.global_box || computeKakaoGlobalBox(bubble, scrollX, scrollY, targetRect)
    }));

    const trimmed = await trimBoundaryOverlap(
      bubblesWithBox,
      targetKey,
      store.getGlobalEntries(),
      adapters.translateTrimmedBubble
    );
    const deduped = runDedupeGlobalBubbles(
      trimmed,
      target,
      targetRect,
      targetKey,
      store,
      {
        scrollX,
        scrollY,
        scopedTargetKey,
        onSupersededEntry: adapters.onSupersededEntry
      }
    );

    return {
      ...result,
      bubbles: deduped,
      debug: syncOcrDebugFinalBubbles(result.debug, deduped)
    };
  }

  /**
   * 边界重叠气泡修剪
   */
  async function trimBoundaryOverlap(bubbles, targetKey, existingEntries, translateTrimmedBubble) {
    const existing = Array.isArray(existingEntries) ? existingEntries : [];

    const output = [];
    for (const bubble of bubbles) {
      let nextBubble = bubble;
      const text = normalizeOcrSimilarityText(bubble.original_text);
      const entry = existing.find((candidate) => {
        const overlap = getSubstantialOcrBoundaryOverlap(text, candidate.text);
        return overlap && areKakaoGlobalBoxesRelated(bubble.global_box, candidate.box);
      });
      if (entry) {
        const trimmed = trimKakaoBubbleBoundary(nextBubble, getSubstantialOcrBoundaryOverlap(text, entry.text));
        if (trimmed) {
          nextBubble = typeof translateTrimmedBubble === "function"
            ? await translateTrimmedBubble(trimmed, targetKey)
            : trimmed;
        }
      }
      output.push(nextBubble);
    }
    return output;
  }

  /**
   * 全局去重（传递 store 实例而非直接操作 state）
   */
  function runDedupeGlobalBubbles(bubbles, target, targetRect, targetKey, store, options = {}) {
    if (!targetRect || !targetKey) return bubbles;

    store.deleteEntriesForKey(targetKey);
    const existing = store.getGlobalEntries();
    const accepted = [];
    const entries = [];
    const sx = Number(options.scrollX || 0);
    const sy = Number(options.scrollY || 0);

    for (const bubble of bubbles) {
      const box = bubble.global_box || computeKakaoGlobalBox(bubble, sx, sy, targetRect);
      const text = normalizeOcrSimilarityText(bubble.original_text);
      const translatedText = normalizeOcrSimilarityText(bubble.translated_text);

      const duplicates = existing.concat(entries).filter((entry) =>
        isKakaoGlobalDuplicateCandidate({ box, text, translatedText, targetKey, bubble }, entry)
      );

      const rawCompleteness = Math.max(text.length, translatedText.length);
      const completeness = bubble.stitch_boundary_neighbor
        ? Math.max(1, Math.floor(rawCompleteness * 0.5))
        : rawCompleteness;

      const strongestExisting = duplicates.reduce(
        (best, entry) => !best || entry.completeness > best.completeness ? entry : best,
        null
      );
      if (strongestExisting && strongestExisting.completeness >= completeness) {
        continue;
      }

      // 移除被超越的旧条目
      for (const dup of duplicates) {
        if (typeof options.onSupersededEntry === "function") {
          options.onSupersededEntry(dup);
        } else {
          removeSupersededEntry(dup, store);
        }
      }

      accepted.push(bubble);
      entries.push({
        box,
        text,
        translatedText,
        completeness,
        target,
        targetKey,
        scopedTargetKey: options.scopedTargetKey || targetKey,
        bubble,
        bubbleContainer: accepted,
        entryContainer: entries
      });
    }

    store.setEntriesForKey(targetKey, entries);
    return accepted;
  }

  function removeSupersededEntry(entry, store) {
    if (!entry) return;
    store.removeEntryFromKey(entry.targetKey, entry);

    // 从 bubbleContainer 和 entryContainer 中移除
    if (Array.isArray(entry.bubbleContainer)) {
      const idx = entry.bubbleContainer.indexOf(entry.bubble);
      if (idx >= 0) entry.bubbleContainer.splice(idx, 1);
    }
    if (Array.isArray(entry.entryContainer)) {
      const idx = entry.entryContainer.indexOf(entry);
      if (idx >= 0) entry.entryContainer.splice(idx, 1);
    }
    // 注意：localResultCache 更新和 overlay 重新渲染由 content.js
    // 在收到 SupersededEntry 事件后处理，不在 pipeline 层处理。
  }

  /**
   * 释放未被 stitch 覆盖的短页
   */
  function releaseUncoveredShortPages(payload, result, owner, store, adapters) {
    if (!payload || hasAttachedShortPageBubble(result)) return 0;

    const attachedKeys = extractAttachedShortPageKeys(payload);
    if (attachedKeys.length === 0) return 0;

    const ownerKey = adapters.computeTargetKey(owner);
    const ownerScopedKey = adapters.buildTargetSourceCacheKey(
      ownerKey, adapters.getQuickSourceToken(owner)
    );
    let released = 0;

    for (const shortKey of attachedKeys) {
      const el = adapters.findTargetByScopedKey(shortKey);
      if (!el) continue;

      store.releaseShortPage(el, ownerScopedKey);
      delete el.dataset.mtNoTextKey;
      delete el.dataset.mtLastTranslatedKey;
      adapters.tracePipeline("short-detached", el, { reason: "ownerSucceededWithoutBubble", ownerScopedKey });
      released += 1;
      adapters.queuePageAutoTranslate(el);
    }
    return released;
  }

  function rememberLocalResult(adapters, scopedKey, result) {
    if (!adapters.state || !adapters.state.localResultCache) return;
    adapters.state.localResultCache.set(scopedKey, result);
  }

  /* =================================================================
   * 导出
   * ================================================================= */
  globalThis.MangaTranslatorKakaoPipeline = Object.freeze({
    // 常量（只读引用）
    KAKAO_STITCH_MAX_CONTEXT_PX,
    KAKAO_STITCH_MIN_CONTEXT_PX,
    KAKAO_STITCH_CONTEXT_CSS_PX,
    KAKAO_STITCH_CONTEXT_HEIGHT_RATIO,
    KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX,
    KAKAO_STITCH_MIN_WIDTH_RATIO,
    KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT,
    KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO,
    KAKAO_OVERLAP_SAMPLE_WIDTH,
    KAKAO_OVERLAP_MIN_RATIO,
    KAKAO_OVERLAP_MAX_RATIO,
    KAKAO_OVERLAP_MAX_MAE,
    KAKAO_OVERLAP_MIN_UNIQUE_PX,
    KAKAO_OVERLAP_MIN_UNIQUE_RATIO,
    KAKAO_THIN_STRIP_MIN_HEIGHT,
    KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS,
    KAKAO_EDGE_WAIT_TIMEOUT_MS,

    // FSM
    PagePhase,
    CanonicalPhase,
    canTransition,
    isActivePhase,
    isRetryablePhase,

    // Store
    createStore,
    createRetryScheduler,
    getShortPageAttachmentGate,
    attachShortPageIfAllowed,
    releaseShortPagesForOwner,

    // Pipeline
    createPipeline,
    createCanonicalPipeline,

    // Canonical helpers
    calculateCanonicalSeamHeight,
    buildCanonicalPairKey,
    normalizeOcrEvidence,
    collectPageEdgeSides,
    getObservationEdgeSides,
    fallbackReconcileObservations,
    fallbackBuildRenderProjections,
    buildConfirmedAdjacentPagePairs,
    buildStandbyCoverProjections,
    projectionsRequireCleanedImage,
    buildCanonicalCleanMasks,
    buildCleanedArtifactKey,
    assertCoverageInvariant,

    // 纯函数
    normalizeOcrSimilarityText,
    getBubbleLineCount,
    textSimilarity,
    areOcrTextsDuplicateOrContained,
    hasSubstantialOcrTokenOverlap,
    getLongestCommonSubstringLength,
    getSubstantialOcrBoundaryOverlap,
    sliceTextByNormalizedBoundary,
    normalizeRectLike,
    clamp,
    pageBoxIntersectionRatio,
    areKakaoGlobalBoxesRelated,
    isKakaoPageEdgeSource,
    isVerifiedKakaoStitchNeighbor,
    buildKakaoStitchWindowPlan,
    isAttachableKakaoShortPage,
    isKakaoPageEdgeFragment,
    shouldRejectKakaoPageEdgeStitch,
    isKakaoStitchCandidatePastNeighborWindow,
    findKakaoStitchNeighborTarget,
    findKakaoShortPageAttachmentOwnerTarget,
    findKakaoShortPageAttachmentOwner,
    computeGraySample,
    findKakaoVerticalOverlap,
    hasUsableKakaoStripCaptureRect,
    hasUsefulKakaoOverlapCrop,
    buildKakaoStitchedPayload,
    isKakaoStripPayload,
    maybeCropKakaoOverlappedPayload,
    normalizeKakaoStitchSegments,
    getKakaoStitchBestOverlap,
    getKakaoStitchOwnerOverlap,
    mapKakaoStitchedFillBox,
    mapKakaoStitchedPolygon,
    computeKakaoGlobalBox,
    mapKakaoStitchedResult,
    mapKakaoAdjacentBoundaryRect,
    mapKakaoOwnerDebugRect,
    getDebugItemPercent,
    normalizeKakaoStitchDebugCoordinates,
    normalizeDebugCoordinateItems,
    shouldFallbackFromKakaoStitch,
    filterOcrDebugFinalBubbles,
    syncOcrDebugFinalBubbles,
    trimKakaoBubbleBoundary,
    dedupeKakaoResultByPageCoordinates,
    runDedupeGlobalBubbles,
    isKakaoBoundaryNeighborBubble,
    isKakaoBoundaryOwnPair,
    selectKakaoVisualDuplicateLoser,
    isKakaoGlobalDuplicateCandidate,
    hasAttachedShortPageBubble,
    buildSingleFallbackPayload,
    buildOcrRequestKey,
    buildKakaoStitchCandidateEntries
  });

})();
