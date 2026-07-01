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
  const KAKAO_OVERLAP_MIN_UNIQUE_PX = 96;
  const KAKAO_THIN_STRIP_MAX_NATURAL_HEIGHT = 100;
  const KAKAO_THIN_STRIP_MIN_HEIGHT = 8;
  const KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS = 8000;
  const KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION = 0.72;
  const KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO = 0.35;

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

  function shouldRejectKakaoPageEdgeStitch({ owner, ownerHeight, canonicalWidth, previous, next, previousHeight, nextHeight } = {}) {
    if (!owner || !isKakaoPageEdgeSource(owner.sourceKey)) {
      return "";
    }
    const width = Math.max(1, Number(canonicalWidth) || Number(owner.width) || 1);
    const height = Math.max(1, Number(ownerHeight) || 0);
    const isFragment = height < Math.max(760, width * 1.05);
    if (!isFragment) {
      return "";
    }
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
    const step = Math.max(1, Math.round(currentSample.height / 180));

    for (let rows = minRows; rows <= maxRows; rows += step) {
      const previousOffset = (previousSample.height - rows) * width;
      let total = 0;
      const count = rows * width;
      for (let offset = 0; offset < count; offset += 1) {
        total += Math.abs(previousSample.gray[previousOffset + offset] - currentSample.gray[offset]);
      }
      const mae = total / Math.max(1, count);
      if (mae < bestMae) {
        bestMae = mae;
        bestRows = rows;
      }
    }

    const uniqueRows = currentSample.height - bestRows;
    const accepted = bestMae <= KAKAO_OVERLAP_MAX_MAE &&
      bestRows >= minRows &&
      bestRows <= maxRows &&
      uniqueRows / Math.max(1, currentSample.height) >= 1 - KAKAO_OVERLAP_MAX_RATIO;
    return {
      accepted,
      rows: bestRows,
      previousRows: previousSample.height,
      currentRows: currentSample.height,
      mae: bestMae,
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
    if (cropTop <= 0 || cropHeight < KAKAO_OVERLAP_MIN_UNIQUE_PX) {
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
        fill_box: clampAdjusted ? null : mapKakaoStitchedFillBox(bubble.fill_box, ownerDraw.y, ownerDraw.h, canvasHeight),
        polygon: clampAdjusted ? null : mapKakaoStitchedPolygon(bubble.polygon, ownerDraw.y, ownerDraw.h, canvasHeight),
        region_polygon: clampAdjusted ? null : mapKakaoStitchedPolygon(bubble.region_polygon, ownerDraw.y, ownerDraw.h, canvasHeight)
      };
    }).filter(Boolean);

    return {
      ...result,
      bubbles: mapped,
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

  function isKakaoCrossPageOverflowGeometryDuplicate(candidate, entry) {
    const candidateKey = String(candidate && candidate.targetKey || "");
    const entryKey = String(entry && entry.targetKey || "");
    if (!candidateKey || !entryKey || candidateKey === entryKey) return false;

    const candidateBubble = candidate && candidate.bubble;
    const entryBubble = entry && entry.bubble;
    if (!(candidateBubble && candidateBubble.stitch_overflow === true) &&
        !(entryBubble && entryBubble.stitch_overflow === true)) {
      return false;
    }

    const candidateRegion = String(candidateBubble && candidateBubble.region_type || "").trim();
    const entryRegion = String(entryBubble && entryBubble.region_type || "").trim();
    if (!candidateRegion || candidateRegion !== entryRegion) return false;

    const candidateArea = Number(candidate.box.width) * Number(candidate.box.height);
    const entryArea = Number(entry.box.width) * Number(entry.box.height);
    if (!(candidateArea > 0) || !(entryArea > 0)) return false;

    const areaRatio = Math.min(candidateArea, entryArea) / Math.max(candidateArea, entryArea);
    return areaRatio >= KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO &&
      pageBoxIntersectionRatio(candidate.box, entry.box) >= KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION;
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

      cancelPageJob(targetKey) {
        currentJobs.delete(targetKey);
        const phase = this.getPagePhase(targetKey);
        if (canTransition(phase, PagePhase.CANCELLED)) {
          pageJobPhase.set(targetKey, PagePhase.CANCELLED);
        }
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
    KAKAO_THIN_STRIP_MIN_HEIGHT,
    KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS,

    // FSM
    PagePhase,
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
    shouldRejectKakaoPageEdgeStitch,
    isKakaoStitchCandidatePastNeighborWindow,
    findKakaoStitchNeighborTarget,
    findKakaoShortPageAttachmentOwnerTarget,
    findKakaoShortPageAttachmentOwner,
    computeGraySample,
    findKakaoVerticalOverlap,
    hasUsableKakaoStripCaptureRect,
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
    isKakaoGlobalDuplicateCandidate,
    hasAttachedShortPageBubble,
    buildSingleFallbackPayload,
    buildOcrRequestKey,
    buildKakaoStitchCandidateEntries
  });

})();
